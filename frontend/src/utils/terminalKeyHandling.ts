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
  isTuiReleasableChord?: (event: TerminalKeyLike) => boolean;
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

export function shouldOpenTerminalSearch(
  event: Pick<TerminalKeyLike, 'ctrlKey' | 'metaKey' | 'key'>,
  keyboardShortcutsEnabled: boolean,
): boolean {
  return keyboardShortcutsEnabled
    && (event.ctrlKey || event.metaKey)
    && event.key.toLowerCase() === 'f';
}

function isPaneNavigationShortcut(
  event: TerminalKeyLike,
  state: TerminalKeyHandlingState,
): boolean {
  const primaryModifier = state.isMac ? event.metaKey : event.ctrlKey;
  if (!primaryModifier) return false;

  const isAltGr = event.getModifierState('AltGraph');
  const digitMatch = event.code.match(/^Digit([1-9])$/);
  const isUnreportedAltGrDigit = !state.isMac
    && event.ctrlKey
    && event.altKey
    && digitMatch
    && event.key !== digitMatch[1];
  if (isAltGr || isUnreportedAltGrDigit) return false;
  return state.isTuiReleasableChord?.(event) ?? false;
}

const TERMINAL_RESERVED_EVENT_KEYS = ['f', 'v', 'q', 'p'];
// mod+k (any Shift/Alt) is the terminal's clear-scrollback branch in TerminalPanel.
const TERMINAL_RESERVED_CHORD_KEYS = new Set([...TERMINAL_RESERVED_EVENT_KEYS, 'k']);

export function isTerminalReservedChord(event: TerminalKeyLike): boolean {
  if (event.code === 'AltRight') return true;
  return (event.ctrlKey || event.metaKey)
    && TERMINAL_RESERVED_EVENT_KEYS.includes(event.key.toLowerCase());
}

/**
 * String twin of `isTerminalReservedChord` for chords a user records: the
 * terminal owns Ctrl/Cmd + f/v/q/p/k with any Shift/Alt combination.
 */
export function isTerminalReservedChordString(chord: string): boolean {
  const parts = chord.split('+');
  return parts.includes('mod') && TERMINAL_RESERVED_CHORD_KEYS.has(parts[parts.length - 1]);
}

export function shouldReleaseToApplication(
  event: TerminalKeyLike,
  state: { isMac: boolean; isBound: boolean },
): boolean {
  if (event.getModifierState('AltGraph')) return false;
  const isBackslash = event.code === 'Backslash' || event.code === 'IntlBackslash';
  if (isBackslash && (state.isMac ? !event.metaKey : !event.ctrlKey)) return false;
  return state.isBound;
}

export function resolveTerminalKeyHandling(
  event: TerminalKeyLike,
  state: TerminalKeyHandlingState,
): TerminalKeyHandlingDecision {
  if (!state.keyboardShortcutsEnabled) return { action: 'pass-through' };

  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const shiftEnter = event.shiftKey && !ctrlOrMeta && event.key === 'Enter';

  if (shiftEnter && (!state.isTuiActive || state.isCliPanel)) {
    return { action: 'send-input', input: TERMINAL_MULTILINE_NEWLINE_SEQUENCE };
  }

  if (state.isTuiActive && isPaneNavigationShortcut(event, state)) {
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
