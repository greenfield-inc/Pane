import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { decodeJsonLine, listDir, textContent, timestampMs, type TranscriptEntry } from './tail';

// Codex 0.15x writes one rollout per thread at
// `~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`. The
// first line is `session_meta` with the thread's `cwd`. A taken turn is a
// `response_item` user message (`input_text` blocks), plus an `event_msg`
// (`user_message`, or `item_completed` with a `UserMessage` in newer builds).
// A message sent while Codex works is not written until Codex takes it, so a
// queued message only shows on screen.

/** Day directories searched for a rollout Pane has no thread id for. */
const RECENT_DAY_DIRS = 3;
/** Day directories searched for a known thread id (a resumed thread keeps its original rollout). */
const MAX_DAY_DIRS = 400;
const META_READ_BYTES = 64 * 1024;

const rolloutCwds = new Map<string, string | null>();

function codexSessionsRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

const userContent = textContent('input_text');
const assistantContent = textContent('output_text');

const codexLine = boundary.object({
  type: boundary.string,
  timestamp: boundary.optional(boundary.string),
  payload: boundary.union(
    boundary.object({
      type: boundary.literal('message'),
      role: boundary.string,
      id: boundary.optional(boundary.string),
      content: boundary.json,
    }),
    boundary.object({ type: boundary.literal('user_message'), message: boundary.string }),
    boundary.object({ type: boundary.string }),
  ),
});

/** Context Codex sends as user messages (AGENTS.md, `<environment_context>` and the like), not typed turns. */
function isInjectedContext(text: string): boolean {
  return /^<[a-z_]+[\s>]/iu.test(text) || text.startsWith('# AGENTS.md');
}

export function parseCodexLine(line: string): TranscriptEntry | undefined {
  const row = decodeJsonLine(line, codexLine);
  if (!row) return undefined;
  const at = timestampMs(row.timestamp);
  const { payload } = row;

  if (row.type === 'response_item' && payload.type === 'message' && 'role' in payload) {
    if (payload.role === 'user') {
      const text = decodeOptionalBoundary(payload.content, userContent);
      return text && !isInjectedContext(text) ? { kind: 'user', text, timestampMs: at } : undefined;
    }
    if (payload.role === 'assistant') {
      const text = decodeOptionalBoundary(payload.content, assistantContent);
      return text ? { kind: 'assistant', text, timestampMs: at, messageId: payload.id } : undefined;
    }
    return undefined;
  }

  if (row.type === 'event_msg' && payload.type === 'user_message' && 'message' in payload) {
    return { kind: 'user', text: payload.message, timestampMs: at };
  }
  return undefined;
}

async function listDirsNewestFirst(dir: string): Promise<string[]> {
  return (await listDir(dir)).filter(name => /^\d+$/u.test(name)).sort().reverse();
}

/** Day directories under the sessions root, newest first. */
async function dayDirs(limit: number): Promise<string[]> {
  const root = codexSessionsRoot();
  const days: string[] = [];
  for (const year of await listDirsNewestFirst(root)) {
    for (const month of await listDirsNewestFirst(path.join(root, year))) {
      for (const day of await listDirsNewestFirst(path.join(root, year, month))) {
        days.push(path.join(root, year, month, day));
        if (days.length >= limit) return days;
      }
    }
  }
  return days;
}

async function rolloutsIn(dir: string): Promise<string[]> {
  const names = await listDir(dir);
  return names.filter(name => name.startsWith('rollout-') && name.endsWith('.jsonl')).map(name => path.join(dir, name));
}

async function readHead(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(META_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** The rollout's working directory, or null for a sub-agent thread or an unreadable file. */
async function rolloutCwd(file: string): Promise<string | null> {
  const cached = rolloutCwds.get(file);
  if (cached !== undefined) return cached;
  let cwd: string | null = null;
  try {
    const head = await readHead(file);
    // session_meta can exceed the read (it carries the base instructions),
    // so pull its fields out of the head rather than parse the whole line.
    const isMeta = head.startsWith('{') && head.slice(0, 200).includes('"session_meta"');
    const match = isMeta ? head.match(/"cwd":("(?:[^"\\]|\\.)*")/u) : null;
    if (match && !/"parent_thread_id":"/u.test(head)) {
      cwd = decodeOptionalBoundary(JSON.parse(match[1]), boundary.string) ?? null;
    }
  } catch {
    cwd = null;
  }
  if (rolloutCwds.size > 2_000) rolloutCwds.clear();
  rolloutCwds.set(file, cwd);
  return cwd;
}

async function canonicalPath(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Rollouts for a Codex thread: the thread's own rollout when Pane knows its
 * id, else rollouts of `cwd` written since `modifiedSinceMs`, newest first.
 */
export async function codexTranscriptFiles(cwd: string, threadId: string | undefined, modifiedSinceMs: number): Promise<string[]> {
  if (threadId) {
    for (const dir of await dayDirs(MAX_DAY_DIRS)) {
      const file = (await rolloutsIn(dir)).find(candidate => candidate.endsWith(`-${threadId}.jsonl`));
      if (file) return [file];
    }
    return [];
  }

  const target = await canonicalPath(cwd);
  const found: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of await dayDirs(RECENT_DAY_DIRS)) {
    for (const file of await rolloutsIn(dir)) {
      const stats = await fs.stat(file).catch(() => undefined);
      if (!stats || stats.mtimeMs < modifiedSinceMs) continue;
      const rolloutDir = await rolloutCwd(file);
      if (rolloutDir && (rolloutDir === cwd || await canonicalPath(rolloutDir) === target)) {
        found.push({ file, mtimeMs: stats.mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map(entry => entry.file);
}
