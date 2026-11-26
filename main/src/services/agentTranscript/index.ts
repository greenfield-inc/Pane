import { promises as fs } from 'fs';
import { claudeTranscriptFiles, parseClaudeLine } from './claude';
import { codexTranscriptFiles, parseCodexLine } from './codex';
import { readTranscriptTail, type TranscriptEntry } from './tail';

/**
 * Reads the conversation transcript an agent CLI writes for a Pane panel, to
 * learn whether a prompt reached the agent and what it last said. Transcripts
 * are the agents' own files (Claude Code's project JSONL, Codex rollouts);
 * see claude.ts and codex.ts for the shapes relied on.
 */

export interface TranscriptLocator {
  agent: 'claude' | 'codex';
  /** The panel's working directory (the Pane's worktree). */
  cwd: string;
  /** The agent's session (Claude) or thread (Codex) id, when Pane knows it. */
  sessionId?: string;
  /** Transcripts last written before this are not the panel's (the panel's creation time). */
  notBeforeMs?: number;
}

/** Whether Pane can read this agent's transcript (it knows these agents' file formats). */
export function isTranscriptAgent(agent: string | undefined): agent is TranscriptLocator['agent'] {
  return agent === 'claude' || agent === 'codex';
}

interface UserTurnLookup {
  /** `taken`: the agent started a turn with the text; `queued`: it holds the text until its current turn ends. */
  state: 'taken' | 'queued' | null;
  /** The transcript read; absent when no transcript was found for the panel. */
  file?: string;
  /** When the agent recorded the matching entry. */
  timestamp?: string;
}

/** Entries recorded this long before `sinceMs` still count (clock rounding between writers). */
const SINCE_SLACK_MS = 250;
const MIN_CONTAINED_LENGTH = 32;
const LONG_TEXT_LENGTH = 400;
const LONG_TEXT_EDGE = 160;

/**
 * Text as an agent records it, compared loosely: CRLF and whitespace runs
 * collapse, and Claude's `<pasted_content>` wrapper around a paste drops.
 */
function normalizeTurnText(text: string): string {
  return text
    .replace(/<\/?pasted_content(?:\s[^>]*)?>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Whether a recorded turn is the sent text: equal once normalised, or
 * containing it (text of 32+ characters), or, for long text, sharing its
 * start, end and length.
 */
export function turnTextMatches(recorded: string, sent: string): boolean {
  const have = normalizeTurnText(recorded);
  const want = normalizeTurnText(sent);
  if (!want) return false;
  if (have === want) return true;
  if (want.length >= MIN_CONTAINED_LENGTH && have.includes(want)) return true;
  return want.length >= LONG_TEXT_LENGTH &&
    Math.abs(have.length - want.length) <= want.length * 0.02 &&
    have.startsWith(want.slice(0, LONG_TEXT_EDGE)) &&
    have.endsWith(want.slice(-LONG_TEXT_EDGE));
}

// Delivery checks poll every few hundred milliseconds; finding the files
// (directory scans, Codex rollout headers) is redone at most this often.
const LOCATE_CACHE_MS = 1_000;
const locateCache = new Map<string, { at: number; files: string[] }>();

async function transcriptFiles(locator: TranscriptLocator, modifiedSinceMs: number): Promise<string[]> {
  const key = [locator.agent, locator.cwd, locator.sessionId ?? '', modifiedSinceMs].join('\0');
  const cached = locateCache.get(key);
  if (cached && Date.now() - cached.at < LOCATE_CACHE_MS) return cached.files;

  const files = locator.agent === 'claude'
    ? await claudeTranscriptFiles(locator.cwd, locator.sessionId, modifiedSinceMs)
    : await codexTranscriptFiles(locator.cwd, locator.sessionId, modifiedSinceMs);
  if (locateCache.size > 64) locateCache.clear();
  locateCache.set(key, { at: Date.now(), files });
  return files;
}

async function readEntries(locator: TranscriptLocator, file: string): Promise<TranscriptEntry[] | undefined> {
  try {
    return await readTranscriptTail(file, locator.agent === 'claude' ? parseClaudeLine : parseCodexLine);
  } catch {
    return undefined;
  }
}

/**
 * Whether the agent took or queued `text` at or after `sinceMs`. With no
 * `text`, any user turn since then counts (a composer submit whose text Pane
 * could not read). A later `taken` entry wins over a `queued` one.
 */
async function findUserTurnSince(
  locator: TranscriptLocator,
  sinceMs: number,
  text: string | undefined,
): Promise<UserTurnLookup> {
  const earliest = sinceMs - SINCE_SLACK_MS;
  const files = await transcriptFiles(locator, Math.max(earliest, locator.notBeforeMs ?? 0));
  let result: UserTurnLookup = { state: null };
  for (const file of files) {
    const entries = await readEntries(locator, file);
    if (!entries) continue;
    result.file ??= file;
    for (const entry of entries) {
      if ((entry.kind !== 'user' && entry.kind !== 'queued') || entry.timestampMs === undefined || entry.timestampMs < earliest) continue;
      if (text !== undefined && !turnTextMatches(entry.text, text)) continue;
      const state = entry.kind === 'user' ? 'taken' : 'queued';
      if (result.state !== 'taken') {
        result = { state, file, timestamp: new Date(entry.timestampMs).toISOString() };
      }
    }
    if (result.state) return result;
  }
  return result;
}

/** The agent's most recent reply in the panel's transcript, or undefined without one. */
async function lastAssistantMessage(locator: TranscriptLocator): Promise<string | undefined> {
  const [file] = await transcriptFiles(locator, locator.notBeforeMs ?? 0);
  const entries = file ? await readEntries(locator, file) : undefined;
  if (!entries) return undefined;

  let index = entries.length - 1;
  while (index >= 0 && entries[index].kind !== 'assistant') index -= 1;
  if (index < 0) return undefined;
  // Claude records each block of a message as its own entry.
  const { messageId } = entries[index];
  const parts = [entries[index].text];
  for (let before = index - 1; messageId && before >= 0; before -= 1) {
    const entry = entries[before];
    if (entry.kind !== 'assistant' || entry.messageId !== messageId) break;
    parts.unshift(entry.text);
  }
  return parts.join('\n');
}

/**
 * Where a judgment of a panel's turns stopped: rows from `offset` on in `file` are not judged yet.
 * `id` is the file's identity (device and inode): a file replaced or rewritten shorter is another
 * transcript. `fresh` marks a start set at a transcript's end on first sight: rows before the next
 * prompt belong to a turn Pane did not see start, and never count.
 */
export interface TranscriptCursor {
  file: string;
  id: string;
  offset: number;
  fresh?: boolean;
}

export interface FinishedTurns {
  /** Whether a finished turn ended with text the person can read; undefined when no turn finished since the cursor. */
  endedWithText: boolean | undefined;
  /** Where the next judgment starts: before a turn still working, else after the last row read. */
  cursor: TranscriptCursor | undefined;
  /** No cursor for this transcript (a restart, another file, a rewrite): `cursor` is a fresh start at its end, and nothing counted. */
  missed?: boolean;
}

/** A turn: the rows after the prompt that started it (typed, taken, or one nobody typed). */
interface TranscriptTurn {
  start: number;
  rows: TranscriptEntry[];
}

/** A turn ended with text when its last reply-or-tool-call row is non-blank reply text; an empty turn did not. */
function turnEndsWithText(turn: TranscriptTurn): boolean {
  const last = turn.rows.filter(row => row.kind === 'assistant' || row.kind === 'tool').at(-1);
  return last !== undefined && last.kind === 'assistant' && last.text.trim() !== '';
}

/**
 * The agent's turns finished since `cursor`, split at the transcript's own prompt rows (a typed
 * prompt, a queued one the agent took, or one nobody typed, such as a task notification), whether
 * or not a turn wrote anything. Row order decides, never the clock. Every turn followed by another
 * prompt has finished; the last one has finished only when the agent is idle now (`idleNow`), so a
 * turn still working never lends its reply to the one before.
 *
 * `known` holds the tab's cursors, one per transcript it read (path and identity), so going back to
 * a transcript (A, then /clear to B, then /resume A) reads it from its own place. With no cursor for
 * this transcript (none yet, or the same path replaced or rewritten shorter), nothing counts: the
 * answer is a fresh start at the transcript's end, so resumed history is never read as a new reply.
 * The exception is a transcript at a path the tab has no cursor for and has never read in this
 * Pane run (`seen`), created since Pane started (`runStartedAtMs`), as a new Session or a relaunched
 * agent writes: it holds no history the person read, so it is read from its start. One the tab read
 * earlier in the run but no longer keeps a cursor for starts at its end like any other.
 */
async function readFinishedTurns(
  locator: TranscriptLocator,
  known: readonly TranscriptCursor[],
  idleNow: boolean,
  runStartedAtMs?: number,
  seen: ReadonlySet<string> = new Set(),
): Promise<FinishedTurns> {
  const [file] = await transcriptFiles(locator, locator.notBeforeMs ?? 0);
  if (!file) return { endedWithText: undefined, cursor: undefined };
  let id: string;
  let size: number;
  let createdMs: number;
  try {
    const stats = await fs.stat(file);
    id = `${stats.dev}:${stats.ino}`;
    size = stats.size;
    // 0 where the file system keeps no creation time: such a file is never taken as new.
    createdMs = stats.birthtimeMs;
  } catch {
    return { endedWithText: undefined, cursor: undefined };
  }
  const samePath = known.filter(candidate => candidate.file === file);
  const newToRun = samePath.length === 0 && !seen.has(file) && runStartedAtMs !== undefined && createdMs > 0 && createdMs >= runStartedAtMs;
  const cursor = newToRun ? { file, id, offset: 0 } : samePath.find(candidate => candidate.id === id);
  if (!cursor || size < cursor.offset) {
    return { endedWithText: undefined, cursor: { file, id, offset: size, fresh: true }, missed: true };
  }
  const entries = await readEntries(locator, file);
  if (!entries) return { endedWithText: undefined, cursor: undefined };
  const turns: TranscriptTurn[] = [];
  let lastOffset: number | undefined;
  for (const entry of entries) {
    if (entry.offset === undefined || entry.offset < cursor.offset) continue;
    lastOffset = entry.offset;
    if (entry.kind === 'user' || entry.kind === 'boundary') turns.push({ start: entry.offset, rows: [] });
    else if (entry.kind !== 'queued' && !(cursor.fresh && turns.length === 0)) {
      // Rows with no prompt before them since the cursor are a turn of their own, unless the cursor is a fresh start.
      if (turns.length === 0) turns.push({ start: entry.offset, rows: [] });
      turns[turns.length - 1].rows.push(entry);
    }
  }
  const working = idleNow ? undefined : turns.at(-1);
  const finished = working ? turns.slice(0, -1) : turns;
  if (lastOffset === undefined) return { endedWithText: undefined, cursor: undefined };
  const next: TranscriptCursor = { file, id, offset: working ? working.start : lastOffset + 1 };
  // Only rows before the next prompt so far: the fresh start still holds.
  if (cursor.fresh && turns.length === 0) next.fresh = true;
  return { endedWithText: finished.length > 0 ? finished.some(turnEndsWithText) : undefined, cursor: next };
}

/** The transcript reader, as one object so callers' tests can stub its reads. */
export const agentTranscripts = {
  findUserTurnSince,
  lastAssistantMessage,
  readFinishedTurns,
};
