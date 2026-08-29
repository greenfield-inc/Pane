import {
  getCatalogEntry,
  KEYBOARD_SHORTCUT_CATALOG,
  scopesOverlap,
  type ShortcutScope,
} from '../constants/keyboardShortcuts';
import { parseChord } from './keyboardChords';
import {
  BoundaryDecodeError,
  boundary,
  decodeBoundary,
  type JsonValue,
} from '../validation/boundaryDecoder';

export type KeyboardShortcutOverrides = Record<string, string | null>;

interface TerminalShortcutBindingInput {
  id: string;
  key: string;
  enabled: boolean;
}

export interface NormalizedKeyboardShortcutOverrides {
  overrides: KeyboardShortcutOverrides;
  diagnostics: string[];
}

export interface InterceptionSets {
  bound: Set<string>;
  tuiReleasable: Set<string>;
  webviewForward: Set<string>;
}

export interface BindingInput {
  overrides?: KeyboardShortcutOverrides | JsonValue;
  terminalShortcuts?: readonly TerminalShortcutBindingInput[] | JsonValue;
  customCommands?: readonly object[] | JsonValue;
  platform?: string;
}

export interface ActiveBinding {
  id: string;
  chord: string;
  scope: ShortcutScope;
}

export interface InterceptionBinding {
  id: string;
  chord: string;
  releaseFromTerminal: boolean;
  releaseInTui: boolean;
  forwardFromWebview: boolean;
}

export function normalizeKeyboardShortcutOverrides(
  raw: KeyboardShortcutOverrides | JsonValue | undefined,
): NormalizedKeyboardShortcutOverrides {
  const overrides: KeyboardShortcutOverrides = {};
  const diagnostics: string[] = [];
  if (raw === undefined) return { overrides, diagnostics };
  let source;
  try {
    source = decodeBoundary(raw, boundary.jsonObject);
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
    return { overrides, diagnostics: ['keyboardShortcutOverrides must be an object'] };
  }

  for (const [id, value] of Object.entries(source)) {
    if (!getCatalogEntry(id)) {
      diagnostics.push(`unknown keyboard shortcut id: ${id}`);
      continue;
    }
    if (value === null) {
      overrides[id] = null;
      continue;
    }
    let chordValue: string;
    try {
      chordValue = decodeBoundary(value, boundary.string);
    } catch (error) {
      if (!(error instanceof BoundaryDecodeError)) throw error;
      diagnostics.push(`keyboard shortcut ${id} must be a string or null`);
      continue;
    }
    const parsed = parseChord(chordValue);
    if (!parsed.ok) {
      diagnostics.push(`invalid keyboard shortcut ${id}: ${parsed.reason}`);
      continue;
    }
    overrides[id] = parsed.chord;
  }
  return { overrides, diagnostics };
}

export function resolveEffectiveChord(
  id: string,
  overrides: KeyboardShortcutOverrides,
  defaultChord: string | null,
): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
  if (defaultChord === null) return null;
  const parsed = parseChord(defaultChord);
  return parsed.ok ? parsed.chord : null;
}

function enabledTerminalShortcuts(
  raw: BindingInput['terminalShortcuts'],
): Array<{ id: string; chord: string }> {
  let values: JsonValue[];
  try {
    values = decodeBoundary(raw, boundary.array(boundary.json));
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
    return [];
  }
  const result: Array<{ id: string; chord: string }> = [];
  for (const item of values) {
    try {
      const shortcut = decodeBoundary(item, boundary.object({
        enabled: boundary.boolean,
        id: boundary.string,
        key: boundary.string,
      }));
      if (!shortcut.enabled) continue;
      const parsed = parseChord(`mod+alt+${shortcut.key}`);
      if (parsed.ok) result.push({ id: `terminal-shortcut-${shortcut.id}`, chord: parsed.chord });
    } catch (error) {
      if (!(error instanceof BoundaryDecodeError)) throw error;
    }
  }
  return result;
}

function customCommandCount(raw: BindingInput['customCommands']): number {
  try {
    return Math.min(decodeBoundary(raw, boundary.array(boundary.json)).length, 4);
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
    return 0;
  }
}

export function collectActiveBindings(input: BindingInput): ActiveBinding[] {
  const { overrides } = normalizeKeyboardShortcutOverrides(input.overrides);
  const customCount = customCommandCount(input.customCommands);
  const bindings: ActiveBinding[] = [];

  for (const catalogEntry of KEYBOARD_SHORTCUT_CATALOG) {
    if (catalogEntry.dynamicSlot && Number(catalogEntry.id.slice(-1)) >= customCount) continue;
    if (catalogEntry.platforms && input.platform && !catalogEntry.platforms.includes(input.platform)) continue;
    const chord = resolveEffectiveChord(catalogEntry.id, overrides, catalogEntry.defaultChord);
    if (chord) bindings.push({ id: catalogEntry.id, chord, scope: catalogEntry.scope });
  }
  for (const shortcut of enabledTerminalShortcuts(input.terminalShortcuts)) {
    bindings.push({ ...shortcut, scope: 'app' });
  }
  return bindings;
}

export function collectInterceptionBindings(input: BindingInput): InterceptionBinding[] {
  const { overrides } = normalizeKeyboardShortcutOverrides(input.overrides);
  const bindings: InterceptionBinding[] = [];
  for (const catalogEntry of KEYBOARD_SHORTCUT_CATALOG) {
    const chord = resolveEffectiveChord(catalogEntry.id, overrides, catalogEntry.defaultChord);
    if (!chord) continue;
    bindings.push({
      id: catalogEntry.id,
      chord,
      releaseFromTerminal: catalogEntry.releaseFromTerminal,
      releaseInTui: catalogEntry.releaseInTui,
      forwardFromWebview: catalogEntry.forwardFromWebview,
    });
  }
  for (const shortcut of enabledTerminalShortcuts(input.terminalShortcuts)) {
    bindings.push({
      ...shortcut,
      releaseFromTerminal: true,
      releaseInTui: false,
      forwardFromWebview: true,
    });
  }
  return bindings;
}

export function findChordConflicts(bindings: readonly ActiveBinding[]): Array<{ chord: string; ids: string[] }> {
  const byChord = new Map<string, ActiveBinding[]>();
  for (const binding of bindings) {
    const group = byChord.get(binding.chord) ?? [];
    group.push(binding);
    byChord.set(binding.chord, group);
  }

  const conflicts: Array<{ chord: string; ids: string[] }> = [];
  for (const [chord, group] of byChord) {
    const ids = new Set<string>();
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        if (scopesOverlap(group[left].scope, group[right].scope)) {
          ids.add(group[left].id);
          ids.add(group[right].id);
        }
      }
    }
    if (ids.size > 1) conflicts.push({ chord, ids: [...ids].sort() });
  }
  return conflicts;
}

export function buildInterceptionSets(input: BindingInput): InterceptionSets {
  const bound = new Set<string>();
  const tuiReleasable = new Set<string>();
  const webviewForward = new Set<string>();
  for (const binding of collectInterceptionBindings(input)) {
    if (binding.releaseFromTerminal) bound.add(binding.chord);
    if (binding.releaseInTui) tuiReleasable.add(binding.chord);
    if (binding.forwardFromWebview) webviewForward.add(binding.chord);
  }
  return { bound, tuiReleasable, webviewForward };
}
