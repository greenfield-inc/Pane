import { File, Paths } from 'expo-file-system';

import type { TerminalSize } from './terminalSession';

/** The terminal's font size, on the page and in the kept screen drawn before it. */
export const TERMINAL_FONT_SIZE = 12;

/**
 * The size the terminal page measured last, on load or once a resize settles. Every terminal fills the same space on a phone, so
 * the next one can size the computer's PTY and read its screen while its own page still loads.
 * Kept across launches in the cache folder; a wrong guess costs one resize once the page measures.
 */
const file = new File(Paths.cache, 'terminal-size.json');
let last: TerminalSize | null | undefined;

export function lastTerminalSize(): TerminalSize | null {
  if (last === undefined) {
    try {
      const saved: unknown = file.exists ? JSON.parse(file.textSync()) : null;
      last = isSize(saved) ? saved : null;
    } catch {
      last = null;
    }
  }
  return last;
}

export function rememberTerminalSize(size: TerminalSize): void {
  if (last?.cols === size.cols && last.rows === size.rows) return;
  last = size;
  try {
    file.write(JSON.stringify(size));
  } catch {
    // The next measurement writes again.
  }
}

function isSize(value: unknown): value is TerminalSize {
  if (typeof value !== 'object' || value === null) return false;
  const { cols, rows } = value as Record<string, unknown>;
  return Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) > 0 && (rows as number) > 0;
}
