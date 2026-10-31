import type { LogEntry } from '@shared/utils/session-log-buffer';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

export type LogLine = LogEntry;

/** The phone keeps as many lines as the computer does (`SessionLogBuffer`). */
export const MAX_LOG_LINES = 1000;

const entrySchema = boundary.object({
  timestamp: boundary.string,
  level: boundary.enumeration('info', 'warn', 'error', 'debug'),
  message: boundary.string,
  source: boundary.optional(boundary.string),
});

/** A `session-log` event's entry, or null when it has another shape. */
export function decodeLogEntry(value: unknown): LogLine | null {
  return decodeOptionalBoundary(value, entrySchema) ?? null;
}

export function appendLog(lines: readonly LogLine[], entry: LogLine): LogLine[] {
  const next = [...lines, entry];
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
}

// CSI sequences (colours, cursor moves) and OSC titles, which a script's output carries for terminals.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** A line as text: terminal escape codes dropped, and the trailing newline the script printed. */
export function logText(line: LogLine): string {
  return line.message.replace(ANSI, '').replace(/\r?\n$/, '');
}
