import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { Project } from '../database/models';
import type { AppConfig } from '../types/config';
import { PathResolver } from '../utils/pathResolver';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';

export const PANE_AGENT_CONTEXT_START = '<!-- pane-agent-context:start -->';
export const PANE_AGENT_CONTEXT_END = '<!-- pane-agent-context:end -->';

const AGENTS_FILENAMES = ['AGENTS.md', 'agents.md'] as const;

export interface AgentContextWriteResult {
  changed: boolean;
  filePath?: string;
  skipped?: 'disabled' | 'missing' | 'unsafe-file';
  removed?: boolean;
}

export async function ensureProjectAgentContext(
  project: Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>,
  config: Pick<AppConfig, 'agentContext'>,
): Promise<AgentContextWriteResult> {
  const root = resolveProjectRoot(project);
  const enabled = config.agentContext?.managedAgentsMd === true;

  if (!enabled) {
    return removeProjectAgentContext(root);
  }

  const filePath = await resolveAgentsFilePath(root);
  if (!filePath) {
    return { changed: false, skipped: 'unsafe-file' };
  }
  const existing = await readFileIfExists(filePath);
  const block = renderManagedAgentContextBlock();
  const next = upsertManagedBlock(existing ?? '', block);

  if (existing === next) {
    return { changed: false, filePath };
  }

  await writeFileNoFollow(filePath, next);
  return { changed: true, filePath };
}

/**
 * Apply the repository AGENTS.md setting. Off removes Pane's marked section
 * from every known project; on publishes it to the active project. Used by the
 * settings toggle and by the startup migration that turned it off.
 */
export async function applyManagedAgentsMdSetting<P extends Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>>(
  config: Pick<AppConfig, 'agentContext'>,
  projects: { all: () => P[]; active: () => P | null | undefined },
): Promise<void> {
  const active = projects.active();
  const targets = config.agentContext?.managedAgentsMd === true ? (active ? [active] : []) : projects.all();
  for (const project of targets) {
    try {
      await ensureProjectAgentContext(project, config);
    } catch (error) {
      console.warn('[AgentContext] Failed to update Pane agent context for project:', project.path, error);
    }
  }
}

function renderManagedAgentContextBlock(): string {
  return [
    PANE_AGENT_CONTEXT_START,
    ...RUNPANE_CONTRACT.agentContext.managedBlock,
    PANE_AGENT_CONTEXT_END,
    ''
  ].join('\n');
}

function upsertManagedBlock(existing: string, block: string = renderManagedAgentContextBlock()): string {
  const startIndex = existing.indexOf(PANE_AGENT_CONTEXT_START);
  const endIndex = existing.indexOf(PANE_AGENT_CONTEXT_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const afterEndIndex = consumeTrailingNewline(existing, endIndex + PANE_AGENT_CONTEXT_END.length);
    return `${existing.slice(0, startIndex)}${block}${existing.slice(afterEndIndex)}`;
  }

  if (existing.trim().length === 0) {
    return block;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}`;
}

function removeManagedBlock(existing: string): string {
  const startIndex = existing.indexOf(PANE_AGENT_CONTEXT_START);
  const endIndex = existing.indexOf(PANE_AGENT_CONTEXT_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return existing;
  }

  const afterEndIndex = consumeTrailingNewline(existing, endIndex + PANE_AGENT_CONTEXT_END.length);
  const next = `${existing.slice(0, startIndex)}${existing.slice(afterEndIndex)}`;
  return next.trim().length === 0 ? '' : next;
}

async function removeProjectAgentContext(root: string): Promise<AgentContextWriteResult> {
  const { filePath } = await findExistingAgentsFile(root);
  if (!filePath) {
    return { changed: false, skipped: 'disabled' };
  }

  const existing = await readFileIfExists(filePath);
  if (existing === undefined) {
    return { changed: false, skipped: 'missing' };
  }

  const next = removeManagedBlock(existing);
  if (next === existing) {
    return { changed: false, filePath, skipped: 'disabled' };
  }

  await writeFileNoFollow(filePath, next);
  return { changed: true, filePath, removed: true };
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

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    const handle = await fs.open(filePath, constants.O_RDONLY | noFollowFlag());
    try {
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    let code: string | undefined;
    try {
      code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
    } catch {
      code = undefined;
    }
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
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

async function writeFileNoFollow(filePath: string, content: string): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag(),
    0o666,
  );
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

function resolveProjectRoot(project: Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>): string {
  return new PathResolver(project).toFileSystem(project.path);
}

function noFollowFlag(): number {
  if (process.platform === 'win32') {
    return 0;
  }
  return constants.O_NOFOLLOW ?? 0;
}

function consumeTrailingNewline(value: string, index: number): number {
  if (value[index] === '\r' && value[index + 1] === '\n') {
    return index + 2;
  }
  if (value[index] === '\n') {
    return index + 1;
  }
  return index;
}
