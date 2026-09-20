import type { AppConfig } from '../types/config';
import {
  buildInterceptionSets,
  effectiveDefaultChord,
  normalizeKeyboardShortcutOverrides,
  resolveEffectiveChord,
  selectProfileOverridesRaw,
} from '../../../shared/utils/keyboardBindings';
import { normalizeShortcutProfileId } from '../../../shared/constants/keyboardShortcutProfiles';
import { chordFromElectronInput, type ElectronKeyboardInputLike } from '../../../shared/utils/keyboardChords';

type ShortcutProfileConfig = Pick<
  AppConfig,
  'keyboardShortcutProfile' | 'keyboardShortcutOverrides' | 'keyboardShortcutProfileOverrides'
>;

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

export function shouldForwardCommandPaletteShortcut(
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled'> & ShortcutProfileConfig,
  input: ElectronKeyboardInputLike,
): boolean {
  return isCommandPaletteShortcutEnabled(config)
    && chordFromElectronInput(input) === effectiveChordFor(config, 'open-command-palette');
}

function effectiveChordFor(config: ShortcutProfileConfig, id: string): string | null {
  const profile = normalizeShortcutProfileId(config.keyboardShortcutProfile);
  const { overrides } = normalizeKeyboardShortcutOverrides(selectProfileOverridesRaw(config, profile));
  return resolveEffectiveChord(id, overrides, effectiveDefaultChord(id, profile, process.platform));
}

export function buildWebviewForwardSet(
  config: Pick<AppConfig, 'terminalShortcuts' | 'customCommands'> & ShortcutProfileConfig,
): Set<string> {
  const profile = normalizeShortcutProfileId(config.keyboardShortcutProfile);
  return buildInterceptionSets({
    overrides: selectProfileOverridesRaw(config, profile),
    terminalShortcuts: config.terminalShortcuts,
    customCommands: config.customCommands,
    profile,
    hostPlatform: process.platform,
  }).webviewForward;
}

export function shouldForwardWebviewInput(
  input: ElectronKeyboardInputLike & { type: string },
  forwardSet: ReadonlySet<string>,
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled'> & ShortcutProfileConfig,
): boolean {
  if (input.type !== 'keyDown') return false;
  if (!areKeyboardShortcutsEnabled(config)) {
    return shouldForwardCommandPaletteShortcut(config, input);
  }
  const isAltGr = input.control && input.alt && !input.meta
    && !/^(Key[A-Z]|Digit[0-9]|Slash)$/.test(input.code);
  return !isAltGr && forwardSet.has(chordFromElectronInput(input));
}
