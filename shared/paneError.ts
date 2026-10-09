import type { PaneDaemonError } from './types/daemon';

/**
 * A failure Pane reports to people and agents. `message` says what happened, why (the
 * underlying reason, kept), and what was or was not changed; `next` is the exact step to take.
 * See "How Pane reports errors" in CONTRIBUTING.md.
 */
export class PaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly next?: string,
  ) {
    super(message);
    this.name = 'PaneError';
  }
}

/** The wire form of any thrown value. A plain error keeps its message under `fallbackCode`. */
export function toPaneDaemonError(error: unknown, fallbackCode: string): PaneDaemonError & { code: string } {
  if (error instanceof PaneError) {
    return { code: error.code, message: error.message, ...(error.next ? { next: error.next } : {}) };
  }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

/** One line for surfaces that carry only text, such as an Electron IPC rejection. */
export function paneErrorText(error: { message: string; next?: string }): string {
  return error.next ? `${error.message} Next: ${error.next}` : error.message;
}

/** The underlying reason to quote inside a sentence: the error's message without trailing whitespace or period. */
export function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().replace(/\.+$/, '');
}
