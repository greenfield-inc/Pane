import type { AppConfig } from '../types/config';
import {
  buildInterceptionSets,
  normalizeKeyboardShortcutOverrides,
  resolveEffectiveChord,
  type InterceptionSets,
} from '../../../shared/utils/keyboardBindings';
import {
  chordFromElectronInput,
  isModifierOnlyKey,
  keyPlatformFor,
  type KeyPlatform,
} from '../../../shared/utils/keyboardChords';
import { areKeyboardShortcutsEnabled, shouldForwardCommandPaletteShortcut } from './keyboardShortcuts';

/**
 * Which keys pressed inside an embedded <webview> page are re-sent to Pane's
 * window. Webviews are separate processes, so their key events never reach
 * the renderer's hotkey listener; main intercepts them in before-input-event.
 * Only Pane's own keys are taken, read from the command catalog and the
 * person's overrides (`forwardFromWebview`), so pages keep Ctrl+R, Ctrl+A and
 * the rest.
 */
export interface WebviewKeyInput {
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

type WebviewKeyConfig = Pick<
  AppConfig,
  'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled' | 'keyboardShortcutOverrides' | 'terminalShortcuts' | 'customCommands'
>;

export interface WebviewKeyContext {
  config: WebviewKeyConfig;
  /** The guest belongs to a browser tab (not the Docs dialog). */
  isBrowserTab: boolean;
  /** That browser tab's Pane find bar is open. */
  findActive: boolean;
  /** Defaults to this computer's platform. */
  platform?: KeyPlatform;
}

/** How long a page's ⌘K waits for a second step that makes it Pane's two-step key. */
export const WEBVIEW_SEQUENCE_TIMEOUT_MS = 2000;

const setsByConfig = new WeakMap<WebviewKeyConfig, Map<KeyPlatform, InterceptionSets>>();

function interceptionSetsFor(config: WebviewKeyConfig, platform: KeyPlatform): InterceptionSets {
  let byPlatform = setsByConfig.get(config);
  if (!byPlatform) {
    byPlatform = new Map();
    setsByConfig.set(config, byPlatform);
  }
  let sets = byPlatform.get(platform);
  if (!sets) {
    sets = buildInterceptionSets({
      overrides: config.keyboardShortcutOverrides,
      terminalShortcuts: config.terminalShortcuts,
      customCommands: config.customCommands,
      keyPlatform: platform,
    });
    byPlatform.set(platform, sets);
  }
  return sets;
}

const FIND_COMMANDS = ['find-in-tab', 'find-next', 'find-previous'] as const;
const findChordsByConfig = new WeakMap<WebviewKeyConfig, Map<KeyPlatform, Set<string>>>();

/**
 * Pane's Find keys (⌘F, ⌘G, ⇧⌘G by default, or the person's remaps) win over
 * a page's own in browser tabs: Electron has no built-in find bar, so leaving
 * the key to the page did nothing on most pages.
 */
function findChordsFor(config: WebviewKeyConfig, platform: KeyPlatform): Set<string> {
  let byPlatform = findChordsByConfig.get(config);
  if (!byPlatform) {
    byPlatform = new Map();
    findChordsByConfig.set(config, byPlatform);
  }
  let chords = byPlatform.get(platform);
  if (!chords) {
    const { overrides } = normalizeKeyboardShortcutOverrides(config.keyboardShortcutOverrides);
    chords = new Set(FIND_COMMANDS.flatMap(id => resolveEffectiveChord(id, overrides, platform) ?? []));
    byPlatform.set(platform, chords);
  }
  return chords;
}

/**
 * Skip AltGr: on Windows/Linux international layouts, AltGr reports
 * control+alt without meta. Only a letter, digit or slash under Ctrl+Alt is a
 * Pane key there; anything else is character input (@, €, \).
 */
function isAltGrInput(input: WebviewKeyInput): boolean {
  if (!input.control || !input.alt || input.meta) return false;
  if (/^(Key[A-Z]|Digit[0-9]|Slash|Arrow(Left|Right|Up|Down))$/.test(input.code)) return false;
  // Ctrl+Alt+Shift+[ and ] are the machine keys off macOS; AltGr brackets come without Shift.
  return !(input.shift && /^Bracket(Left|Right)$/.test(input.code));
}

/** Remembers a page's first step of a two-step key, per guest. */
export interface WebviewSequenceState {
  pending: { input: WebviewKeyInput; chord: string; at: number } | null;
}

export function createWebviewSequenceState(): WebviewSequenceState {
  return { pending: null };
}

/**
 * The keys to send to Pane's window for this press, in order: none (the page
 * keeps it), the press itself, or, for the second step of a two-step key,
 * the remembered first step and then this one. The page keeps a first step
 * (⌘K is many sites' search), so ⌘K alone still works there.
 */
export function webviewKeysToForward(
  input: WebviewKeyInput,
  context: WebviewKeyContext,
  sequence: WebviewSequenceState = createWebviewSequenceState(),
  now: number = Date.now(),
): WebviewKeyInput[] {
  const shortcutsOn = areKeyboardShortcutsEnabled(context.config);

  // Escape closes an open find bar even while the page has focus; otherwise
  // the page keeps it (dialogs, full-screen video).
  if (input.key === 'Escape' && !input.control && !input.meta && !input.alt) {
    sequence.pending = null;
    return shortcutsOn && context.isBrowserTab && context.findActive ? [input] : [];
  }
  if (isModifierOnlyKey(input.key)) return [];

  const platform = context.platform ?? keyPlatformFor(process.platform);
  if (!shortcutsOn) {
    return shouldForwardCommandPaletteShortcut(context.config, input, platform) ? [input] : [];
  }

  if (isAltGrInput(input)) return [];
  const chord = chordFromElectronInput(input, platform);
  if (!chord) return [];
  if (findChordsFor(context.config, platform).has(chord)) {
    sequence.pending = null;
    return context.isBrowserTab ? [input] : [];
  }

  const sets = interceptionSetsFor(context.config, platform);

  const pending = sequence.pending;
  sequence.pending = null;
  if (pending && now - pending.at <= WEBVIEW_SEQUENCE_TIMEOUT_MS
    && sets.webviewSequences.get(pending.chord)?.has(chord)) {
    return [pending.input, input];
  }
  if (sets.webviewSequences.has(chord)) {
    sequence.pending = { input, chord, at: now };
    return [];
  }
  return sets.webviewForward.has(chord) ? [input] : [];
}

/** Whether a press is forwarded on its own (no two-step state). */
export function shouldForwardWebviewKey(input: WebviewKeyInput, context: WebviewKeyContext): boolean {
  return webviewKeysToForward(input, context).length > 0;
}
