import type { AppConfig } from '../types/config';
import { normalizeKeyboardShortcutOverrides, resolveEffectiveChord } from '../../../shared/utils/keyboardBindings';
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
export function effectiveChordFor(
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
 * Whether a press in Pane's own window is the Close Tab key, which main
 * takes before Electron's menu can close the window (⌘W / Ctrl+W by default).
 */
export function isCloseTabInput(
  config: Pick<AppConfig, 'keyboardShortcutOverrides'>,
  input: ElectronKeyboardInputLike,
  platform: KeyPlatform = keyPlatformFor(process.platform),
): boolean {
  const chord = chordFromElectronInput(input, platform);
  return chord !== '' && chord === effectiveChordFor(config, 'close-active-tab', platform);
}
