import fs from 'fs';
import path from 'path';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../../shared/validation/boundaryDecoder';
import type { ReaderContext, SourceReader } from './types';
import { absent, codexHome, exists, listDir, mtimeMs, readTailLines, unreadable } from './common';

// Codex keeps one rollout per thread at
// `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl`. Its first
// line is `{type: "session_meta", payload: {id, session_id, cwd, source,
// originator, git: {branch}}}`. Thread names are in
// `session_index.jsonl` as `{id, thread_name}`, last entry wins. A live writer
// holds `thread-writer-locks/<thread id>.lock`; a crash can leave it behind.

/** session_meta carries the full base instructions, so the first line can be long. */
const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024;
const NON_INTERACTIVE_SOURCES = new Set(['exec', 'mcp', 'internal', 'subagent']);

interface CodexThread {
  id: string;
  folder?: string;
  branch?: string;
  title?: string;
  /** `session_meta.payload.source`; an object for subagent threads. */
  source?: string;
  originator?: string;
  /** A subagent's thread: its `session_id` names another root thread. */
  subagent: boolean;
  lastActiveMs: number;
  rolloutPath: string;
}

export interface CodexStore {
  status: 'ok' | 'absent' | 'unreadable';
  reason?: string;
  storePaths: string[];
  threads: CodexThread[];
}

/** The first line of a file, read until its newline or `maxBytes`. */
function readFirstLine(file: string, maxBytes: number): string | undefined {
  const handle = fs.openSync(file, 'r');
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    while (total < maxBytes) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, total);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(chunk.subarray(0, read)));
      total += read;
    }
    return total < maxBytes && total > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
  } finally {
    fs.closeSync(handle);
  }
}

/** Rollout files under `sessions/YYYY/MM/DD`. */
function rolloutFiles(sessionsDir: string): string[] {
  const files: string[] = [];
  for (const year of listDir(sessionsDir)) {
    for (const month of listDir(path.join(sessionsDir, year))) {
      for (const day of listDir(path.join(sessionsDir, year, month))) {
        const dayDir = path.join(sessionsDir, year, month, day);
        for (const name of listDir(dayDir)) {
          if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(path.join(dayDir, name));
        }
      }
    }
  }
  return files;
}

const text = boundary.optional(boundary.nullable(boundary.string));
const indexEntry = boundary.object({ id: boundary.string, thread_name: text });
const sessionMeta = boundary.object({
  type: boundary.literal('session_meta'),
  payload: boundary.object({
    id: boundary.nonEmptyString,
    session_id: text,
    cwd: text,
    originator: text,
    // A string such as `cli` or `exec`, or `{subagent: ...}` for a subagent's thread.
    source: boundary.optional(boundary.json),
    git: boundary.optional(boundary.nullable(boundary.object({ branch: text }))),
  }),
});
const subagentSource = boundary.object({ subagent: boundary.json });

function decodeLine<Value>(line: string | undefined, schema: BoundarySchema<Value>): Value | undefined {
  try {
    return line === undefined ? undefined : decodeOptionalBoundary(JSON.parse(line), schema);
  } catch {
    return undefined;
  }
}

/** Thread names from `session_index.jsonl`, newest entry per id. */
function threadNames(indexFile: string): Map<string, string> {
  const names = new Map<string, string>();
  if (!exists(indexFile)) return names;
  for (const line of readTailLines(indexFile, 1024 * 1024)) {
    const entry = decodeLine(line, indexEntry);
    if (entry?.thread_name) names.set(entry.id, entry.thread_name);
  }
  return names;
}

function parseSessionMeta(line: string | undefined): Omit<CodexThread, 'title' | 'lastActiveMs' | 'rolloutPath'> | undefined {
  const payload = decodeLine(line, sessionMeta)?.payload;
  if (!payload) return undefined;
  const source = decodeOptionalBoundary(payload.source, boundary.string)
    ?? (decodeOptionalBoundary(payload.source, subagentSource) ? 'subagent' : undefined);
  const rootId = payload.session_id || undefined;
  return {
    id: payload.id,
    folder: payload.cwd || undefined,
    branch: payload.git?.branch || undefined,
    source,
    originator: payload.originator || undefined,
    subagent: source === 'subagent' || (rootId !== undefined && rootId !== payload.id),
  };
}

/**
 * Threads in a Codex home whose rollout changed since `context.sinceMs`,
 * interactive or not. Conductor reads its Codex threads from here too.
 */
export function listCodexSessions(context: ReaderContext, home: string): CodexStore {
  const sessionsDir = path.join(home, 'sessions');
  const indexFile = path.join(home, 'session_index.jsonl');
  const storePaths = [sessionsDir, indexFile];
  if (!exists(sessionsDir)) return { status: 'absent', storePaths, threads: [] };

  const names = threadNames(indexFile);
  const threads: CodexThread[] = [];
  let unrecognised = 0;
  for (const rolloutPath of rolloutFiles(sessionsDir)) {
    const lastActiveMs = mtimeMs(rolloutPath);
    if (lastActiveMs === undefined || lastActiveMs < context.sinceMs) continue;
    const meta = parseSessionMeta(readFirstLine(rolloutPath, FIRST_LINE_MAX_BYTES));
    if (!meta) {
      unrecognised += 1;
      continue;
    }
    threads.push({ ...meta, title: names.get(meta.id), lastActiveMs, rolloutPath });
  }
  if (threads.length === 0 && unrecognised > 0) {
    return { status: 'unreadable', reason: 'Codex rollouts don\'t start with the session_meta line Pane knows', storePaths, threads: [] };
  }
  return { status: 'ok', storePaths, threads };
}

/** Whether a running executable is Codex (`codex`, `codex.exe`, `codex-<target>`). */
function isCodexExecutable(executable: string): boolean {
  return /^codex(?:\.exe|-[a-z0-9_-]+)?$/iu.test(path.win32.basename(executable));
}

/**
 * Whether a Codex thread is running. A writer lock with a live Codex process
 * means yes; a lock with no Codex process was left by a crash. The lock is only
 * checked for existence, never opened.
 */
export function codexRunning(home: string, threadId: string, executables: string[]): ImportRunning {
  const codexAlive = executables.some(isCodexExecutable);
  const locksDir = path.join(home, 'thread-writer-locks');
  if (!exists(locksDir)) return codexAlive ? 'unknown' : 'no';
  if (exists(path.join(locksDir, `${threadId}.lock`))) return codexAlive ? 'yes' : 'no';
  return 'no';
}

export const readCodex: SourceReader = async context => {
  const home = codexHome(context);
  const store = listCodexSessions(context, home);
  const storePaths = [...store.storePaths, path.join(home, 'thread-writer-locks')];
  if (store.status === 'absent') return absent('codex', storePaths);
  if (store.status === 'unreadable') return unreadable('codex', store.reason ?? 'unrecognised store', storePaths);

  const executables = await context.processCommands();
  const sessions = store.threads
    .filter(thread => !thread.subagent && !(thread.source && NON_INTERACTIVE_SOURCES.has(thread.source)))
    .map(thread => ({
      source: 'codex' as const,
      agent: 'codex',
      sessionId: thread.id,
      folder: thread.folder,
      branch: thread.branch,
      title: thread.title,
      lastActiveMs: thread.lastActiveMs,
      running: codexRunning(home, thread.id, executables),
    }));
  return { source: 'codex', status: 'ok', storePaths, sessions };
};
