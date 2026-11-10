import { describe, expect, it } from 'vitest';
import { buildInterceptionSets } from '../../../shared/utils/keyboardBindings';
import { chordFromKeyboardEvent } from '../../../shared/utils/keyboardChords';
import {
  isFineSurfaceScrollKey,
  isPageSurfaceScrollKey,
  isTerminalClearKey,
  resolveTerminalKeyHandling as resolveWithState,
  terminalClaimsFineSurfaceScroll,
  TERMINAL_MULTILINE_NEWLINE_SEQUENCE,
  type TerminalKeyHandlingState,
  type TerminalKeyLike,
} from './terminalKeyHandling';

const defaultSets = {
  mac: buildInterceptionSets({ keyPlatform: 'mac' }),
  other: buildInterceptionSets({ keyPlatform: 'other' }),
};

/** Resolves with `releasableFromTui` filled from the default catalog, as TerminalPanel does. */
function resolveTerminalKeyHandling(event: TerminalKeyLike, state: TerminalKeyHandlingState) {
  const keyPlatform = state.isMac ? 'mac' : 'other';
  return resolveWithState(event, {
    releasableFromTui: defaultSets[keyPlatform].tuiReleasable.has(chordFromKeyboardEvent(event, keyPlatform)),
    ...state,
  });
}

const key = (overrides: Partial<TerminalKeyLike>): TerminalKeyLike => ({
  key: 'a',
  code: 'KeyA',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  getModifierState: () => false,
  ...overrides,
});

describe('focused surface terminal key boundary', () => {
  const shiftKey = (keyName: string) => key({ key: keyName, code: keyName, shiftKey: true });

  it('recognizes only unmodified Shift+Arrow and Shift+Page chords', () => {
    expect(isFineSurfaceScrollKey(shiftKey('ArrowUp'))).toBe(true);
    expect(isPageSurfaceScrollKey(shiftKey('PageDown'))).toBe(true);
    expect(isFineSurfaceScrollKey(key({ key: 'ArrowUp', shiftKey: true, ctrlKey: true }))).toBe(false);
  });

  it('reserves fine scrolling for Pane in known CLI agent panels', () => {
    const event = shiftKey('ArrowDown');
    expect(terminalClaimsFineSurfaceScroll(event, { isCliPanel: true, isTuiActive: false })).toBe(false);
    expect(terminalClaimsFineSurfaceScroll(event, { isCliPanel: true, isTuiActive: true })).toBe(false);
  });

  it('lets ordinary active TUIs claim fine scrolling', () => {
    const event = shiftKey('ArrowDown');
    expect(terminalClaimsFineSurfaceScroll(event, { isCliPanel: false, isTuiActive: true })).toBe(true);
    expect(terminalClaimsFineSurfaceScroll(event, { isCliPanel: false, isTuiActive: false })).toBe(false);
  });

  it('keeps coarse page scrolling owned by the terminal surface', () => {
    expect(terminalClaimsFineSurfaceScroll(
      shiftKey('PageUp'),
      { isCliPanel: true, isTuiActive: true },
    )).toBe(false);
  });
});

const tui = (overrides: Partial<TerminalKeyHandlingState> = {}): TerminalKeyHandlingState => ({
  isTuiActive: true,
  isCliPanel: true,
  isMac: false,
  keyboardShortcutsEnabled: true,
  ...overrides,
});

describe('resolveTerminalKeyHandling', () => {
  it('passes keys through when Pane keyboard shortcuts are disabled', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'w', code: 'KeyW', ctrlKey: true }),
      tui({ keyboardShortcutsEnabled: false }),
    )).toEqual({ action: 'pass-through' });
  });

  it('sends the multiline sequence for Shift+Enter outside TUI mode', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true }),
      tui({ isTuiActive: false, isCliPanel: false }),
    )).toEqual({ action: 'send-input', input: TERMINAL_MULTILINE_NEWLINE_SEQUENCE });
  });

  it('sends the multiline sequence for CLI agent panels in TUI mode', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true }),
      tui(),
    )).toEqual({ action: 'send-input', input: TERMINAL_MULTILINE_NEWLINE_SEQUENCE });
  });

  it('passes Shift+Enter through for ordinary TUI apps', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true }),
      tui({ isCliPanel: false }),
    )).toEqual({ action: 'pass-through' });
  });

  it('does not swallow Ctrl+Shift+Enter chords', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'Enter', shiftKey: true, ctrlKey: true }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('blocks Cmd/Ctrl+V in TUI mode so native paste can run', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'v', metaKey: true }),
      tui(),
    )).toEqual({ action: 'block' });
  });

  it('passes Ctrl+C through in TUI mode so fullscreen apps can handle interrupts', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'c', ctrlKey: true }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('continues to later terminal shortcut handling outside TUI mode', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: '1', metaKey: true }),
      tui({ isTuiActive: false }),
    )).toEqual({ action: 'continue' });
  });

  it.each([
    ['focus groups', key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true })],
    ['switch sessions', key({ key: 'Tab', code: 'Tab', ctrlKey: true })],
    ['switch group tabs', key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })],
    ['add tools', key({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true })],
    ['split groups', key({ key: '\\', code: 'Backslash', ctrlKey: true })],
    ['focus the sidebar', key({ key: '0', code: 'Digit0', ctrlKey: true })],
    ['cycle regions', key({ key: 'F6', code: 'F6' })],
    ['minimize', key({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true })],
    ['switch machines', key({ key: 'o', code: 'KeyO', ctrlKey: true, altKey: true })],
    ['cycle tabs', key({ key: 'PageDown', code: 'PageDown', ctrlKey: true })],
    ['toggle the right panel', key({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true })],
  ])('releases Pane %s shortcuts while a TUI is active', (_label, event) => {
    expect(resolveTerminalKeyHandling(event, tui())).toEqual({ action: 'release-to-app' });
  });

  it('releases the second step of a two-step key', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'm', code: 'KeyM', metaKey: true }),
      tui({ isMac: true, keySequencePending: true }),
    )).toEqual({ action: 'release-to-app' });
    expect(resolveTerminalKeyHandling(
      key({ key: 'm', code: 'KeyM', metaKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'pass-through' });
  });

  it.each(['a', 'b', 'd', 'e', 'k', 'w', 'q'])('keeps Ctrl+%s with a full-screen program on macOS', (letter) => {
    expect(resolveTerminalKeyHandling(
      key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'pass-through' });
  });

  it('clears with Cmd+K on macOS and Ctrl+K elsewhere, never macOS Ctrl+K', () => {
    expect(isTerminalClearKey(key({ key: 'k', code: 'KeyK', metaKey: true }), true)).toBe(true);
    expect(isTerminalClearKey(key({ key: 'k', code: 'KeyK', ctrlKey: true }), true)).toBe(false);
    expect(isTerminalClearKey(key({ key: 'k', code: 'KeyK', ctrlKey: true }), false)).toBe(true);
    expect(isTerminalClearKey(key({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('releases Cmd+Backslash but preserves Ctrl+Backslash on macOS', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: '\\', code: 'Backslash', metaKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'release-to-app' });
    expect(resolveTerminalKeyHandling(
      key({ key: '\\', code: 'Backslash', ctrlKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'pass-through' });
  });

  it('requires Cmd instead of Ctrl for Pane shortcuts on macOS', () => {
    expect(resolveTerminalKeyHandling(
      key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'pass-through' });
    expect(resolveTerminalKeyHandling(
      key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true }),
      tui({ isMac: true }),
    )).toEqual({ action: 'release-to-app' });
  });

  it.each(['a', 'd', 'w', 'p', 'n', 'b', 'f'])(
    'preserves Ctrl+%s for the active TUI',
    (letter) => {
      expect(resolveTerminalKeyHandling(
        key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true }),
        tui(),
      )).toEqual({ action: 'pass-through' });
    },
  );

  it('does not treat AltGr digits as Pane shortcuts', () => {
    expect(resolveTerminalKeyHandling(
      key({
        key: '1',
        code: 'Digit1',
        ctrlKey: true,
        altKey: true,
        getModifierState: (modifier) => modifier === 'AltGraph',
      }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('does not treat modified AltGr digit output as a Pane shortcut when AltGraph is unavailable', () => {
    expect(resolveTerminalKeyHandling(
      key({
        key: '@',
        code: 'Digit2',
        ctrlKey: true,
        altKey: true,
      }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });

  it('does not swallow navigation-like chords with unsupported extra modifiers', () => {
    expect(resolveTerminalKeyHandling(
      key({
        key: 'ArrowRight',
        code: 'ArrowRight',
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      }),
      tui(),
    )).toEqual({ action: 'pass-through' });
  });
});

describe('find keys in the terminal (D-9)', () => {
  const plainShell = (overrides: Partial<TerminalKeyHandlingState> = {}) =>
    tui({ isTuiActive: false, isCliPanel: false, ...overrides });
  const cmd = (k: string, shiftKey = false) => key({ key: shiftKey ? k.toUpperCase() : k, code: `Key${k.toUpperCase()}`, metaKey: true, shiftKey });
  const ctrl = (k: string, shiftKey = false) => key({ key: shiftKey ? k.toUpperCase() : k, code: `Key${k.toUpperCase()}`, ctrlKey: true, shiftKey });

  describe('macOS', () => {
    it.each([
      ['Cmd+F', cmd('f')],
      ['Cmd+G', cmd('g')],
      ['Shift+Cmd+G', cmd('g', true)],
    ])('%s opens Pane find in a plain shell and over a full-screen program (kitty on or off)', (_label, event) => {
      // The decision is made before xterm's kitty encoder sees the key.
      expect(resolveTerminalKeyHandling(event, plainShell({ isMac: true }))).toEqual({ action: 'release-to-app' });
      expect(resolveTerminalKeyHandling(event, tui({ isMac: true, isCliPanel: false }))).toEqual({ action: 'release-to-app' });
      expect(resolveTerminalKeyHandling(event, tui({ isMac: true }))).toEqual({ action: 'release-to-app' });
    });

    it('leaves Ctrl+F and Ctrl+G to the terminal (readline, vim, less)', () => {
      expect(resolveTerminalKeyHandling(ctrl('f'), plainShell({ isMac: true }))).toEqual({ action: 'pass-through' });
      expect(resolveTerminalKeyHandling(ctrl('f'), tui({ isMac: true, isCliPanel: false }))).toEqual({ action: 'pass-through' });
      expect(resolveTerminalKeyHandling(ctrl('g'), plainShell({ isMac: true, findOpen: true }))).toEqual({ action: 'pass-through' });
    });
  });

  describe('Windows and Linux', () => {
    it('opens find on Ctrl+F in a plain shell', () => {
      expect(resolveTerminalKeyHandling(ctrl('f'), plainShell())).toEqual({ action: 'release-to-app' });
    });

    it('gives Ctrl+F to a full-screen program first (kitty on or off)', () => {
      expect(resolveTerminalKeyHandling(ctrl('f'), tui({ isCliPanel: false }))).toEqual({ action: 'pass-through' });
      expect(resolveTerminalKeyHandling(ctrl('f'), tui())).toEqual({ action: 'pass-through' });
    });

    it('uses Ctrl+G and Ctrl+Shift+G for find only while the bar is open', () => {
      expect(resolveTerminalKeyHandling(ctrl('g'), plainShell())).toEqual({ action: 'pass-through' });
      expect(resolveTerminalKeyHandling(ctrl('g'), plainShell({ findOpen: true }))).toEqual({ action: 'release-to-app' });
      expect(resolveTerminalKeyHandling(ctrl('g', true), plainShell({ findOpen: true }))).toEqual({ action: 'release-to-app' });
      expect(resolveTerminalKeyHandling(ctrl('g'), tui({ isCliPanel: false, findOpen: true }))).toEqual({ action: 'pass-through' });
    });
  });

  it('passes every find key through when keyboard shortcuts are off', () => {
    for (const isMac of [true, false]) {
      const event = isMac ? cmd('f') : ctrl('f');
      expect(resolveTerminalKeyHandling(event, plainShell({ isMac, keyboardShortcutsEnabled: false }))).toEqual({ action: 'pass-through' });
      expect(resolveTerminalKeyHandling(event, tui({ isMac, keyboardShortcutsEnabled: false }))).toEqual({ action: 'pass-through' });
    }
  });

  it('does not treat Shift+Cmd+F or Alt combinations as find', () => {
    expect(resolveTerminalKeyHandling(cmd('f', true), plainShell({ isMac: true }))).toEqual({ action: 'continue' });
    expect(resolveTerminalKeyHandling(key({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: true }), plainShell())).toEqual({ action: 'continue' });
  });
});
