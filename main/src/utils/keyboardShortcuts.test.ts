import { describe, expect, it } from 'vitest';
import {
  activePaneChords,
  areKeyboardShortcutsEnabled,
  isWindowCloseInput,
  menuAcceleratorFor,
  settingsMenuAccelerator,
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

describe('native menu keys follow the effective bindings', () => {
  it('always keeps ⌘W / Ctrl+W from the window, whichever command owns it', () => {
    const w = { key: 'w', code: 'KeyW', control: false, meta: true, shift: false, alt: false };
    expect(isWindowCloseInput(w, 'mac')).toBe(true);
    expect(isWindowCloseInput({ ...w, meta: false, control: true }, 'other')).toBe(true);
    expect(isWindowCloseInput({ ...w, meta: false, control: true }, 'mac')).toBe(false);
  });

  it('lists the keys Pane owns, so a remap onto ⌘H or ⌘W makes the menu step aside', () => {
    const chords = activePaneChords({ keyboardShortcutOverrides: { 'toggle-sidebar': 'mod+h', 'close-active-tab': null } }, 'mac');
    expect(chords.has('mod+h')).toBe(true);
    expect(chords.has('mod+b')).toBe(false);
    expect(chords.has('mod+w')).toBe(false);
    expect(chords.has('mod+k mod+m')).toBe(false);
    expect(activePaneChords({ keyboardShortcutsEnabled: false }, 'mac').size).toBe(0);
  });

  it('shows Open Settings\' current key on the Settings item, and none when it is unassigned', () => {
    expect(settingsMenuAccelerator({}, 'mac')).toBe('CmdOrCtrl+,');
    expect(settingsMenuAccelerator({ keyboardShortcutOverrides: { 'open-settings': 'mod+shift+ArrowUp' } }, 'mac')).toBe('CmdOrCtrl+Shift+Up');
    expect(settingsMenuAccelerator({ keyboardShortcutOverrides: { 'open-settings': null } }, 'mac')).toBeNull();
    expect(menuAcceleratorFor('mod+k mod+s')).toBeNull();
    expect(menuAcceleratorFor('mod+ctrl+]')).toBe('CmdOrCtrl+Ctrl+]');
  });
});
