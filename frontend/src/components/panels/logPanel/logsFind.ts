import { findOffsets } from '../../find/findText';

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export interface LogOccurrence {
  line: number;
  start: number;
}

/** Every occurrence of `query` in the visible (ANSI-stripped) log lines. */
export function findLogOccurrences(messages: readonly string[], query: string): LogOccurrence[] {
  if (!query) return [];
  const occurrences: LogOccurrence[] = [];
  messages.forEach((message, line) => {
    for (const start of findOffsets(stripAnsi(message), query)) occurrences.push({ line, start });
  });
  return occurrences;
}

export interface LinePart {
  text: string;
  hit: boolean;
}

/** Split already-stripped text into runs, marking each occurrence of `query`. */
export function splitLineByQuery(text: string, query: string): LinePart[] {
  const parts: LinePart[] = [];
  let cursor = 0;
  for (const start of findOffsets(text, query)) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, start + query.length), hit: true });
    cursor = start + query.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}
