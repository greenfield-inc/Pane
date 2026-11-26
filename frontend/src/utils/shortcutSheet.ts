/**
 * The keyboard shortcut sheet (⌘/): every key Pane answers to, in the
 * sheet's groups. Catalog commands show the person's effective keys (from
 * {@link buildShortcutMap}); fixed keys come from {@link REFERENCE_ROWS}.
 * Search covers every group, by name or by key as it is displayed.
 */
import type { KeyboardShortcutId } from '../../../shared/constants/keyboardShortcuts';
import { formatKeyDisplay } from './hotkeyUtils';
import { REFERENCE_ROWS, type ReferenceRow, type SheetGroupId, type ShortcutMapRow } from './shortcutMap';

export const SHEET_GROUPS: ReadonlyArray<{ id: SheetGroupId; name: string }> = [
  { id: 'navigation', name: 'Navigation' },
  { id: 'tabs', name: 'Tabs and splits' },
  { id: 'find', name: 'Find' },
  { id: 'chat', name: 'Chat' },
  { id: 'approvals', name: 'Approvals' },
  { id: 'panes', name: 'Panes and Sessions' },
  { id: 'view', name: 'View' },
  { id: 'machines', name: 'Machines' },
  { id: 'git', name: 'Git' },
  { id: 'tools', name: 'Tools' },
  { id: 'terminal', name: 'Terminal' },
  { id: 'sidebar', name: 'Sidebar' },
  { id: 'help', name: 'Help' },
];

/** One key cap, or the "…" between the ends of a 1–9 run. */
export type SheetKey = { kind: 'key'; text: string; chord: string } | { kind: 'gap' };

export interface SheetRow {
  id: string;
  label: string;
  /** Empty when no key is assigned: the command runs from the palette only. */
  keys: SheetKey[];
  /** The person changed one of this row's keys. */
  changed: boolean;
  /** Catalog commands this row shows. */
  commandIds: string[];
  /** Where the key is changed when it is not a catalog command. */
  link?: 'answer-all';
}

export interface SheetGroup {
  id: SheetGroupId;
  name: string;
  rows: SheetRow[];
}

type Placement =
  | { command: KeyboardShortcutId; label?: string }
  | { commands: readonly KeyboardShortcutId[]; label: string }
  | { run: 'switch-session-' | 'panel-tab-'; label: string }
  | { reference: string };

const PLACEMENTS = {
  navigation: [
    { command: 'open-command-palette' }, { command: 'focus-sidebar' },
    { command: 'focus-group-left' }, { command: 'focus-group-right' }, { command: 'focus-group-up' }, { command: 'focus-group-down' },
    { command: 'focus-next-region' }, { command: 'focus-previous-region' },
    { command: 'cycle-session-next-0' }, { command: 'cycle-session-prev-0' },
    { command: 'cycle-sidebar-session-next' }, { command: 'cycle-sidebar-session-prev' },
    { run: 'switch-session-', label: 'Switch to Pane 1–9' }, { command: 'open-settings' },
  ],
  tabs: [
    { command: 'cycle-tab-next-d' }, { command: 'cycle-tab-prev-a' }, { run: 'panel-tab-', label: 'Switch to tab 1–9' },
    { command: 'close-active-tab' }, { command: 'open-add-tool' }, { command: 'split-right' }, { command: 'split-down' },
    { command: 'zoom-toggle' }, { command: 'minimize-region' },
  ],
  find: [
    { command: 'find-in-tab', label: 'Find in the focused tab, chat or approval' }, { command: 'find-next' }, { command: 'find-previous' },
  ],
  chat: [
    { reference: 'reference-chat-send' }, { reference: 'reference-chat-newline' }, { reference: 'reference-chat-send-now' },
    { reference: 'reference-chat-stop' }, { reference: 'reference-chat-enter' },
    { command: 'open-session-approval', label: 'Open this Session’s approval' },
  ],
  approvals: [
    { command: 'toggle-approvals', label: 'Open or close Approvals' },
    { command: 'open-session-approval', label: 'Open this Session’s approval (from its chat)' },
    { commands: ['next-approval', 'previous-approval'], label: 'Next / previous approval (from anywhere; set your own key)' },
    { reference: 'reference-approval-page' }, { reference: 'reference-approval-tabs' },
    { reference: 'reference-approval-move' }, { reference: 'reference-approval-pick' }, { reference: 'reference-approval-question' },
    { command: 'send-approval', label: 'Send your answer' }, { reference: 'reference-approval-recommended' },
    { reference: 'reference-approvals-list' }, { reference: 'reference-approvals-archive' },
    { command: 'approvals-group-by', label: 'Approvals list: Group by… (set your own key)' },
    { reference: 'reference-approvals-filter' }, { reference: 'reference-approvals-back' }, { reference: 'reference-answer-all' },
  ],
  panes: [
    { command: 'new-session' }, { command: 'new-orchestration-session' }, { command: 'new-project' },
    { command: 'archive-active-session' }, { command: 'switch-to-chat-pane' }, { command: 'switch-to-chat-session' },
  ],
  view: [
    { command: 'toggle-sidebar' }, { command: 'toggle-detail-panel' }, { command: 'toggle-terminal' },
    { commands: ['scroll-focused-surface-up', 'scroll-focused-surface-down'], label: 'Scroll focused surface up / down' },
    { commands: ['page-focused-surface-up', 'page-focused-surface-down'], label: 'Page focused surface up / down' },
  ],
  machines: [
    { command: 'open-machine-switcher' }, { command: 'next-machine' }, { command: 'previous-machine' }, { command: 'toggle-all-machines' },
  ],
  git: [
    { command: 'git-commit' }, { command: 'git-push' }, { command: 'git-pull' },
    { command: 'git-rebase-from-main' }, { command: 'git-merge-to-main' }, { command: 'git-soft-reset' },
  ],
  tools: [{ command: 'add-tool-terminal' }, { command: 'add-tool-explorer' }],
  terminal: [],
  sidebar: [],
  help: [
    { command: 'show-keyboard-shortcuts', label: 'Show keyboard shortcuts (this sheet)' },
    { command: 'open-shortcut-settings', label: 'Change keys (Settings › Shortcuts)' },
  ],
} satisfies Record<SheetGroupId, readonly Placement[]>;

function placementsFor(id: SheetGroupId): readonly Placement[] {
  return PLACEMENTS[id];
}

/** Where a catalog command no placement names goes, by its category. */
const CATEGORY_GROUP = {
  navigation: 'navigation',
  session: 'panes',
  tabs: 'tabs',
  view: 'view',
  tools: 'tools',
  machines: 'machines',
  shortcuts: 'help',
  debug: 'help',
  approvals: 'approvals',
  controller: 'navigation',
} satisfies Record<ShortcutMapRow['category'], SheetGroupId>;

const ACCELERATOR_MODIFIERS = new Map([
  ['control', 'ctrl'], ['ctrl', 'ctrl'], ['commandorcontrol', 'mod'], ['cmdorctrl', 'mod'], ['command', 'mod'], ['cmd', 'mod'],
  ['super', 'mod'], ['meta', 'mod'], ['alt', 'alt'], ['option', 'alt'], ['altgr', 'alt'], ['shift', 'shift'],
]);

/** Converts an Electron accelerator (`Control+Shift+Space`) to a chord. */
function chordFromAccelerator(accelerator: string): string {
  return accelerator.split('+').filter(Boolean)
    .map(part => ACCELERATOR_MODIFIERS.get(part.toLowerCase()) ?? (part.length === 1 ? part.toLowerCase() : part))
    .join('+');
}

function capText(step: string, mac: boolean): string {
  // A bare letter (the sidebar's j and k) is typed as it is, not as a capital.
  if (/^[a-z]$/.test(step)) return step;
  const text = formatKeyDisplay(step, mac);
  // Mac keyboards print esc and tab in lower case.
  return mac ? text.replace(/Esc$/, 'esc').replace(/Tab$/, 'tab') : text;
}

function keyCaps(chord: string, mac: boolean): SheetKey[] {
  return chord.trim().split(/\s+/).filter(Boolean).map(step => ({
    kind: 'key',
    chord: step,
    text: capText(step, mac),
  }));
}

export interface ShortcutSheetInput {
  rows: readonly ShortcutMapRow[];
  /** The answer-all key from Settings › Approvals, as an Electron accelerator. */
  answerAll: string;
  mac: boolean;
}

export function buildShortcutSheet({ rows, answerAll, mac }: ShortcutSheetInput): SheetGroup[] {
  const byId = new Map(rows.filter(row => row.availability === 'available').map(row => [row.id, row]));
  const placed = new Set<string>();
  const references = new Map(REFERENCE_ROWS.map(reference => [reference.id, reference]));
  const placedReferences = new Set<string>();

  const commandRow = (ids: readonly string[], label: string | undefined, id: string): SheetRow | null => {
    const found = ids.map(commandId => byId.get(commandId)).filter((row): row is ShortcutMapRow => !!row);
    if (found.length === 0) return null;
    for (const row of found) placed.add(row.id);
    return {
      id,
      label: label ?? found[0].label,
      keys: found.flatMap(row => row.effectiveChord ? keyCaps(row.effectiveChord, mac) : []),
      changed: found.some(row => row.state === 'customized'),
      commandIds: found.map(row => row.id),
    };
  };

  const runRows = (prefix: string, label: string): SheetRow[] => {
    const found = Array.from({ length: 9 }, (_, index) => byId.get(`${prefix}${index + 1}`))
      .filter((row): row is ShortcutMapRow => !!row);
    for (const row of found) placed.add(row.id);
    const first = found[0]?.effectiveChord;
    const last = found[8]?.effectiveChord;
    // One row while the run is the plain default; changed keys are listed one by one.
    if (found.length === 9 && first && last && found.every(row => row.state === 'default')) {
      return [{ id: `${prefix}1-9`, label, keys: [...keyCaps(first, mac), { kind: 'gap' }, ...keyCaps(last, mac)], changed: false, commandIds: found.map(row => row.id) }];
    }
    return found.map(row => ({
      id: row.id, label: row.label, keys: row.effectiveChord ? keyCaps(row.effectiveChord, mac) : [],
      changed: row.state === 'customized', commandIds: [row.id],
    }));
  };

  const referenceRow = (reference: ReferenceRow): SheetRow => {
    placedReferences.add(reference.id);
    let label = reference.label;
    if (!mac) label = label.replace('⌘K', formatKeyDisplay('mod+k', false));
    if (reference.answerAll) {
      return { id: reference.id, label, keys: keyCaps(chordFromAccelerator(answerAll), mac), changed: false, commandIds: [], link: 'answer-all' };
    }
    if (reference.follows) {
      const followed = reference.follows.map(commandId => byId.get(commandId)).filter((row): row is ShortcutMapRow => !!row);
      return {
        id: reference.id,
        label,
        keys: followed.flatMap(row => row.effectiveChord ? keyCaps(row.effectiveChord, mac) : []),
        changed: followed.some(row => row.state === 'customized'),
        commandIds: [],
      };
    }
    return { id: reference.id, label, keys: keyCaps(reference.chord, mac), changed: false, commandIds: [] };
  };

  const groups: SheetGroup[] = SHEET_GROUPS.map(({ id, name }) => ({
    id,
    name,
    rows: placementsFor(id).flatMap((placement, index): SheetRow[] => {
      if ('reference' in placement) {
        const reference = references.get(placement.reference);
        return reference ? [referenceRow(reference)] : [];
      }
      if ('run' in placement) return runRows(placement.run, placement.label);
      const ids = 'command' in placement ? [placement.command] : placement.commands;
      const row = commandRow(ids, placement.label, `${id}-${index}-${ids.join('+')}`);
      return row ? [row] : [];
    }),
  }));

  const groupOf = new Map(groups.map(group => [group.id, group]));
  // Commands no placement names (agents' terminals, custom tools, snippets) still show, by category.
  for (const row of byId.values()) {
    if (placed.has(row.id)) continue;
    const target = groupOf.get(row.origin === 'snippet' ? 'terminal' : CATEGORY_GROUP[row.category]);
    const sheetRow = commandRow([row.id], undefined, row.id);
    if (target && sheetRow) target.rows.push(sheetRow);
  }
  for (const reference of REFERENCE_ROWS) {
    if (placedReferences.has(reference.id)) continue;
    groupOf.get(reference.group)?.rows.push(referenceRow(reference));
  }
  return groups;
}

const MODIFIER_WORDS = new Map([
  ['⌘', 'mod'], ['cmd', 'mod'], ['command', 'mod'],
  ['⌃', 'ctrl'], ['ctrl', 'ctrl'], ['control', 'ctrl'],
  ['⌥', 'alt'], ['alt', 'alt'], ['opt', 'alt'], ['option', 'alt'],
  ['⇧', 'shift'], ['shift', 'shift'],
]);

/** The modifiers a query names, when it names nothing else ("⌘⇧", "ctrl+shift"); otherwise null. */
function queryModifiers(query: string, mac: boolean): Set<string> | null {
  const tokens = query.toLowerCase().split(/[\s+]+/).filter(Boolean)
    .flatMap(token => /^[⌘⌃⌥⇧]+$/.test(token) ? [...token] : [token]);
  if (tokens.length === 0) return null;
  const found = new Set<string>();
  for (const token of tokens) {
    const modifier = MODIFIER_WORDS.get(token);
    if (!modifier) return null;
    // Off macOS, Ctrl is the command key, and ⌘ means it too.
    found.add(!mac && modifier === 'ctrl' ? 'mod' : modifier);
  }
  return found;
}

function stepModifiers(chord: string, mac: boolean): Set<string> {
  const parts = chord.split('+').slice(0, -1);
  return new Set(parts.map(part => (!mac && part === 'ctrl' ? 'mod' : part)));
}

function rowMatches(row: SheetRow, query: string, modifiers: Set<string> | null, mac: boolean): boolean {
  const lower = query.toLowerCase();
  if (row.label.toLowerCase().includes(lower)) return true;
  const keys = row.keys.flatMap(key => key.kind === 'key' ? [key] : []);
  if (modifiers) return keys.some(key => [...modifiers].every(modifier => stepModifiers(key.chord, mac).has(modifier)));
  const compact = lower.replace(/\s+/g, '');
  return keys.some(key => key.text.toLowerCase().replace(/\s+/g, '').includes(compact) || key.chord.toLowerCase().includes(lower));
}

export interface SheetSearch {
  /** Groups with at least one match, holding only their matching rows. */
  groups: SheetGroup[];
  counts: ReadonlyMap<SheetGroupId, number>;
  total: number;
}

export function searchShortcutSheet(groups: readonly SheetGroup[], query: string, mac: boolean): SheetSearch {
  const trimmed = query.trim();
  const modifiers = queryModifiers(trimmed, mac);
  const matched = groups.map(group => ({
    ...group,
    rows: !trimmed || group.name.toLowerCase().includes(trimmed.toLowerCase())
      ? group.rows
      : group.rows.filter(row => rowMatches(row, trimmed, modifiers, mac)),
  }));
  const counts = new Map(matched.map(group => [group.id, group.rows.length]));
  const shown = matched.filter(group => group.rows.length > 0);
  return { groups: shown, counts, total: shown.reduce((sum, group) => sum + group.rows.length, 0) };
}
