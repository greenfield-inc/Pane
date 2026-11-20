import fs from 'fs/promises';
import path from 'path';
import type { Project } from '../database/models';
import type { AppConfig } from '../types/config';
import { PathResolver } from '../utils/pathResolver';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { paneAndTabRules } from '../../../packages/runpane/src/paneIntro';
import { LeftAlone, writeOwnedBlock, type BlockMarkers } from './instructionsBlock';
import { todosOn } from './todos/todosFeature';

export const PANE_AGENT_CONTEXT_START = '<!-- pane-agent-context:start -->';
export const PANE_AGENT_CONTEXT_END = '<!-- pane-agent-context:end -->';

const MARKERS: BlockMarkers = {
  begin: PANE_AGENT_CONTEXT_START,
  end: PANE_AGENT_CONTEXT_END,
  repair: 'turn Settings → AI & Agents → Publish Pane instructions to AGENTS.md off and on',
};

const AGENTS_FILENAMES = ['AGENTS.md', 'agents.md'] as const;
let settingQueue: Promise<void> = Promise.resolve();

export interface AgentContextWriteResult {
  changed: boolean;
  filePath?: string;
  skipped?: 'disabled' | 'unsafe-file';
  removed?: boolean;
}

export async function ensureProjectAgentContext(
  project: Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>,
  config: Pick<AppConfig, 'agentContext'>,
): Promise<AgentContextWriteResult> {
  if (config.agentContext?.managedAgentsMd !== true) {
    return { changed: false, skipped: 'disabled' };
  }

  const root = resolveProjectRoot(project);
  const filePath = await resolveAgentsFilePath(root);
  if (!filePath) {
    return { changed: false, skipped: 'unsafe-file' };
  }
  return writeLeavingAlone(filePath, renderManagedAgentContextBlock()) ?? { changed: true, filePath };
}

/**
 * Apply the repository AGENTS.md setting. Off removes Pane's marked section
 * from every known project; on publishes it to the active project. Used by the
 * settings toggle and by the startup migration that turned it off.
 */
export function applyManagedAgentsMdSetting<P extends Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>>(
  config: Pick<AppConfig, 'agentContext'>,
  projects: { all: () => P[]; active: () => P | null | undefined },
): Promise<boolean> {
  const result = settingQueue.then(() => applyManagedAgentsMdSettingNow(config, projects));
  settingQueue = result.then(() => {}, () => {});
  return result;
}

async function applyManagedAgentsMdSettingNow<P extends Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>>(
  config: Pick<AppConfig, 'agentContext'>,
  projects: { all: () => P[]; active: () => P | null | undefined },
): Promise<boolean> {
  const active = projects.active();
  const targets = config.agentContext?.managedAgentsMd === true ? (active ? [active] : []) : projects.all();
  let succeeded = true;
  for (const project of targets) {
    try {
      if (config.agentContext?.managedAgentsMd === true) {
        await ensureProjectAgentContext(project, config);
      } else {
        await removeProjectAgentContext(resolveProjectRoot(project));
      }
    } catch (error) {
      succeeded = false;
      console.warn('[AgentContext] Failed to update Pane agent context for project:', project.path, error);
    }
  }
  return succeeded;
}

function renderManagedAgentContextBlock(): string[] {
  return [
    PANE_AGENT_CONTEXT_START,
    // The Pane and Tab rules come from workspaceRules, the one place the contract states them.
    // T-39: the To-dos paragraph is written only while To-dos is on.
    ...RUNPANE_CONTRACT.agentContext.managedBlock
      .filter(line => todosOn() || !line.startsWith('To-dos:'))
      .map(line => line.replace('{{paneAndTabRules}}', paneAndTabRules())),
    PANE_AGENT_CONTEXT_END,
  ].join('\n').split('\n');
}

async function removeProjectAgentContext(root: string): Promise<AgentContextWriteResult> {
  if (!(await fs.stat(root)).isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }
  const { filePath } = await findExistingAgentsFile(root);
  if (!filePath) {
    return { changed: false, skipped: 'disabled' };
  }

  return writeLeavingAlone(filePath, undefined) ?? { changed: true, filePath, removed: true };
}

/**
 * Writes or removes Pane's section; undefined when the file changed. A file Pane must leave alone
 * (a stray marker, not UTF-8) is a settled outcome, not a failure to retry at every launch.
 */
function writeLeavingAlone(filePath: string, block: string[] | undefined): AgentContextWriteResult | undefined {
  try {
    if (writeOwnedBlock(filePath, MARKERS, block)) return undefined;
    return block ? { changed: false, filePath } : { changed: false, filePath, skipped: 'disabled' };
  } catch (error) {
    if (!(error instanceof LeftAlone)) throw error;
    console.warn(`[AgentContext] ${filePath}: ${error.message}`);
    return { changed: false, filePath, skipped: 'unsafe-file' };
  }
}

async function resolveAgentsFilePath(root: string): Promise<string | undefined> {
  const existing = await findExistingAgentsFile(root);
  if (existing.filePath) {
    return existing.filePath;
  }
  if (existing.hasUnsafeCandidate) {
    return undefined;
  }

  const canonicalPath = path.join(root, 'AGENTS.md');
  const status = await inspectAgentsFile(canonicalPath);
  return status === 'missing' ? canonicalPath : undefined;
}

async function findExistingAgentsFile(root: string): Promise<{ filePath?: string; hasUnsafeCandidate: boolean }> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    let code: string | undefined;
    try {
      code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
    } catch {
      code = undefined;
    }
    if (code === 'ENOENT') {
      return { hasUnsafeCandidate: false };
    }
    throw error;
  }

  let hasUnsafeCandidate = false;
  for (const fileName of AGENTS_FILENAMES) {
    const actualFileName = entries.find((entry) => entry === fileName);
    if (!actualFileName) {
      continue;
    }

    const filePath = path.join(root, actualFileName);
    const status = await inspectAgentsFile(filePath);
    if (status === 'file') {
      return { filePath, hasUnsafeCandidate };
    }
    if (status === 'unsafe') {
      hasUnsafeCandidate = true;
    }
  }
  return { hasUnsafeCandidate };
}

async function inspectAgentsFile(filePath: string): Promise<'file' | 'missing' | 'unsafe'> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? 'file' : 'unsafe';
  } catch (error) {
    let code: string | undefined;
    try {
      code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
    } catch {
      code = undefined;
    }
    if (code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

function resolveProjectRoot(project: Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>): string {
  return new PathResolver(project).toFileSystem(project.path);
}
