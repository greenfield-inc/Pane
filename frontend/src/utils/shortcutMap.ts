/**
 * Builds the complete, view-independent shortcut map shown by Shortcuts
 * Settings and Help. Rows come from the shared catalog plus the current
 * dynamic bindings (terminal snippets, custom commands); effective chords
 * and conflicts are resolved with the same primitives the runtime uses.
 *
 * Conflicts are validated globally (no platform gate — a native-Windows
 * install can open a WSL project where Cursor is active), while platform
 * availability is only a badge derived from the supplied environment.
 */
import {
  KEYBOARD_SHORTCUT_CATALOG,
  getCatalogEntry,
  normalizeEnvironmentPlatform,
  type ShortcutCategory,
  type ShortcutScope,
} from '../../../shared/constants/keyboardShortcuts';
import {
  collectActiveBindings,
  findChordConflicts,
  normalizeKeyboardShortcutOverrides,
  resolveEffectiveChord,
  type KeyboardShortcutOverrides,
} from '../../../shared/utils/keyboardBindings';
import { parseChord } from '../../../shared/utils/keyboardChords';
import { boundary, decodeOptionalBoundary, BoundaryDecodeError, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import type { CustomCommand, TerminalShortcut } from '../types/config';
import { isTerminalReservedChordString } from './terminalKeyHandling';

export type ShortcutRowOrigin = 'catalog' | 'snippet';
export type ShortcutRowState = 'default' | 'customized' | 'unassigned' | 'invalid';
export type ShortcutAvailability = 'available' | 'unavailable-platform';

export interface ShortcutMapRow {
  id: string;
  origin: ShortcutRowOrigin;
  /** Rebindable through keyboardShortcutOverrides (catalog rows only). */
  editable: boolean;
  label: string;
  category: ShortcutCategory;
  scope: ShortcutScope;
  /** Catalog default; null for snippet rows. */
  defaultChord: string | null;
  /** Override | unassigned (null) | default; invalid overrides fall back to the default. */
  effectiveChord: string | null;
  state: ShortcutRowState;
  availability: ShortcutAvailability;
  /** Ids of other rows that share this chord within an overlapping scope. */
  conflicts: string[];
}

export interface ShortcutMapInput {
  /** The raw persisted map, verbatim (unknown ids and malformed values included). */
  overridesRaw?: KeyboardShortcutOverrides | JsonValue;
  terminalShortcuts?: readonly TerminalShortcut[];
  customCommands?: readonly CustomCommand[];
  /** Environment used only for the availability badge (`darwin` | `win32` | `linux` | `wsl`). */
  environment: string;
}

export interface ShortcutMap {
  rows: ShortcutMapRow[];
  conflicts: Array<{ chord: string; ids: string[] }>;
  /** Raw override entries whose id is unknown or whose value cannot be parsed. */
  unknownIdDiagnostics: string[];
}

export interface ReferenceRow {
  id: string;
  label: string;
  chord: string;
}

/**
 * Terminal- and context-native shortcuts that are not registry commands.
 * They are listed for reference only; the terminal owns them before Pane's
 * hotkey registry sees the key.
 */
export const REFERENCE_ROWS: readonly ReferenceRow[] = [
  { id: 'reference-send-input', label: 'Send Input / Continue Conversation', chord: 'mod+Enter' },
  { id: 'reference-newline', label: 'Insert newline in agent input', chord: 'shift+Enter' },
  { id: 'reference-terminal-copy', label: 'Terminal: Copy selection', chord: 'mod+c' },
  { id: 'reference-terminal-paste', label: 'Terminal: Paste', chord: 'mod+v' },
  { id: 'reference-terminal-search', label: 'Terminal: Find', chord: 'mod+f' },
  { id: 'reference-terminal-clear', label: 'Terminal: Clear scrollback', chord: 'mod+k' },
  { id: 'reference-prompt-history', label: 'Terminal: Prompt history', chord: 'mod+p' },
];

export const SCOPE_LABELS = {
  'app': 'Everywhere',
  'session': 'Pane view',
  'session-panels': 'Pane tabs',
  'usage': 'Usage & Limits',
} satisfies Record<ShortcutScope, string>;

/**
 * Environment for the availability badge: the active project's environment
 * when one is known, otherwise the host platform.
 */
export function resolveShortcutEnvironment(
  projectEnvironment: ProjectEnvironment | undefined,
  hostPlatform: string,
): string {
  return normalizeEnvironmentPlatform(projectEnvironment ?? hostPlatform);
}

function rawEntries(raw: ShortcutMapInput['overridesRaw']): Map<string, JsonValue> {
  const entries = new Map<string, JsonValue>();
  try {
    const parsed = decodeOptionalBoundary(raw, boundary.jsonObject);
    if (parsed) for (const [id, value] of Object.entries(parsed)) entries.set(id, value);
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
  }
  return entries;
}

export function buildShortcutMap(input: ShortcutMapInput): ShortcutMap {
  const normalized = normalizeKeyboardShortcutOverrides(input.overridesRaw);
  const overrides = normalized.overrides;
  const raw = rawEntries(input.overridesRaw);
  const customCommands = input.customCommands ?? [];
  const terminalShortcuts = input.terminalShortcuts ?? [];
  const environment = normalizeEnvironmentPlatform(input.environment);

  // Global validation: no platform gate, so platform-limited commands stay in the set.
  const conflicts = findChordConflicts(collectActiveBindings({
    overrides,
    terminalShortcuts,
    customCommands,
  }));
  const conflictIdsByRow = new Map<string, string[]>();
  for (const conflict of conflicts) {
    for (const id of conflict.ids) {
      conflictIdsByRow.set(id, conflict.ids.filter(other => other !== id));
    }
  }

  const rows: ShortcutMapRow[] = [];
  for (const entry of KEYBOARD_SHORTCUT_CATALOG) {
    let label = entry.label;
    if (entry.dynamicSlot === 'custom-command') {
      const command = customCommands[Number(entry.id.slice(-1))];
      if (!command) continue;
      label = `Add ${command.name}`;
    }
    let state: ShortcutRowState = 'default';
    if (raw.has(entry.id)) {
      if (raw.get(entry.id) === null) state = 'unassigned';
      else if (Object.prototype.hasOwnProperty.call(overrides, entry.id)) state = 'customized';
      else state = 'invalid';
    }
    rows.push({
      id: entry.id,
      origin: 'catalog',
      editable: true,
      label,
      category: entry.category,
      scope: entry.scope,
      defaultChord: entry.defaultChord,
      effectiveChord: resolveEffectiveChord(entry.id, overrides, entry.defaultChord),
      state,
      availability: !entry.platforms || entry.platforms.includes(environment)
        ? 'available'
        : 'unavailable-platform',
      conflicts: conflictIdsByRow.get(entry.id) ?? [],
    });
  }

  for (const shortcut of terminalShortcuts) {
    if (!shortcut.enabled) continue;
    const id = `terminal-shortcut-${shortcut.id}`;
    const parsed = shortcut.key ? parseChord(`mod+alt+${shortcut.key}`) : null;
    rows.push({
      id,
      origin: 'snippet',
      editable: false,
      label: shortcut.label || 'Untitled snippet',
      category: 'shortcuts',
      scope: 'app',
      defaultChord: null,
      effectiveChord: parsed?.ok ? parsed.chord : null,
      state: 'default',
      availability: 'available',
      conflicts: conflictIdsByRow.get(id) ?? [],
    });
  }

  return { rows, conflicts, unknownIdDiagnostics: normalized.diagnostics };
}

export function filterShortcutRows(rows: readonly ShortcutMapRow[], query: string): ShortcutMapRow[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return [...rows];
  return rows.filter(row =>
    row.label.toLowerCase().includes(lower)
    || row.id.toLowerCase().includes(lower)
    || (row.effectiveChord ?? '').toLowerCase().includes(lower)
  );
}

/** Human label for any binding id, including snippet and custom-command ids. */
export function labelForId(
  id: string,
  sources: { terminalShortcuts?: readonly TerminalShortcut[]; customCommands?: readonly CustomCommand[] },
): string {
  if (id.startsWith('terminal-shortcut-')) {
    const snippet = sources.terminalShortcuts?.find(shortcut => `terminal-shortcut-${shortcut.id}` === id);
    return snippet?.label || 'Untitled snippet';
  }
  if (id.startsWith('add-tool-custom-')) {
    const command = sources.customCommands?.[Number(id.slice(-1))];
    if (command) return `Add ${command.name}`;
  }
  return getCatalogEntry(id)?.label ?? id;
}

export type RecordableChordResult = { ok: true } | { ok: false; reason: 'reserved-by-terminal' };

/**
 * Whether a user may record this chord. Terminal-reserved chords are refused
 * unless the row's own default is that chord (grandfathered defaults such as
 * `open-command-palette` = mod+shift+p and `git-commit` = mod+shift+k).
 */
export function isRecordableChord(chord: string, options: { ownDefault: string | null }): RecordableChordResult {
  if (chord !== options.ownDefault && isTerminalReservedChordString(chord)) {
    return { ok: false, reason: 'reserved-by-terminal' };
  }
  return { ok: true };
}
