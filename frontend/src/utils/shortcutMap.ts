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
  resolveDefaultChord,
  resolveEffectiveChord,
  type KeyboardShortcutOverrides,
} from '../../../shared/utils/keyboardBindings';
import { bindingSteps, parseChord, type KeyPlatform } from '../../../shared/utils/keyboardChords';
import { boundary, decodeOptionalBoundary, BoundaryDecodeError, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import type { CustomCommand, TerminalShortcut } from '../types/config';

type ShortcutRowOrigin = 'catalog' | 'snippet';
type ShortcutRowState = 'default' | 'customized' | 'unassigned' | 'invalid';
type ShortcutAvailability = 'available' | 'unavailable-platform';

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
  /** Which keyboard defaults and conflicts are shown for. */
  keyPlatform: KeyPlatform;
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
  { id: 'reference-terminal-clear', label: 'Terminal: Clear (⌘K alone; ⌘K then a second key runs a two-step key)', chord: 'mod+k' },
  { id: 'reference-sidebar-list', label: 'Sidebar: move, open, open and stay, collapse or expand, back', chord: 'ArrowUp ArrowDown k j Enter Space ArrowLeft ArrowRight Escape' },
  { id: 'reference-chat-enter', label: 'Chat: into the message box (when focus is on no field or control)', chord: 'Enter' },
  { id: 'reference-approvals-back', label: 'Approvals: back to where you were (when not typing an answer)', chord: 'Escape' },
];

/** Chords the terminal owns outright; recording one is refused. */
const TERMINAL_RESERVED_CHORDS = new Set(['mod+c', 'mod+v', 'mod+shift+c', 'mod+shift+v', 'mod+k']);

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
    keyPlatform: input.keyPlatform,
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
      defaultChord: resolveDefaultChord(entry.id, input.keyPlatform),
      effectiveChord: resolveEffectiveChord(entry.id, overrides, input.keyPlatform),
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

export type RecordableChordResult = { ok: true } | { ok: false; reason: 'reserved-by-terminal' | 'bare-navigation-key' };

/**
 * Whether a person may record this binding. A named key with no modifier
 * (Tab, Enter, Space, arrows, paging, Home/End) would take focus movement
 * and typing app-wide, so only function keys may stand alone. Chords the
 * terminal owns (copy, paste, clear) are refused as a whole binding, though
 * ⌘K may start a two-step key.
 */
export function isRecordableChord(chord: string, options: { ownDefault: string | null }): RecordableChordResult {
  const steps = bindingSteps(chord);
  const first = steps[0] ?? '';
  if (!first.includes('+') && !/^F\d{1,2}$/.test(first)) return { ok: false, reason: 'bare-navigation-key' };
  if (chord !== options.ownDefault && steps.length === 1 && TERMINAL_RESERVED_CHORDS.has(chord)) {
    return { ok: false, reason: 'reserved-by-terminal' };
  }
  return { ok: true };
}
