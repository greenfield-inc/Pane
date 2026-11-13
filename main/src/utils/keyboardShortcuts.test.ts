import { describe, expect, it } from 'vitest';
import {
  activePaneChords,
  createMenuKeyState,
  menuKeyTakenFromWindow,
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

describe('menuKeyTakenFromWindow: macOS menu keys a Pane command owns (F-2)', () => {
  const press = (code: string, keyName: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean; control?: boolean } = {}) => (
    { type: 'keyDown', key: keyName, code, control: false, meta: false, shift: false, alt: false, ...mods }
  );
  const cmdH = press('KeyH', 'h', { meta: true });
  const cmdK = press('KeyK', 'k', { meta: true });
  const cmdM = press('KeyM', 'm', { meta: true });
  const cmdC = press('KeyC', 'c', { meta: true });
  const cmdQ = press('KeyQ', 'q', { meta: true });
  const cmdComma = press('Comma', ',', { meta: true });
  const cmdSemicolon = press('Semicolon', ';', { meta: true });

  it('takes ⌘H from Hide Pane once Toggle Sidebar is bound to it, and leaves it to the menu otherwise', () => {
    const remapped = { keyboardShortcutOverrides: { 'toggle-sidebar': 'mod+h' } };
    expect(menuKeyTakenFromWindow(cmdH, remapped, createMenuKeyState(), 0, 'mac')).toBe(true);
    expect(menuKeyTakenFromWindow(cmdH, {}, createMenuKeyState(), 0, 'mac')).toBe(false);
    expect(menuKeyTakenFromWindow(cmdH, { ...remapped, keyboardShortcutsEnabled: false }, createMenuKeyState(), 0, 'mac')).toBe(false);
    // ⌘Q stays Quit: no Pane command owns it.
    expect(menuKeyTakenFromWindow(cmdQ, remapped, createMenuKeyState(), 0, 'mac')).toBe(false);
  });

  it('takes the second step of ⌘K ⌘M from Window › Minimize, but not a plain ⌘M', () => {
    const state = createMenuKeyState();
    expect(menuKeyTakenFromWindow(cmdK, {}, state, 1_000, 'mac')).toBe(false);
    expect(menuKeyTakenFromWindow(cmdM, {}, state, 1_100, 'mac')).toBe(true);
    expect(menuKeyTakenFromWindow(cmdM, {}, state, 1_200, 'mac')).toBe(false);
    const late = createMenuKeyState();
    menuKeyTakenFromWindow(cmdK, {}, late, 1_000, 'mac');
    expect(menuKeyTakenFromWindow(cmdM, {}, late, 4_000, 'mac')).toBe(false);
  });

  it('follows Open Settings onto the Settings item\'s key', () => {
    expect(menuKeyTakenFromWindow(cmdComma, {}, createMenuKeyState(), 0, 'mac')).toBe(true);
    const moved = { keyboardShortcutOverrides: { 'open-settings': 'mod+;' } };
    expect(menuKeyTakenFromWindow(cmdSemicolon, moved, createMenuKeyState(), 0, 'mac')).toBe(true);
    expect(menuKeyTakenFromWindow(cmdComma, moved, createMenuKeyState(), 0, 'mac')).toBe(false);
  });

  it('leaves text-editing keys to the Edit menu even when a Pane command is bound to them', () => {
    const onCopy = { keyboardShortcutOverrides: { 'toggle-sidebar': 'mod+c' } };
    expect(menuKeyTakenFromWindow(cmdC, onCopy, createMenuKeyState(), 0, 'mac')).toBe(false);
  });

  it('takes nothing off macOS, where there is no menu bar', () => {
    const remapped = { keyboardShortcutOverrides: { 'toggle-sidebar': 'mod+h' } };
    expect(menuKeyTakenFromWindow({ ...cmdH, meta: false, control: true }, remapped, createMenuKeyState(), 0, 'other')).toBe(false);
  });
});
