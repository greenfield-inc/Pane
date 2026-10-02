import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { boundary } from '../../../../shared/validation/boundaryDecoder';
import { decodeJsonLine, listDir, textContent, timestampMs, type TranscriptEntry } from './tail';

// Claude Code 2.1 keeps one JSONL transcript per session at
// `~/.claude/projects/<cwd with every non-alphanumeric character as '-'>/<session id>.jsonl`.
// A taken turn is `{"type":"user","message":{"role":"user","content":"<text>"}}`
// (content may be text blocks; a paste is wrapped in `<pasted_content id=…>`).
// A message sent while Claude works is first
// `{"type":"queue-operation","operation":"enqueue","content":"<text>"}`, then a
// `user` entry once Claude takes it.

const MAX_PROJECT_DIR_NAME = 200;

function claudeProjectsRoot(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** The directory name Claude Code files a working directory's transcripts under. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-');
}

const claudeLine = boundary.union(
  boundary.object({
    type: boundary.literal('queue-operation'),
    operation: boundary.string,
    content: boundary.optional(boundary.string),
    timestamp: boundary.optional(boundary.string),
  }),
  boundary.object({
    type: boundary.enumeration('user', 'assistant'),
    isSidechain: boundary.optional(boundary.boolean),
    isMeta: boundary.optional(boundary.boolean),
    // Background-task notifications are user entries too; newer builds say who wrote each.
    origin: boundary.optional(boundary.object({ kind: boundary.optional(boundary.string) })),
    timestamp: boundary.optional(boundary.string),
    message: boundary.object({
      id: boundary.optional(boundary.string),
      role: boundary.optional(boundary.string),
      content: textContent('text'),
    }),
  }),
);

// Claude queues its own background-task notifications (`<task-notification>…`) like typed messages.
const INJECTED_TEXT = /^<[a-z_-]+[\s>]/iu;

export function parseClaudeLine(line: string): TranscriptEntry | undefined {
  const row = decodeJsonLine(line, claudeLine);
  if (!row) return undefined;

  if (row.type === 'queue-operation') {
    return row.operation === 'enqueue' && row.content && !INJECTED_TEXT.test(row.content)
      ? { kind: 'queued', text: row.content, timestampMs: timestampMs(row.timestamp) }
      : undefined;
  }

  const text = row.message.content;
  if (!text || row.isSidechain === true) return undefined;
  if (row.type === 'user') {
    const typed = row.message.role === 'user' && row.isMeta !== true && (row.origin?.kind ?? 'human') === 'human';
    return typed ? { kind: 'user', text, timestampMs: timestampMs(row.timestamp) } : undefined;
  }
  return { kind: 'assistant', text, timestampMs: timestampMs(row.timestamp), messageId: row.message.id };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function projectDirs(cwd: string): Promise<string[]> {
  const root = claudeProjectsRoot();
  const names = new Set([claudeProjectDirName(cwd)]);
  try {
    names.add(claudeProjectDirName(await fs.realpath(cwd)));
  } catch {
    // A missing worktree still has its recorded name.
  }
  const dirs = [...names].map(name => path.join(root, name));
  // Claude shortens very long directory names and appends a hash.
  const long = [...names].filter(name => name.length > MAX_PROJECT_DIR_NAME);
  if (long.length > 0) {
    const entries = await listDir(root);
    for (const entry of entries) {
      if (long.some(name => entry.startsWith(name.slice(0, MAX_PROJECT_DIR_NAME)))) dirs.push(path.join(root, entry));
    }
  }
  return dirs;
}

/**
 * Transcript files for a Claude session: the session's own file when Pane
 * knows its id, else the working directory's transcripts written since
 * `modifiedSinceMs`, newest first.
 */
export async function claudeTranscriptFiles(cwd: string, sessionId: string | undefined, modifiedSinceMs: number): Promise<string[]> {
  const dirs = await projectDirs(cwd);
  if (sessionId) {
    for (const dir of dirs) {
      const file = path.join(dir, `${sessionId}.jsonl`);
      if (await isFile(file)) return [file];
    }
    return [];
  }

  const found: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of dirs) {
    const names = await listDir(dir);
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const stats = await fs.stat(file).catch(() => undefined);
      if (stats?.isFile() && stats.mtimeMs >= modifiedSinceMs) found.push({ file, mtimeMs: stats.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map(entry => entry.file);
}
