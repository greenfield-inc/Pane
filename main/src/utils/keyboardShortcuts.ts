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

/**
 * Keys macOS's application menu answers (nativeMenus.ts), less Settings…,
 * whose key is Open Settings' own. Keep the two lists in step.
 */
const MAC_MENU_CHORDS = new Set([
  'mod+r', 'mod+shift+r', 'mod+alt+i',
  'mod+h', 'mod+alt+h', 'mod+q',
  'mod+shift+0', 'mod+=', 'mod+-', 'mod+ctrl+f',
  'mod+m', 'mod+w',
]);

/** Edit menu keys stay with text editing even when a Pane command is bound to them. */
const TEXT_EDITING_CHORDS = new Set(['mod+z', 'mod+shift+z', 'mod+x', 'mod+c', 'mod+v', 'mod+alt+shift+v', 'mod+a']);

const MENU_SEQUENCE_TIMEOUT_MS = 2000;

/** The first step of a Pane two-step key pressed in the window, so its second step can be taken from the menu. */
export interface MenuKeyState {
  pending: { chord: string; at: number } | null;
}

export function createMenuKeyState(): MenuKeyState {
  return { pending: null };
}

type MenuKeyConfig = Pick<AppConfig, 'keyboardShortcutsEnabled' | 'keyboardShortcutOverrides' | 'terminalShortcuts' | 'customCommands'>;

interface PaneKeys {
  single: Set<string>;
  sequences: Map<string, Set<string>>;
  settings: string | null;
}

const paneKeysByConfig = new WeakMap<MenuKeyConfig, PaneKeys>();

function paneKeysFor(config: MenuKeyConfig, platform: KeyPlatform): PaneKeys {
  const cached = paneKeysByConfig.get(config);
  if (cached) return cached;
  const keys: PaneKeys = { single: new Set(), sequences: new Map(), settings: effectiveChordFor(config, 'open-settings', platform) };
  for (const { chord } of collectActiveBindings({
    overrides: config.keyboardShortcutOverrides,
    terminalShortcuts: config.terminalShortcuts,
    customCommands: config.customCommands,
    keyPlatform: platform,
  })) {
    const [first, second] = chord.split(' ');
    if (!second) {
      keys.single.add(first);
      continue;
    }
    const seconds = keys.sequences.get(first) ?? new Set<string>();
    seconds.add(second);
    keys.sequences.set(first, seconds);
  }
  paneKeysByConfig.set(config, keys);
  return keys;
}

/**
 * Whether main takes this press from macOS's menu and hands it to the
 * renderer: the menu item's key now belongs to a Pane command, alone or as the
 * second step of a two-step key (⌘K ⌘M against Window › Minimize).
 * `registerAccelerator: false` does nothing on macOS, but preventDefault in
 * before-input-event stops menu shortcuts on every platform.
 */
export function menuKeyTakenFromWindow(
  input: ElectronKeyboardInputLike & { type: string },
  config: MenuKeyConfig,
  state: MenuKeyState,
  now: number = Date.now(),
  platform: KeyPlatform = keyPlatformFor(process.platform),
): boolean {
  if (platform !== 'mac' || input.type !== 'keyDown' || !areKeyboardShortcutsEnabled(config)) return false;
  const chord = chordFromElectronInput(input, platform);
  if (!chord) return false;
  const keys = paneKeysFor(config, platform);
  const pending = state.pending;
  state.pending = keys.sequences.has(chord) ? { chord, at: now } : null;
  const menuKey = (MAC_MENU_CHORDS.has(chord) || chord === keys.settings) && !TEXT_EDITING_CHORDS.has(chord);
  if (!menuKey) return false;
  if (pending && now - pending.at <= MENU_SEQUENCE_TIMEOUT_MS && keys.sequences.get(pending.chord)?.has(chord)) {
    state.pending = null;
    return true;
  }
  return keys.single.has(chord);
}
