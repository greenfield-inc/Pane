import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { Project } from '../database/models';
import { PathResolver } from '../utils/pathResolver';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

export const PANE_AGENT_CONTEXT_START = '<!-- pane-agent-context:start -->';
export const PANE_AGENT_CONTEXT_END = '<!-- pane-agent-context:end -->';

const AGENTS_FILENAMES = ['AGENTS.md', 'agents.md'] as const;

export interface AgentContextWriteResult {
  changed: boolean;
  filePath?: string;
  skipped?: 'disabled' | 'missing' | 'unsafe-file';
  removed?: boolean;
}

/** Migration only: Pane no longer publishes generated instructions into projects. */
export async function ensureProjectAgentContext(
  project: Pick<Project, 'path' | 'wsl_enabled' | 'wsl_distribution'>,
): Promise<AgentContextWriteResult> {
  const root = resolveProjectRoot(project);
  await removeClaudeImport(root);
  return removeProjectAgentContext(root);
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
  const { filePath, hasUnsafeCandidate } = await findExistingAgentsFile(root);
  if (!filePath) {
    return { changed: false, skipped: hasUnsafeCandidate ? 'unsafe-file' : 'missing' };
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

/** Remove only the import owned by the retired project publisher. */
async function removeClaudeImport(root: string): Promise<void> {
  const filePath = path.join(root, 'CLAUDE.md');
  if (await inspectAgentsFile(filePath) !== 'file') return;
  const existing = await readFileIfExists(filePath) ?? '';
  const next = removeManagedBlock(existing);
  if (next !== existing) await writeFileNoFollow(filePath, next);
}
