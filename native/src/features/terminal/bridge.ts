/**
 * Messages between the native screen and the xterm page inside the WebView.
 * The page lives in `native/terminal-web/` and is bundled into
 * `terminalHtml.generated.ts` by `pnpm build:terminal-web`.
 */

/** An xterm `ITheme`: background, foreground, cursor, selection and the 16 ANSI colors. */
type TerminalTheme = Record<string, string>;

/** Native → page. */
export type TerminalCommand =
  /** Clears the screen and scrollback, then writes `data` (the initial snapshot). */
  | { type: 'reset'; data: string }
  | { type: 'write'; data: string }
  | { type: 'scroll'; lines: number }
  | { type: 'scrollToBottom' }
  | { type: 'theme'; theme: TerminalTheme; fontSize: number };

/** Page → native. */
export type TerminalPageEvent =
  | { type: 'ready'; cols: number; rows: number }
  | { type: 'resize'; cols: number; rows: number }
  /** Bytes xterm emitted on its own (focus and mouse reports, answers to terminal queries). */
  | { type: 'input'; data: string }
  /** The page parsed a `write` of this many UTF-16 code units; the host needs an ack for flow control. */
  | { type: 'written'; units: number }
  /** Whether the viewport is scrolled up from the bottom. */
  | { type: 'scrolled'; atBottom: boolean }
  /** The rows currently on screen, for VoiceOver and TalkBack. */
  | { type: 'screen'; text: string };

export function parsePageEvent(raw: string): TerminalPageEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'ready':
    case 'resize':
      return isPositiveInt(event.cols) && isPositiveInt(event.rows)
        ? { type: event.type, cols: event.cols, rows: event.rows }
        : null;
    case 'input':
      return typeof event.data === 'string' ? { type: 'input', data: event.data } : null;
    case 'written':
      return isPositiveInt(event.units) ? { type: 'written', units: event.units } : null;
    case 'scrolled':
      return typeof event.atBottom === 'boolean' ? { type: 'scrolled', atBottom: event.atBottom } : null;
    case 'screen':
      return typeof event.text === 'string' ? { type: 'screen', text: event.text } : null;
    default:
      return null;
  }
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
