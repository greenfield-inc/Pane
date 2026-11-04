import { SessionLogBuffer, type LogEntry } from '@shared/utils/session-log-buffer';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

export type LogLine = LogEntry;

/** The phone keeps as many lines as the computer does (`SessionLogBuffer`), and no more than its 1 MiB. */
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

/** The lines with `entry` added, dropping the oldest by the computer's own limits. */
export function appendLog(lines: readonly LogLine[], entry: LogLine): LogLine[] {
  const buffer = new SessionLogBuffer();
  for (const line of lines) buffer.append(line);
  buffer.append(entry);
  return buffer.snapshot();
}

// CSI sequences (colours, cursor moves) and OSC titles, which a script's output carries for terminals.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** A line as text: terminal escape codes dropped, and the trailing newline the script printed. */
export function logText(line: LogLine): string {
  return line.message.replace(ANSI, '').replace(/\r?\n$/, '');
}
