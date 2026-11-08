import {
  defaultChordFor,
  getCatalogEntry,
  KEYBOARD_SHORTCUT_CATALOG,
  scopesOverlap,
  type ShortcutScope,
} from '../constants/keyboardShortcuts';
import { bindingSteps, chordForPlatform, parseChord, type KeyPlatform } from './keyboardChords';
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
  /** Single chords that leave a plain shell for Pane while their command is enabled. */
  bound: Set<string>;
  /** Single chords that leave a full-screen terminal program for Pane. */
  tuiReleasable: Set<string>;
  /** Single chords taken from a focused browser-tab page. */
  webviewForward: Set<string>;
  /** Two-step keys by first step: the second steps that complete one (any surface). */
  sequences: Map<string, Set<string>>;
  /** Two-step keys a browser-tab page gives up, by first step. */
  webviewSequences: Map<string, Set<string>>;
}

export interface BindingInput {
  overrides?: KeyboardShortcutOverrides | JsonValue;
  terminalShortcuts?: readonly TerminalShortcutBindingInput[] | JsonValue;
  customCommands?: readonly object[] | JsonValue;
  /** Gate for platform-limited commands (`darwin`, `win32`, `linux`, `wsl`). */
  platform?: string;
  /** Which keyboard the bindings are matched on. */
  keyPlatform: KeyPlatform;
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

/**
 * The binding a catalog command answers to on `platform`: the person's
 * override when there is one (null means unassigned), else the default.
 */
export function resolveEffectiveChord(
  id: string,
  overrides: KeyboardShortcutOverrides,
  platform: KeyPlatform,
): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) {
    const override = overrides[id];
    return override === null ? null : chordForPlatform(override, platform);
  }
  const catalogEntry = getCatalogEntry(id);
  return catalogEntry ? defaultChordFor(catalogEntry, platform) : null;
}

/** The default binding on `platform`, ignoring overrides. */
export function resolveDefaultChord(id: string, platform: KeyPlatform): string | null {
  const catalogEntry = getCatalogEntry(id);
  return catalogEntry ? defaultChordFor(catalogEntry, platform) : null;
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
    const chord = resolveEffectiveChord(catalogEntry.id, overrides, input.keyPlatform);
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
    const chord = resolveEffectiveChord(catalogEntry.id, overrides, input.keyPlatform);
    if (!chord) continue;
    // Unchanged Shift+Arrow/Page and bare function-key defaults stay with
    // native browser selection and scrolling; F6 is forwarded on purpose.
    const isDefault = chord === resolveDefaultChord(catalogEntry.id, input.keyPlatform);
    const browserOwnsDefault = isDefault && /^shift\+(Arrow|Page)/.test(chord);
    bindings.push({
      id: catalogEntry.id,
      chord,
      releaseFromTerminal: catalogEntry.releaseFromTerminal,
      releaseInTui: catalogEntry.releaseInTui,
      forwardFromWebview: catalogEntry.forwardFromWebview && !browserOwnsDefault,
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

/** Two bindings collide when they are equal or one is the first step of the other. */
function bindingsCollide(left: string, right: string): boolean {
  if (left === right) return true;
  const leftSteps = bindingSteps(left);
  const rightSteps = bindingSteps(right);
  if (leftSteps.length === rightSteps.length) return false;
  return leftSteps[0] === rightSteps[0];
}

export interface ChordConflict {
  chord: string;
  ids: string[];
}

export function findChordConflicts(bindings: readonly ActiveBinding[]): ChordConflict[] {
  const byFirstStep = new Map<string, ActiveBinding[]>();
  for (const binding of bindings) {
    const first = bindingSteps(binding.chord)[0];
    const group = byFirstStep.get(first) ?? [];
    group.push(binding);
    byFirstStep.set(first, group);
  }

  const conflicts = new Map<string, Set<string>>();
  for (const group of byFirstStep.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left];
        const b = group[right];
        if (!scopesOverlap(a.scope, b.scope) || !bindingsCollide(a.chord, b.chord)) continue;
        // Name a prefix collision by the shorter binding, the key that now waits.
        const chord = bindingSteps(a.chord).length <= bindingSteps(b.chord).length ? a.chord : b.chord;
        const ids = conflicts.get(chord) ?? new Set<string>();
        ids.add(a.id);
        ids.add(b.id);
        conflicts.set(chord, ids);
      }
    }
  }
  return [...conflicts].map(([chord, ids]) => ({ chord, ids: [...ids].sort() }));
}

function addStep(map: Map<string, Set<string>>, first: string, second: string): void {
  const seconds = map.get(first) ?? new Set<string>();
  seconds.add(second);
  map.set(first, seconds);
}

export function buildInterceptionSets(input: BindingInput): InterceptionSets {
  const sets: InterceptionSets = {
    bound: new Set<string>(),
    tuiReleasable: new Set<string>(),
    webviewForward: new Set<string>(),
    sequences: new Map(),
    webviewSequences: new Map(),
  };
  for (const binding of collectInterceptionBindings(input)) {
    const steps = bindingSteps(binding.chord);
    if (steps.length === 2) {
      addStep(sets.sequences, steps[0], steps[1]);
      if (binding.forwardFromWebview) addStep(sets.webviewSequences, steps[0], steps[1]);
      continue;
    }
    if (binding.releaseFromTerminal) sets.bound.add(binding.chord);
    if (binding.releaseInTui) sets.tuiReleasable.add(binding.chord);
    if (binding.forwardFromWebview) sets.webviewForward.add(binding.chord);
  }
  return sets;
}
