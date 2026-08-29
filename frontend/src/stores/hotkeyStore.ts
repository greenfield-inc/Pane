/** Global hotkey registry backed by the shared shortcut catalog. */
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
import { chordFromKeyboardEvent, type KeyboardEventLike } from '../../../shared/utils/keyboardChords';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';

export interface HotkeyDefinition {
  id: HotkeyId;
  label: string;
  keys?: string;
  category: ShortcutCategory;
  action: () => void;
  devOnly?: boolean;
  enabled?: () => boolean;
  disabledReason?: () => string | null;
  showInPalette?: boolean;
  allowInModal?: boolean;
  allowInXterm?: boolean;
}

interface EffectiveHotkeyDefinition extends Omit<HotkeyDefinition, 'keys'> {
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

interface RebuiltHotkeyIndex {
  next: Map<string, EffectiveHotkeyDefinition>;
  index: Map<string, HotkeyId[]>;
}

let listenerAttached = false;
let lookupIndex = new Map<string, HotkeyId[]>();
const initialConfig = useConfigStore.getState().config;
let interceptionSets = buildInterceptionSets({
  overrides: initialConfig?.keyboardShortcutOverrides,
  terminalShortcuts: initialConfig?.terminalShortcuts,
  customCommands: initialConfig?.customCommands,
});

function currentOverrides() {
  return normalizeKeyboardShortcutOverrides(
    useConfigStore.getState().config?.keyboardShortcutOverrides,
  ).overrides;
}

function rebuildIndex(hotkeys: Map<string, EffectiveHotkeyDefinition>): RebuiltHotkeyIndex {
  const overrides = currentOverrides();
  const next = new Map<string, EffectiveHotkeyDefinition>();
  const index = new Map<string, HotkeyId[]>();
  for (const [id, definition] of hotkeys) {
    const catalogDefault = getCatalogEntry(id)?.defaultChord;
    const chord = resolveEffectiveChord(
      id,
      overrides,
      catalogDefault === undefined ? definition.registeredKeys ?? null : catalogDefault,
    );
    const effective = { ...definition, keys: chord ?? '' };
    next.set(id, effective);
    if (!chord) continue;
    const candidates = index.get(chord) ?? [];
    candidates.push(definition.id);
    index.set(chord, candidates);
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

function enabledCandidates(event: KeyboardEvent): EffectiveHotkeyDefinition[] {
  const chord = chordFromKeyboardEvent(event);
  const ids = lookupIndex.get(chord) ?? [];
  const hotkeys = useHotkeyStore.getState().hotkeys;
  return ids.flatMap(id => {
    const definition = hotkeys.get(id);
    return definition && isGloballyAllowed(id) && isDefinitionEnabled(definition)
      ? [definition]
      : [];
  });
}

export function isHotkeyEnabledForEvent(event: KeyboardEvent): boolean {
  return enabledCandidates(event).length === 1;
}

export function isBoundChordForEvent(event: KeyboardEventLike): boolean {
  const chord = chordFromKeyboardEvent(event);
  if (!chord || !interceptionSets.bound.has(chord)) return false;
  const config = useConfigStore.getState().config;
  if (areKeyboardShortcutsEnabled(config)) return true;
  const paletteChord = resolveEffectiveChord(
    'open-command-palette',
    currentOverrides(),
    getCatalogEntry('open-command-palette')?.defaultChord ?? null,
  );
  return isCommandPaletteShortcutEnabled(config) && chord === paletteChord;
}

export function isTuiReleasableChordForEvent(event: KeyboardEventLike): boolean {
  const chord = chordFromKeyboardEvent(event);
  return Boolean(chord && interceptionSets.tuiReleasable.has(chord));
}

function isXtermHelperTarget(target: HTMLElement): boolean {
  return target.classList.contains('xterm-helper-textarea') || target.closest('.xterm') !== null;
}

function passesFocusRules(
  event: KeyboardEvent,
  pressed: string,
  definition: EffectiveHotkeyDefinition,
): boolean {
  // SAFETY: This handler is installed only on the DOM window keydown event.
  const target = event.target as HTMLElement;
  const isInput = target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.isContentEditable;
  if (target.closest('[aria-modal="true"]') !== null && !definition.allowInModal) return false;
  if (isInput && !isXtermHelperTarget(target) && (pressed === 'mod+a' || pressed === 'mod+d')) return false;
  return !(
    isInput
    && !pressed.includes('mod')
    && !(definition.allowInXterm && isXtermHelperTarget(target))
  );
}

function handleKeyDown(event: KeyboardEvent): void {
  const pressed = chordFromKeyboardEvent(event);
  if (!pressed) return;
  const ids = lookupIndex.get(pressed) ?? [];
  const hotkeys = useHotkeyStore.getState().hotkeys;
  const candidates = ids.flatMap(id => {
    const definition = hotkeys.get(id);
    return definition
      && passesFocusRules(event, pressed, definition)
      && isGloballyAllowed(id)
      && isDefinitionEnabled(definition)
      ? [definition]
      : [];
  });

  if (candidates.length > 1) {
    console.warn('[hotkeyStore] Ambiguous chord', pressed, candidates.map(candidate => candidate.id));
    return;
  }
  const definition = candidates[0];
  if (!definition) return;
  event.preventDefault();
  definition.action();
}

function attachListener(): void {
  if (listenerAttached) return;
  window.addEventListener('keydown', handleKeyDown);
  listenerAttached = true;
}

function detachListener(): void {
  if (!listenerAttached) return;
  window.removeEventListener('keydown', handleKeyDown);
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
      || definition.keys?.toLowerCase().includes(lower)
      || definition.id.toLowerCase().includes(lower)
    );
  },
}));

function rebuildForConfig(): void {
  const config = useConfigStore.getState().config;
  interceptionSets = buildInterceptionSets({
    overrides: config?.keyboardShortcutOverrides,
    terminalShortcuts: config?.terminalShortcuts,
    customCommands: config?.customCommands,
  });
  const rebuilt = rebuildIndex(useHotkeyStore.getState().hotkeys);
  lookupIndex = rebuilt.index;
  useHotkeyStore.setState({ hotkeys: rebuilt.next });
}

// Rebuilding is a cheap pass over ~70 catalog rows, so any config change rebuilds
// rather than diffing the three inputs by hand.
useConfigStore.subscribe((state, previous) => {
  if (state.config !== previous.config) rebuildForConfig();
});
