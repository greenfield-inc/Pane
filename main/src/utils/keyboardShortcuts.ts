import type { AppConfig } from '../types/config';
import { buildInterceptionSets, normalizeKeyboardShortcutOverrides, resolveEffectiveChord } from '../../../shared/utils/keyboardBindings';
import { getCatalogEntry } from '../../../shared/constants/keyboardShortcuts';
import { chordFromElectronInput, type ElectronKeyboardInputLike } from '../../../shared/utils/keyboardChords';

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
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled' | 'keyboardShortcutOverrides'>,
  input: ElectronKeyboardInputLike,
): boolean {
  return isCommandPaletteShortcutEnabled(config)
    && chordFromElectronInput(input) === effectiveChordFor(config, 'open-command-palette');
}

function effectiveChordFor(config: Pick<AppConfig, 'keyboardShortcutOverrides'>, id: string): string | null {
  const { overrides } = normalizeKeyboardShortcutOverrides(config.keyboardShortcutOverrides);
  return resolveEffectiveChord(id, overrides, getCatalogEntry(id)?.defaultChord ?? null);
}

export function buildWebviewForwardSet(
  config: Pick<AppConfig, 'keyboardShortcutOverrides' | 'terminalShortcuts' | 'customCommands'>,
): Set<string> {
  return buildInterceptionSets({
    overrides: config.keyboardShortcutOverrides,
    terminalShortcuts: config.terminalShortcuts,
    customCommands: config.customCommands,
  }).webviewForward;
}

export function shouldForwardWebviewInput(
  input: ElectronKeyboardInputLike & { type: string },
  forwardSet: ReadonlySet<string>,
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled' | 'keyboardShortcutOverrides'>,
): boolean {
  if (input.type !== 'keyDown' || (!input.control && !input.meta)) return false;
  if (!areKeyboardShortcutsEnabled(config)) {
    return shouldForwardCommandPaletteShortcut(config, input);
  }
  const isAltGr = input.control && input.alt && !input.meta
    && !/^(Key[A-Z]|Digit[0-9]|Slash)$/.test(input.code);
  return !isAltGr && forwardSet.has(chordFromElectronInput(input));
}
