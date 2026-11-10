export const TERMINAL_MULTILINE_NEWLINE_SEQUENCE = '\x1b\r';

export type TerminalKeyHandlingDecision =
  | { action: 'continue' }
  | { action: 'release-to-app' }
  | { action: 'pass-through' }
  | { action: 'block' }
  | { action: 'send-input'; input: string };

export interface TerminalKeyHandlingState {
  isTuiActive: boolean;
  isCliPanel: boolean;
  isMac: boolean;
  keyboardShortcutsEnabled: boolean;
  /** This terminal's Pane find bar is open. */
  findOpen?: boolean;
  /**
   * The key is a Pane key that leaves a full-screen program (the catalog's
   * `releaseInTui` flag, from `isTuiReleasableChordForEvent`).
   */
  releasableFromTui?: boolean;
  /** A two-step key is waiting for its second step, which belongs to Pane. */
  keySequencePending?: boolean;
}

export interface TerminalKeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  getModifierState: (key: string) => boolean;
}

type SurfaceScrollKeyLike = Pick<
  TerminalKeyLike,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

export function isFineSurfaceScrollKey(event: SurfaceScrollKeyLike): boolean {
  return event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && (event.key === 'ArrowUp' || event.key === 'ArrowDown');
}

export function isPageSurfaceScrollKey(event: SurfaceScrollKeyLike): boolean {
  return event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && (event.key === 'PageUp' || event.key === 'PageDown');
}

export function terminalClaimsFineSurfaceScroll(
  event: SurfaceScrollKeyLike,
  state: Pick<TerminalKeyHandlingState, 'isCliPanel' | 'isTuiActive'>,
): boolean {
  return isFineSurfaceScrollKey(event) && state.isTuiActive && !state.isCliPanel;
}

type FindKey = 'find' | 'find-next' | 'find-previous';

function terminalFindKey(event: TerminalKeyLike): FindKey | null {
  if (event.altKey) return null;
  // By key, not code, so it matches the hotkey registry on every layout.
  const letter = event.key.toLowerCase();
  if (letter === 'f') return event.shiftKey ? null : 'find';
  if (letter === 'g') return event.shiftKey ? 'find-previous' : 'find-next';
  return null;
}

/**
 * Who gets Cmd/Ctrl+F, Cmd/Ctrl+G and Shift+Cmd/Ctrl+G in a terminal (D-9).
 * macOS: Command is not a terminal key, so Cmd+F/G always open Pane's find,
 * even over a full-screen program with the kitty keyboard protocol on; Control
 * stays with the terminal (Ctrl+F is readline's forward-char and vim's page
 * down). Windows and Linux: a full-screen program gets Ctrl+F/G; in a plain
 * shell Ctrl+F opens find, and Ctrl+G moves through matches only while the
 * find bar is open (otherwise it stays readline's abort).
 */
function resolveTerminalFindKey(
  event: TerminalKeyLike,
  state: TerminalKeyHandlingState,
): TerminalKeyHandlingDecision | null {
  const findKey = terminalFindKey(event);
  if (!findKey) return null;
  if (state.isMac) {
    if (event.metaKey && !event.ctrlKey) return { action: 'release-to-app' };
    if (event.ctrlKey && !event.metaKey) return { action: 'pass-through' };
    return null;
  }
  if (!event.ctrlKey || event.metaKey) return null;
  if (state.isTuiActive) return { action: 'pass-through' };
  if (findKey === 'find' || state.findOpen) return { action: 'release-to-app' };
  return { action: 'pass-through' };
}

/**
 * Windows and Linux report AltGr as Ctrl+Alt. When the layout's AltGr+digit
 * prints a character, `key` is that character rather than the digit, and the
 * press is typing, not a Pane key.
 */
function isUnreportedAltGrDigit(event: TerminalKeyLike, isMac: boolean): boolean {
  const digitMatch = event.code.match(/^Digit([0-9])$/);
  return !isMac && event.ctrlKey && event.altKey && Boolean(digitMatch) && event.key !== digitMatch?.[1];
}

/**
 * The terminal's clear key: ⌘K on macOS (Ctrl+K stays readline's kill-line),
 * Ctrl+K elsewhere. With a two-step key bound from it (⌘K ⌘M), the clear
 * waits until the key is released without a second step (D-250).
 */
export function isTerminalClearKey(event: TerminalKeyLike, isMac: boolean): boolean {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function resolveTerminalKeyHandling(
  event: TerminalKeyLike,
  state: TerminalKeyHandlingState,
): TerminalKeyHandlingDecision {
  if (!state.keyboardShortcutsEnabled) return { action: 'pass-through' };

  const findDecision = resolveTerminalFindKey(event, state);
  if (findDecision) return findDecision;

  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const shiftEnter = event.shiftKey && !ctrlOrMeta && event.key === 'Enter';

  if (shiftEnter && (!state.isTuiActive || state.isCliPanel)) {
    return { action: 'send-input', input: TERMINAL_MULTILINE_NEWLINE_SEQUENCE };
  }

  if (state.keySequencePending && !isUnreportedAltGrDigit(event, state.isMac)) {
    return { action: 'release-to-app' };
  }

  if (state.isTuiActive && state.releasableFromTui && !isUnreportedAltGrDigit(event, state.isMac)) {
    return { action: 'release-to-app' };
  }

  if (state.isTuiActive) {
    if (ctrlOrMeta && event.key.toLowerCase() === 'v') {
      return { action: 'block' };
    }

    return { action: 'pass-through' };
  }

  return { action: 'continue' };
}
