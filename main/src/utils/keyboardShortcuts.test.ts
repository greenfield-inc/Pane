import { describe, expect, it } from 'vitest';
import {
  areKeyboardShortcutsEnabled,
  buildWebviewForwardSet,
  isCommandPaletteShortcutEnabled,
  shouldForwardCommandPaletteShortcut,
  shouldForwardWebviewInput,
} from './keyboardShortcuts';

const input = (overrides: Partial<{
  type: string; key: string; code: string; control: boolean; meta: boolean; shift: boolean; alt: boolean;
}> = {}) => ({
  type: 'keyDown', key: 'p', code: 'KeyP', control: true, meta: false, shift: false, alt: false,
  ...overrides,
});

const LEGACY_PANE_HOTKEYS = Object.freeze([
  'b', ',', 'n', 'a', 'd', 'w', 't', '`',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'Tab', 'ArrowDown', 'ArrowUp',
]);

const LEGACY_PANE_SHIFT_CODES = Object.freeze([
  'KeyE', 'KeyN', 'KeyK', 'KeyP', 'KeyZ', 'KeyL', 'KeyR', 'KeyM', 'KeyU',
  'KeyB', 'KeyW', 'KeyD',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Tab',
]);

function codeForKey(key: string): string {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[1-9]$/.test(key)) return `Digit${key}`;
  if (key === ',') return 'Comma';
  if (key === '`') return 'Backquote';
  return key;
}

function keyForShiftCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return '!';
  return code;
}

describe('keyboard shortcut forwarding', () => {
  it('preserves global enable defaults and the palette exception', () => {
    expect(areKeyboardShortcutsEnabled({})).toBe(true);
    expect(isCommandPaletteShortcutEnabled({ keyboardShortcutsEnabled: false })).toBe(true);
    expect(isCommandPaletteShortcutEnabled({
      keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false,
    })).toBe(false);
  });

  it('resolves the palette exception from its effective chord', () => {
    const config = {
      keyboardShortcutsEnabled: false,
      commandPaletteShortcutEnabled: true,
      keyboardShortcutOverrides: { 'open-command-palette': 'mod+alt+p' },
    };
    expect(shouldForwardCommandPaletteShortcut(config, input({ alt: true }))).toBe(true);
    expect(shouldForwardCommandPaletteShortcut(config, input({ shift: true }))).toBe(false);
  });

  it('forwards every legacy unshifted Pane hotkey with default config', () => {
    const config = {};
    const forwardSet = buildWebviewForwardSet(config);
    for (const key of LEGACY_PANE_HOTKEYS) {
      expect(
        shouldForwardWebviewInput(input({ key, code: codeForKey(key) }), forwardSet, config),
        `mod+${key}`,
      ).toBe(true);
    }
  });

  it('forwards every legacy shifted Pane physical key with default config', () => {
    const config = {};
    const forwardSet = buildWebviewForwardSet(config);
    for (const code of LEGACY_PANE_SHIFT_CODES) {
      expect(
        shouldForwardWebviewInput(
          input({ key: keyForShiftCode(code), code, shift: true }),
          forwardSet,
          config,
        ),
        `mod+shift+${code}`,
      ).toBe(true);
    }
  });

  it('forwards configured catalog chords and removes old/null bindings', () => {
    const config = { keyboardShortcutOverrides: { 'add-tool-terminal-claude': 'mod+alt+7' } };
    const set = buildWebviewForwardSet(config);
    expect(shouldForwardWebviewInput(input({ key: '7', code: 'Digit7', alt: true }), set, config)).toBe(true);
    expect(shouldForwardWebviewInput(input({ key: '3', code: 'Digit3', alt: true }), set, config)).toBe(false);
    const unassigned = { keyboardShortcutOverrides: { 'add-tool-terminal-claude': null } };
    expect(shouldForwardWebviewInput(
      input({ key: '3', code: 'Digit3', alt: true }), buildWebviewForwardSet(unassigned), unassigned,
    )).toBe(false);
  });

  it.each([
    ['split right', input({ key: '\\', code: 'Backslash' })],
    ['split down', input({ key: '|', code: 'Backslash', shift: true })],
    ['usage share', input({ key: 'S', code: 'KeyS', shift: true })],
    ['browser find', input({ key: 'f', code: 'KeyF' })],
    ['browser reload', input({ key: 'r', code: 'KeyR' })],
    ['browser location', input({ key: 'l', code: 'KeyL' })],
    ['unowned alt', input({ key: 'w', code: 'KeyW', alt: true })],
  ])('does not forward %s', (_label, event) => {
    const config = {};
    expect(shouldForwardWebviewInput(event, buildWebviewForwardSet(config), config)).toBe(false);
  });

  it('forwards custom slots and enabled snippets mount-independently', () => {
    const config = { terminalShortcuts: [{ id: 'q', key: 'q', enabled: true }] };
    const set = buildWebviewForwardSet(config);
    expect(shouldForwardWebviewInput(input({ key: '6', code: 'Digit6', alt: true }), set, config)).toBe(true);
    expect(shouldForwardWebviewInput(input({ key: 'q', code: 'KeyQ', alt: true }), set, config)).toBe(true);
  });

  it('preserves the AltGr heuristic and disabled-shortcuts gate', () => {
    const config = { keyboardShortcutsEnabled: false };
    const set = buildWebviewForwardSet(config);
    expect(shouldForwardWebviewInput(input({ key: '@', code: 'BracketLeft', alt: true }), set, config)).toBe(false);
    expect(shouldForwardWebviewInput(input({ key: 'P', code: 'KeyP', shift: true }), set, config)).toBe(true);
    expect(shouldForwardWebviewInput(input({ key: 'b', code: 'KeyB' }), set, config)).toBe(false);
  });
});
