import { describe, expect, it } from 'vitest';
import {
  areKeyboardShortcutsEnabled,
  isCommandPaletteShortcutEnabled,
  shouldForwardCommandPaletteShortcut,
} from './keyboardShortcuts';

describe('areKeyboardShortcutsEnabled', () => {
  it('defaults to enabled for existing configurations', () => {
    expect(areKeyboardShortcutsEnabled({})).toBe(true);
  });

  it('honors explicit enabled and disabled values', () => {
    expect(areKeyboardShortcutsEnabled({ keyboardShortcutsEnabled: true })).toBe(true);
    expect(areKeyboardShortcutsEnabled({ keyboardShortcutsEnabled: false })).toBe(false);
  });

  it('keeps the Command Palette shortcut as an optional exception', () => {
    expect(isCommandPaletteShortcutEnabled({ keyboardShortcutsEnabled: false })).toBe(true);
    expect(isCommandPaletteShortcutEnabled({
      keyboardShortcutsEnabled: false,
      commandPaletteShortcutEnabled: false,
    })).toBe(false);
    expect(isCommandPaletteShortcutEnabled({
      keyboardShortcutsEnabled: true,
      commandPaletteShortcutEnabled: false,
    })).toBe(true);
  });

  it('forwards only the exact Command Palette chord from embedded panels', () => {
    const config = { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: true };
    const press = (code: string, mods: { shift?: boolean; alt?: boolean }) => ({
      key: code.slice(3).toLowerCase(), code, control: false, meta: true, shift: mods.shift ?? false, alt: mods.alt ?? false,
    });
    expect(shouldForwardCommandPaletteShortcut(config, press('KeyP', { shift: true }), 'mac')).toBe(true);
    expect(shouldForwardCommandPaletteShortcut(config, press('KeyP', {}), 'mac')).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(config, press('KeyP', { shift: true, alt: true }), 'mac')).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(config, press('KeyW', { shift: true }), 'mac')).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(
      { keyboardShortcutsEnabled: false, commandPaletteShortcutEnabled: false },
      press('KeyP', { shift: true }),
      'mac',
    )).toBe(false);
    expect(shouldForwardCommandPaletteShortcut(
      { ...config, keyboardShortcutOverrides: { 'open-command-palette': 'mod+alt+p' } },
      press('KeyP', { alt: true }),
      'mac',
    )).toBe(true);
  });
});
