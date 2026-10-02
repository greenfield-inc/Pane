import { promises as fs } from 'fs';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';

/** What a transcript line says about the conversation, reduced to what delivery checks need. */
export interface TranscriptEntry {
  /** `user`: a turn the agent took; `queued`: a message waiting for the current turn to end. */
  kind: 'user' | 'queued' | 'assistant';
  text: string;
  timestampMs?: number;
  /** Assistant entries of one message share it, so their text blocks can be joined. */
  messageId?: string;
}

export type TranscriptLineParser = (line: string) => TranscriptEntry | undefined;

/** A first read starts this far from the end, so a long transcript is never read whole. */
const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
/** Growth past this between reads skips to the newest bytes. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_TAILS = 32;

interface TailState {
  /** End of the last complete line read. */
  offset: number;
  /** Whether `offset` is the start of a line (a first read from the tail is not). */
  aligned: boolean;
  entries: TranscriptEntry[];
}

const tails = new Map<string, TailState>();

/** Decode a JSON line with `schema`, or undefined for a partial line or one of another shape. */
export function decodeJsonLine<Value>(line: string, schema: BoundarySchema<Value>): Value | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(line), schema);
  } catch {
    return undefined;
  }
}

/**
 * Message content as agents record it: a string, or blocks of which only
 * `text` blocks are prose. Decodes to that prose, blocks joined by newlines.
 */
export function textContent(textBlockType: string): BoundarySchema<string> {
  const content = boundary.union(
    boundary.string,
    boundary.array(boundary.object({ type: boundary.string, text: boundary.optional(boundary.string) })),
  );
  return {
    decode(current) {
      const value = content.decode(current);
      if (!Array.isArray(value)) return value;
      return value.flatMap(block => (block.type === textBlockType && block.text !== undefined ? [block.text] : [])).join('\n');
    },
  };
}

/** A directory's entry names; none for a missing or unreadable directory. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export function timestampMs(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The recent entries of a JSONL transcript. Each call reads only the bytes
 * appended since the previous call for that file (a first call starts near
 * the end), and keeps the last few hundred entries, so polling a large
 * transcript stays cheap. A file that shrank is read again from its tail.
 */
export async function readTranscriptTail(file: string, parse: TranscriptLineParser): Promise<TranscriptEntry[]> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    let state = tails.get(file);
    tails.delete(file);
    if (!state || size < state.offset) {
      const offset = Math.max(0, size - INITIAL_TAIL_BYTES);
      state = { offset, aligned: offset === 0, entries: [] };
    }
    tails.set(file, state);
    const oldest = tails.size > MAX_TAILS ? tails.keys().next().value : undefined;
    if (oldest !== undefined) tails.delete(oldest);

    let start = state.offset;
    let aligned = state.aligned;
    if (size - start > MAX_READ_BYTES) {
      start = size - MAX_READ_BYTES;
      aligned = false;
    }
    if (size <= start) return state.entries;

    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    // A read that starts mid-file begins inside a line; skip to the next one.
    const firstLineStart = aligned ? 0 : bytes.indexOf(0x0a) + 1;
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return state.entries;
    }

    const text = bytes.subarray(firstLineStart, lastNewline).toString('utf8');
    for (const line of text.split('\n')) {
      const entry = line.trim() ? parse(line) : undefined;
      if (entry) state.entries.push(entry);
    }
    if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
    state.offset = start + lastNewline + 1;
    state.aligned = true;
    return state.entries;
  } finally {
    await handle.close();
  }
}
