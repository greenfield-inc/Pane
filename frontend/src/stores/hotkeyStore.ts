/**
 * Global hotkey registry store using Zustand.
 *
 * Manages application-wide keyboard shortcuts with features:
 * - Centralized registration/unregistration via `register()` and `unregister()`
 * - Automatic conflict detection with console warnings in dev mode
 * - Category-based organization for Help dialog grouping
 * - Search/filter functionality for Command Palette
 * - Conditional enabling via `enabled` callbacks checked on every keypress
 * - Platform-aware key normalization (Ctrl/Cmd → 'mod')
 * - Support for hiding alternative shortcuts from UI via `showInPalette`
 *
 * @example
 * ```tsx
 * const { register, unregister } = useHotkeyStore();
 *
 * useEffect(() => {
 *   register({
 *     id: 'my-action',
 *     label: 'Do Something',
 *     keys: 'mod+k',
 *     category: 'navigation',
 *     action: () => console.log('triggered'),
 *   });
 *   return () => unregister('my-action');
 * }, [register, unregister]);
 * ```
 *
 * @module hotkeyStore
 */
import { create } from 'zustand';
import { areKeyboardShortcutsEnabled, isCommandPaletteShortcutEnabled, useConfigStore } from './configStore';

export interface HotkeyDefinition {
  /** Unique identifier, e.g. 'open-prompt-history' */
  id: string;
  /** Human-readable description for help/command palette */
  label: string;
  /** Key combination string, e.g. 'mod+p', 'mod+shift+n', 'mod+alt+ArrowLeft' */
  keys: string;
  /** Grouping for help dialog display */
  category: 'navigation' | 'session' | 'tabs' | 'view' | 'tools' | 'debug' | 'shortcuts';
  /** The function to execute */
  action: () => void;
  /** Only register in development mode? */
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

interface GetAllOptions {
  paletteOnly?: boolean;
}

interface HotkeyStore {
  hotkeys: Map<string, HotkeyDefinition>;
  register: (def: HotkeyDefinition) => void;
  unregister: (id: string) => void;
  getAll: (options?: GetAllOptions) => HotkeyDefinition[];
  getByCategory: (category: HotkeyDefinition['category']) => HotkeyDefinition[];
  search: (query: string, options?: GetAllOptions) => HotkeyDefinition[];
}

// --- Key matching logic (module-level, not in store) ---

// Canonical modifier order — MUST be identical in both normalize functions
const MODIFIER_ORDER = ['mod', 'alt', 'shift'] as const;

// Punctuation codes resolved via e.code when Alt is held; macOS Option modifies
// e.key for these too (e.g. Option+/ produces '÷' on some layouts)
interface AlternatePunctuationCodes {
  [code: string]: string;
}

const ALT_PUNCTUATION_CODES: AlternatePunctuationCodes = {
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
};

/**
 * Resolve the logical key from e.code for Alt-held combos, where macOS Option
 * translates e.key into a special character (e.g. Option+A produces 'å',
 * Option+1 produces '¡', Option+/ produces '÷' on some layouts).
 * Covers letters, digits, and common punctuation. Returns null when the code
 * isn't one we normalize.
 */
function altKeyFromCode(code: string): string | null {
  const letterMatch = code.match(/^Key([A-Z])$/);
  if (letterMatch) return letterMatch[1].toLowerCase();
  const digitMatch = code.match(/^Digit(\d)$/);
  if (digitMatch) return digitMatch[1];
  return ALT_PUNCTUATION_CODES[code] ?? null;
}

function normalizeKeyEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  // parts is already in canonical order because we push in that order
  // Use e.code for letters/digits/punctuation when alt is held; macOS Option
  // key modifies e.key (e.g. Option+A produces 'å' instead of 'a')
  // Skip AltGr: on Windows/Linux international layouts AltGr sets both ctrlKey+altKey
  // but is used for character input (e.g. AltGr+Q = '@' on German keyboards)
  const isAltGr = e.getModifierState('AltGraph');
  const altCodeKey = e.altKey && !isAltGr ? altKeyFromCode(e.code) : null;
  let key = altCodeKey ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  // Use e.code for digits when shift is held — e.key is layout-dependent
  // (e.g. Shift+2 produces '@' on US, '"' on UK, different on AZERTY)
  const digitMatch = e.shiftKey && e.code.match(/^Digit(\d)$/);
  if (digitMatch) {
    key = digitMatch[1];
  }
  // Use e.code for Backslash — Shift+\ produces '|' on US layout, breaking
  // registration of mod+shift+\ if we use e.key. ISO/international keyboards
  // report the physical key as IntlBackslash instead.
  if (e.code === 'Backslash' || e.code === 'IntlBackslash') {
    key = '\\';
  }
  parts.push(key);
  return parts.join('+');
}

function normalizeHotkeyString(keys: string): string {
  const parts = keys.split('+');
  const modifiers: string[] = [];
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    // SAFETY: The value comes from the adjacent finite domain definition.
    if ((MODIFIER_ORDER as readonly string[]).includes(lower)) {
      modifiers.push(lower);
    } else {
      key = part.length === 1 ? part.toLowerCase() : part;
    }
  }
  modifiers.sort(
    (a, b) =>
      // SAFETY: The value comes from the adjacent finite domain definition.
      (MODIFIER_ORDER as readonly string[]).indexOf(a) -
      // SAFETY: The value comes from the adjacent finite domain definition.
      (MODIFIER_ORDER as readonly string[]).indexOf(b)
  );
  return [...modifiers, key].join('+');
}

let listenerAttached = false;
let lookupIndex: Map<string, string> = new Map(); // normalized keys → hotkey id

export function isHotkeyEnabledForEvent(e: KeyboardEvent): boolean {
  const hotkeyId = lookupIndex.get(normalizeKeyEvent(e));
  if (!hotkeyId) return false;

  const config = useConfigStore.getState().config;
  if (!areKeyboardShortcutsEnabled(config)) {
    if (hotkeyId !== 'open-command-palette' || !isCommandPaletteShortcutEnabled(config)) return false;
  }

  const def = useHotkeyStore.getState().hotkeys.get(hotkeyId);
  if (!def) return false;
  if (def.devOnly && process.env.NODE_ENV !== 'development') return false;
  return !def.enabled || def.enabled();
}

function isXtermHelperTarget(target: HTMLElement): boolean {
  return target.classList.contains('xterm-helper-textarea') || target.closest('.xterm') !== null;
}

function handleKeyDown(e: KeyboardEvent) {
  // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
  const target = e.target as HTMLElement;
  const isInput =
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable;

  const pressed = normalizeKeyEvent(e);
  const hotkeyId = lookupIndex.get(pressed);
  if (!hotkeyId) return;

  const store = useHotkeyStore.getState();
  const def = store.hotkeys.get(hotkeyId);
  if (!def) return;

  // Modal-local commands can opt in, but all other application hotkeys remain
  // suppressed while focus is trapped in a dialog.
  // A full-page surface (Settings) blocks the workspace hotkeys behind it.
  const isInsideModal = target.closest('[aria-modal="true"]') !== null
    || Boolean(globalThis.document?.querySelector('[data-hotkey-scope="modal"]'));
  if (isInsideModal && !def.allowInModal) return;

  // Let native text editing win for shortcuts users expect in focused inputs.
  // In particular, tab cycling uses mod+a/mod+d, but inputs need mod+a
  // for select-all and mod+d for normal browser/text-field behavior.
  if (isInput && !isXtermHelperTarget(target) && (pressed === 'mod+a' || pressed === 'mod+d')) return;

  // Skip if typing in input and shortcut doesn't use mod key
  if (
    isInput
    && !pressed.includes('mod')
    && !(def.allowInXterm && isXtermHelperTarget(target))
  ) return;

  if (!isHotkeyEnabledForEvent(e)) return;

  e.preventDefault();
  def.action();
}

function rebuildIndex(hotkeys: Map<string, HotkeyDefinition>) {
  lookupIndex = new Map();
  for (const [id, def] of hotkeys) {
    if (!def.keys) continue; // Skip palette-only commands with no keybinding
    const normalized = normalizeHotkeyString(def.keys);
    if (process.env.NODE_ENV === 'development' && lookupIndex.has(normalized)) {
      const existingId = lookupIndex.get(normalized);
      console.warn(
        `[hotkeyStore] Conflict: "${def.keys}" registered by "${id}" overwrites "${existingId}"`
      );
    }
    lookupIndex.set(normalized, id);
  }
}

function attachListener() {
  if (!listenerAttached) {
    window.addEventListener('keydown', handleKeyDown);
    listenerAttached = true;
  }
}

function detachListener() {
  if (listenerAttached) {
    window.removeEventListener('keydown', handleKeyDown);
    listenerAttached = false;
  }
}

export const useHotkeyStore = create<HotkeyStore>((set, get) => ({
  hotkeys: new Map(),

  register: (def) => {
    set((state) => {
      const next = new Map(state.hotkeys);
      next.set(def.id, def);
      rebuildIndex(next);
      attachListener();
      return { hotkeys: next };
    });
  },

  unregister: (id) => {
    set((state) => {
      const next = new Map(state.hotkeys);
      next.delete(id);
      rebuildIndex(next);
      if (next.size === 0) detachListener();
      return { hotkeys: next };
    });
  },

  getAll: (options?: GetAllOptions) => {
    const state = get();
    let results = Array.from(state.hotkeys.values()).filter(
      (def) => !def.devOnly || process.env.NODE_ENV === 'development'
    );
    if (options?.paletteOnly) {
      results = results.filter((def) => def.showInPalette !== false);
    }
    return results;
  },

  getByCategory: (category) => {
    return get()
      .getAll()
      .filter((def) => def.category === category);
  },

  search: (query, options?: GetAllOptions) => {
    const lower = query.toLowerCase();
    return get()
      .getAll(options)
      .filter(
        (def) =>
          def.label.toLowerCase().includes(lower) ||
          def.keys.toLowerCase().includes(lower) ||
          def.id.toLowerCase().includes(lower)
      );
  },
}));
