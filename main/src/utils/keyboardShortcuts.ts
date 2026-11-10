import type { AppConfig } from '../types/config';
import { collectActiveBindings, normalizeKeyboardShortcutOverrides, resolveEffectiveChord } from '../../../shared/utils/keyboardBindings';
import {
  chordFromElectronInput,
  keyPlatformFor,
  type ElectronKeyboardInputLike,
  type KeyPlatform,
} from '../../../shared/utils/keyboardChords';

export function areKeyboardShortcutsEnabled(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled'>,
): boolean {
  return config.keyboardShortcutsEnabled !== false;
}

export function isCommandPaletteShortcutEnabled(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled'>,
): boolean {
  return areKeyboardShortcutsEnabled(config) || config.commandPaletteShortcutEnabled !== false;
}

/** The binding a catalog command answers to on this computer, with the person's overrides. */
function effectiveChordFor(
  config: Pick<AppConfig, 'keyboardShortcutOverrides'>,
  id: string,
  platform: KeyPlatform = keyPlatformFor(process.platform),
): string | null {
  const { overrides } = normalizeKeyboardShortcutOverrides(config.keyboardShortcutOverrides);
  return resolveEffectiveChord(id, overrides, platform);
}

export function shouldForwardCommandPaletteShortcut(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled' | 'keyboardShortcutOverrides'>,
  input: ElectronKeyboardInputLike,
  platform: KeyPlatform = keyPlatformFor(process.platform),
): boolean {
  return isCommandPaletteShortcutEnabled(config)
    && chordFromElectronInput(input, platform) === effectiveChordFor(config, 'open-command-palette', platform);
}

/**
 * Whether a press in Pane's own window is the native window-close key (⌘W,
 * Ctrl+W). Main always keeps it from closing the window while Pane's keys are
 * on, whichever command owns it now, and hands it to the renderer.
 */
export function isWindowCloseInput(
  input: ElectronKeyboardInputLike,
  platform: KeyPlatform = keyPlatformFor(process.platform),
): boolean {
  return chordFromElectronInput(input, platform) === 'mod+w';
}

/** Every single-step key a Pane command answers to now, so native menu items can step aside. */
export function activePaneChords(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'keyboardShortcutOverrides' | 'terminalShortcuts' | 'customCommands'>,
  platform: KeyPlatform = keyPlatformFor(process.platform),
): Set<string> {
  if (!areKeyboardShortcutsEnabled(config)) return new Set();
  return new Set(collectActiveBindings({
    overrides: config.keyboardShortcutOverrides,
    terminalShortcuts: config.terminalShortcuts,
    customCommands: config.customCommands,
    keyPlatform: platform,
  }).map(binding => binding.chord).filter(chord => !chord.includes(' ')));
}

const ACCELERATOR_KEYS = new Map([
  ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
  ['Escape', 'Esc'], ['Enter', 'Return'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
]);

/** A single-step binding as an Electron menu accelerator; null for two-step keys or none. */
export function menuAcceleratorFor(binding: string | null): string | null {
  if (!binding || binding.includes(' ')) return null;
  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map(part => (
    part === 'mod' ? 'CmdOrCtrl' : part === 'ctrl' ? 'Ctrl' : part === 'alt' ? 'Alt' : 'Shift'
  ));
  const named = ACCELERATOR_KEYS.get(key) ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...modifiers, named].join('+');
}

/** The Settings menu item's key: Open Settings' binding now. */
export function settingsMenuAccelerator(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'keyboardShortcutOverrides'>,
  platform: KeyPlatform = keyPlatformFor(process.platform),
): string | null {
  if (!areKeyboardShortcutsEnabled(config)) return null;
  return menuAcceleratorFor(effectiveChordFor(config, 'open-settings', platform));
}
