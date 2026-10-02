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
      if (entry.kind === 'assistant' || entry.timestampMs === undefined || entry.timestampMs < earliest) continue;
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

/** The transcript reader, as one object so callers' tests can stub its reads. */
export const agentTranscripts = {
  findUserTurnSince,
  lastAssistantMessage,
};
