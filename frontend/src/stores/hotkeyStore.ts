/**
 * Global hotkey registry backed by the shared command catalog.
 *
 * Components register commands with `useHotkey`; the key each answers to
 * comes from the catalog default for this keyboard, or the person's
 * `keyboardShortcutOverrides` (shared/utils/keyboardBindings.ts). One window
 * keydown listener dispatches them.
 *
 * Rules on every press:
 * - Inside `[aria-modal="true"]`, only commands with `allowInModal` run.
 * - Typing wins (D-236): in a text field, plain letters, arrows, Space, Enter
 *   and Esc belong to the field; chords with Cmd/Ctrl and function keys still
 *   reach Pane, except the field's own editing keys (select all, undo, redo,
 *   copy, cut, paste).
 * - A chord bound to two enabled commands runs neither (and warns).
 * - Two-step keys (D-250): the first step arms a pending state, shown by the
 *   key hint; the second step runs the command, and anything else or a short
 *   timeout cancels quietly.
 */
import { create } from 'zustand';
import {
  getCatalogEntry,
  type HotkeyId,
  type ShortcutCategory,
} from '../../../shared/constants/keyboardShortcuts';
import {
  buildInterceptionSets,
  normalizeKeyboardShortcutOverrides,
  resolveEffectiveChord,
} from '../../../shared/utils/keyboardBindings';
import {
  bindingSteps,
  chordForPlatform,
  chordFromKeyboardEvent,
  isModifierOnlyKey,
  parseChord,
  type KeyPlatform,
  type KeyboardEventLike,
} from '../../../shared/utils/keyboardChords';
import { isMac } from '../utils/platformUtils';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';

export interface HotkeyDefinition {
  id: HotkeyId;
  label: string;
  /** Used only for ids outside the catalog (terminal snippets); catalog rows own their keys. */
  keys?: string;
  category: ShortcutCategory;
  action: () => void;
  devOnly?: boolean;
  /** Is this hotkey currently enabled? Checked on every keypress. */
  enabled?: () => boolean;
  /** Explanation shown when a command is present but unavailable. */
  disabledReason?: () => string | null;
  /** If false, hotkey works but doesn't appear in Command Palette/Help. Defaults to true. */
  showInPalette?: boolean;
  /** Allow this command to run inside a modal focus scope. */
  allowInModal?: boolean;
  /** Allow an unmodified command to run from xterm's helper textarea. */
  allowInXterm?: boolean;
}

export interface EffectiveHotkeyDefinition extends Omit<HotkeyDefinition, 'keys'> {
  /** The binding this command answers to now ('' when unassigned). */
  keys: string;
  registeredKeys?: string;
}

interface GetAllOptions {
  paletteOnly?: boolean;
}

interface HotkeyStore {
  hotkeys: Map<string, EffectiveHotkeyDefinition>;
  register: (def: HotkeyDefinition) => void;
  unregister: (id: string) => void;
  getAll: (options?: GetAllOptions) => EffectiveHotkeyDefinition[];
  getByCategory: (category: ShortcutCategory) => EffectiveHotkeyDefinition[];
  search: (query: string, options?: GetAllOptions) => EffectiveHotkeyDefinition[];
}

/** The first step of a two-step key that is waiting for its second. */
export interface PendingKeySequence {
  first: string;
  startedAt: number;
}

interface KeySequenceStore {
  pending: PendingKeySequence | null;
}

/** Read by the key hint ("⌘K was pressed. Waiting for the second key…"). */
export const useKeySequenceStore = create<KeySequenceStore>(() => ({ pending: null }));

/** How long a two-step key waits for its second step. */
export const KEY_SEQUENCE_TIMEOUT_MS = 2000;

export function rendererKeyPlatform(): KeyPlatform {
  return isMac() ? 'mac' : 'other';
}

let listenerAttached = false;
/** Single chords and the first steps of two-step keys, to the commands they belong to. */
let lookupIndex = new Map<string, HotkeyId[]>();

function interceptionInput() {
  const config = useConfigStore.getState().config;
  return {
    overrides: config?.keyboardShortcutOverrides,
    terminalShortcuts: config?.terminalShortcuts,
    customCommands: config?.customCommands,
    keyPlatform: rendererKeyPlatform(),
  };
}

let interceptionSets = buildInterceptionSets(interceptionInput());

function currentOverrides() {
  return normalizeKeyboardShortcutOverrides(
    useConfigStore.getState().config?.keyboardShortcutOverrides,
  ).overrides;
}

function registeredBinding(keys: string | undefined): string | null {
  if (!keys) return null;
  const parsed = parseChord(keys);
  return parsed.ok ? chordForPlatform(parsed.chord, rendererKeyPlatform()) : null;
}

function rebuildIndex(hotkeys: Map<string, EffectiveHotkeyDefinition>): {
  next: Map<string, EffectiveHotkeyDefinition>;
  index: Map<string, HotkeyId[]>;
} {
  const overrides = currentOverrides();
  const platform = rendererKeyPlatform();
  const next = new Map<string, EffectiveHotkeyDefinition>();
  const index = new Map<string, HotkeyId[]>();
  for (const [id, definition] of hotkeys) {
    const chord = getCatalogEntry(id)
      ? resolveEffectiveChord(id, overrides, platform)
      : registeredBinding(definition.registeredKeys);
    next.set(id, { ...definition, keys: chord ?? '' });
    if (!chord) continue;
    const first = bindingSteps(chord)[0];
    const candidates = index.get(first) ?? [];
    candidates.push(definition.id);
    index.set(first, candidates);
  }
  return { next, index };
}

function isGloballyAllowed(id: HotkeyId): boolean {
  const config = useConfigStore.getState().config;
  return areKeyboardShortcutsEnabled(config)
    || (id === 'open-command-palette' && isCommandPaletteShortcutEnabled(config));
}

function isDefinitionEnabled(definition: EffectiveHotkeyDefinition): boolean {
  if (definition.devOnly && process.env.NODE_ENV !== 'development') return false;
  return !definition.enabled || definition.enabled();
}

/** Enabled commands whose whole binding is `binding`. */
function enabledFor(binding: string): EffectiveHotkeyDefinition[] {
  const first = bindingSteps(binding)[0];
  const ids = lookupIndex.get(first) ?? [];
  const hotkeys = useHotkeyStore.getState().hotkeys;
  return ids.flatMap(id => {
    const definition = hotkeys.get(id);
    return definition
      && definition.keys === binding
      && isGloballyAllowed(id)
      && isDefinitionEnabled(definition)
      ? [definition]
      : [];
  });
}

/** Enabled commands whose binding is a two-step key starting with `first`. */
function enabledSequencesFrom(first: string): EffectiveHotkeyDefinition[] {
  const ids = lookupIndex.get(first) ?? [];
  const hotkeys = useHotkeyStore.getState().hotkeys;
  return ids.flatMap(id => {
    const definition = hotkeys.get(id);
    return definition
      && bindingSteps(definition.keys).length === 2
      && isGloballyAllowed(id)
      && isDefinitionEnabled(definition)
      ? [definition]
      : [];
  });
}

export function chordForEvent(event: KeyboardEventLike): string {
  return chordFromKeyboardEvent(event, rendererKeyPlatform());
}

export function isHotkeyEnabledForEvent(event: KeyboardEvent): boolean {
  const chord = chordForEvent(event);
  if (!chord) return false;
  if (pendingSequence) return enabledFor(`${pendingSequence.first} ${chord}`).length === 1;
  return enabledFor(chord).length === 1 || enabledSequencesFrom(chord).length > 0;
}

export function isBoundChordForEvent(event: KeyboardEventLike): boolean {
  const chord = chordForEvent(event);
  if (!chord) return false;
  if (!interceptionSets.bound.has(chord) && !interceptionSets.sequences.has(chord)) return false;
  const config = useConfigStore.getState().config;
  if (areKeyboardShortcutsEnabled(config)) return true;
  return isCommandPaletteShortcutEnabled(config)
    && chord === resolveEffectiveChord('open-command-palette', currentOverrides(), rendererKeyPlatform());
}

export function isTuiReleasableChordForEvent(event: KeyboardEventLike): boolean {
  const chord = chordForEvent(event);
  return Boolean(chord && interceptionSets.tuiReleasable.has(chord));
}

// --- Two-step keys ---

interface ArmedSequence extends PendingKeySequence {
  timer: ReturnType<typeof setTimeout>;
  /** Runs when the sequence ends without a command (timeout, another key, or released modifier). */
  onUnmatched?: () => void;
  /** End the sequence when its modifier is released (the terminal's ⌘K). */
  cancelOnModifierRelease: boolean;
}

let pendingSequence: ArmedSequence | null = null;

export function isKeySequencePending(): boolean {
  return pendingSequence !== null;
}

/** Whether `event` starts an enabled two-step key. */
export function startsKeySequence(event: KeyboardEventLike): boolean {
  const chord = chordForEvent(event);
  return Boolean(chord) && !pendingSequence && enabledSequencesFrom(chord).length > 0;
}

function endSequence(matched: boolean): void {
  const ended = pendingSequence;
  if (!ended) return;
  clearTimeout(ended.timer);
  pendingSequence = null;
  useKeySequenceStore.setState({ pending: null });
  if (!matched) ended.onUnmatched?.();
}

/**
 * Arms a two-step key from `first`. The terminal calls this for ⌘K so that
 * ⌘K ⌘M still maximizes while ⌘K alone clears it (D-250).
 */
export function armKeySequence(
  first: string,
  options: { onUnmatched?: () => void; cancelOnModifierRelease?: boolean } = {},
): void {
  endSequence(false);
  const startedAt = Date.now();
  pendingSequence = {
    first,
    startedAt,
    onUnmatched: options.onUnmatched,
    cancelOnModifierRelease: options.cancelOnModifierRelease ?? false,
    timer: setTimeout(() => endSequence(false), KEY_SEQUENCE_TIMEOUT_MS),
  };
  useKeySequenceStore.setState({ pending: { first, startedAt } });
}

export function cancelKeySequence(): void {
  endSequence(false);
}

function targetOf(event: KeyboardEvent): HTMLElement | null {
  const target = event.target;
  if (!target || typeof target !== 'object' || !('closest' in target)) return null;
  // SAFETY: these listeners are installed only for DOM keyboard events on window,
  // and the closest() check above rules out window and document targets.
  return target as HTMLElement;
}

function isXtermHelperTarget(target: HTMLElement): boolean {
  return target.classList.contains('xterm-helper-textarea') || target.closest('.xterm') !== null;
}

function isTextField(target: HTMLElement | null): boolean {
  if (!target) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

/** Keys a text field keeps for its own editing, whatever they are bound to. */
const FIELD_EDITING_CHORDS = new Set([
  'mod+a', 'mod+d', 'mod+z', 'mod+shift+z', 'mod+c', 'mod+x', 'mod+v',
]);

function passesFocusRules(
  event: KeyboardEvent,
  pressed: string,
  definition: EffectiveHotkeyDefinition,
  { secondStep }: { secondStep: boolean },
): boolean {
  const target = targetOf(event);
  if (!target) return true;
  if (target.closest('[aria-modal="true"]') !== null && !definition.allowInModal) return false;
  if (!isTextField(target)) return true;
  const xterm = isXtermHelperTarget(target);
  if (!xterm && FIELD_EDITING_CHORDS.has(pressed) && !secondStep) return false;
  const hasCommandModifier = /(^|\+)(mod|ctrl)\+/.test(pressed);
  const isFunctionKey = /(^|\+)F\d{1,2}$/.test(pressed);
  if (hasCommandModifier || isFunctionKey) return true;
  return Boolean((definition.allowInXterm || interceptionSets.bound.has(pressed)) && xterm);
}

function runSingle(event: KeyboardEvent, pressed: string): boolean {
  const ids = lookupIndex.get(pressed) ?? [];
  if (ids.length === 0) return false;
  const hotkeys = useHotkeyStore.getState().hotkeys;
  const candidates: EffectiveHotkeyDefinition[] = [];
  const sequences: EffectiveHotkeyDefinition[] = [];
  for (const id of ids) {
    const definition = hotkeys.get(id);
    if (!definition
      || !passesFocusRules(event, pressed, definition, { secondStep: false })
      || !isGloballyAllowed(id)
      || !isDefinitionEnabled(definition)) continue;
    if (definition.keys === pressed) candidates.push(definition);
    else sequences.push(definition);
  }

  if (sequences.length > 0 && candidates.length === 0) {
    event.preventDefault();
    armKeySequence(pressed);
    return true;
  }
  if (candidates.length + sequences.length > 1) {
    console.warn('[hotkeyStore] Ambiguous chord', pressed, [...candidates, ...sequences].map(candidate => candidate.id));
    return false;
  }
  const definition = candidates[0];
  if (!definition) return false;
  event.preventDefault();
  definition.action();
  return true;
}

function handleKeyDown(event: KeyboardEvent): void {
  if (pendingSequence) return;
  const pressed = chordForEvent(event);
  if (!pressed) return;
  runSingle(event, pressed);
}

/**
 * The second step is read in the capture phase so a field or the palette
 * cannot swallow it first.
 */
function handleSequenceKeyDown(event: KeyboardEvent): void {
  const pending = pendingSequence;
  if (!pending || isModifierOnlyKey(event.key)) return;
  const pressed = chordForEvent(event);
  if (!pressed) return;
  const binding = `${pending.first} ${pressed}`;
  const candidates = enabledFor(binding).filter(definition =>
    passesFocusRules(event, pressed, definition, { secondStep: true })
  );
  if (candidates.length !== 1) {
    // Unknown second key: cancel quietly and let the key do what it does.
    endSequence(false);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  endSequence(true);
  candidates[0].action();
}

function handleKeyUp(event: KeyboardEvent): void {
  const pending = pendingSequence;
  if (!pending?.cancelOnModifierRelease) return;
  const modifierKey = rendererKeyPlatform() === 'mac' ? 'Meta' : 'Control';
  if (event.key === modifierKey) endSequence(false);
}

function attachListener(): void {
  if (listenerAttached || typeof window === 'undefined') return;
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keydown', handleSequenceKeyDown, true);
  window.addEventListener('keyup', handleKeyUp, true);
  listenerAttached = true;
}

function detachListener(): void {
  if (!listenerAttached) return;
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keydown', handleSequenceKeyDown, true);
  window.removeEventListener('keyup', handleKeyUp, true);
  listenerAttached = false;
}

export const useHotkeyStore = create<HotkeyStore>((set, get) => ({
  hotkeys: new Map(),

  register: (definition) => {
    set(state => {
      const registered = new Map(state.hotkeys);
      registered.set(definition.id, {
        ...definition,
        keys: '',
        registeredKeys: definition.keys,
      });
      const rebuilt = rebuildIndex(registered);
      lookupIndex = rebuilt.index;
      attachListener();
      return { hotkeys: rebuilt.next };
    });
  },

  unregister: (id) => {
    set(state => {
      if (!state.hotkeys.has(id)) return state;
      const registered = new Map(state.hotkeys);
      registered.delete(id);
      const rebuilt = rebuildIndex(registered);
      lookupIndex = rebuilt.index;
      if (rebuilt.next.size === 0) detachListener();
      return { hotkeys: rebuilt.next };
    });
  },

  getAll: (options) => {
    let results = [...get().hotkeys.values()].filter(
      definition => !definition.devOnly || process.env.NODE_ENV === 'development',
    );
    if (options?.paletteOnly) {
      results = results.filter(definition => definition.showInPalette !== false);
    }
    return results;
  },

  getByCategory: (category) => get().getAll().filter(definition => definition.category === category),

  search: (query, options) => {
    const lower = query.toLowerCase();
    return get().getAll(options).filter(definition =>
      definition.label.toLowerCase().includes(lower)
      || definition.keys.toLowerCase().includes(lower)
      || definition.id.toLowerCase().includes(lower)
    );
  },
}));

function rebuildForConfig(): void {
  interceptionSets = buildInterceptionSets(interceptionInput());
  const rebuilt = rebuildIndex(useHotkeyStore.getState().hotkeys);
  lookupIndex = rebuilt.index;
  useHotkeyStore.setState({ hotkeys: rebuilt.next });
}

// Rebuilding is a cheap pass over ~100 catalog rows, so any config change
// rebuilds rather than diffing the three inputs by hand.
useConfigStore.subscribe((state, previous) => {
  if (state.config !== previous.config) rebuildForConfig();
});
