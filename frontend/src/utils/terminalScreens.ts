import type { Terminal } from '@xterm/xterm';

/**
 * The last screen each terminal panel showed, as row extents, kept across
 * unmounts: switching Sessions or Panes unmounts their terminals, and a
 * terminal that mounts again draws its loading skeleton in the shape of the
 * screen it left. Forgotten when the panel or its session is deleted.
 */

/** One row's text extent in cells, [first non-blank, end); [0, 0] is a blank row. */
export type TerminalRowExtent = readonly [number, number];

interface TerminalScreen {
  sessionId: string;
  rows: readonly TerminalRowExtent[];
}

const screens = new Map<string, TerminalScreen>();

export function rememberTerminalScreen(panelId: string, sessionId: string, rows: readonly TerminalRowExtent[]): void {
  screens.set(panelId, { sessionId, rows });
}

export function rememberedTerminalScreen(panelId: string): readonly TerminalRowExtent[] | undefined {
  return screens.get(panelId)?.rows;
}

export function forgetTerminalScreen(panelId: string): void {
  screens.delete(panelId);
}

export function forgetTerminalScreensInSession(sessionId: string): void {
  for (const [panelId, screen] of screens) {
    if (screen.sessionId === sessionId) screens.delete(panelId);
  }
}

/** The rows on a terminal's screen now, as text extents. */
export function readTerminalScreen(terminal: Terminal): TerminalRowExtent[] {
  const buffer = terminal.buffer.active;
  const rows: TerminalRowExtent[] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const text = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '';
    const start = text.length - text.trimStart().length;
    rows.push(text.length > start ? [start, text.length] : [0, 0]);
  }
  return rows;
}
