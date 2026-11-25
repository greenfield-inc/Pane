import { LOCAL_MACHINE_ID, type MachineState } from '../../../../shared/types/machineConnections';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { isOpenTodoState, type TodoListRow, type TodoShownStatus, type TodoStatus, type TodosSnapshot } from '../../../../shared/types/todos';
import type { RemoteTodos } from '../../stores/todosStore';
import { todoKeyOfRow } from '../../../../shared/todoKey';
import { TODO_STATUS_LABEL } from './TodoStatusIcon';

/**
 * The To-dos list's logic (D-393, D-409), kept apart from the screen so it is tested on its own:
 * which rows each tab shows, how they group, the counts, and what S, R and Start anyway do.
 */

const TODOS_TABS = ['open', 'waiting', 'snoozed', 'done', 'all'] as const;
export type TodosTab = typeof TODOS_TABS[number];

export const TODOS_GROUPINGS = ['status', 'requester', 'repo', 'machine'] as const;
export type TodosGrouping = typeof TODOS_GROUPINGS[number];

export const TODOS_GROUPING_LABEL = {
  status: 'Status',
  requester: 'Requested by',
  repo: 'Repo',
  machine: 'Machine',
} as const satisfies Record<TodosGrouping, string>;

/** Status groups in the order the list shows them: what needs you first; Snoozed after Idle (round 9). */
const STATUS_ORDER: readonly TodoShownStatus[] = ['waiting', 'working', 'queued', 'idle', 'snoozed', 'done', 'dropped'];

/** One row of the list: a top-level to-do on this machine or a saved one. */
export interface TodoEntry {
  /** Unique across machines: `<machine id>:<number>`. */
  key: string;
  row: TodoListRow;
  /** LOCAL_MACHINE_ID for this machine. */
  machineId: string;
  /** On a saved machine: its actions run there (`machines.run`). */
  remote: boolean;
  /** Its machine is unreachable: it reads Idle · machine offline and offers no action. */
  offline: boolean;
}

export interface TodoGroup {
  key: string;
  label: string;
  /** Set when grouped by status: the header shows its icon. */
  status?: TodoShownStatus;
  entries: TodoEntry[];
}

export interface TodosTabCounts {
  open: number;
  waiting: number;
  snoozed: number;
  done: number;
  all: number;
}

const OFFLINE_STATUS: TodoStatus = { status: 'idle', reason: 'machine offline', idleReason: 'offline' };

/**
 * A saved machine's to-do while that machine is unreachable: Idle · machine offline, unless closed,
 * or Snoozed, which its own host wakes (round 9): its row adds "machine offline" until it reconnects.
 */
function offlineRow(row: TodoListRow, machine: string): TodoListRow {
  const closed = row.status.status === 'done' || row.status.status === 'dropped';
  if (row.todo.snooze && !closed) return { ...row, machine, status: { status: 'snoozed', reason: 'machine offline' } };
  return { ...row, machine, status: closed ? row.status : OFFLINE_STATUS };
}

/** Every top-level to-do from this machine and each saved one, newest change first. */
/**
 * The saved machines whose to-dos the list reads. A saved machine that answers with this computer's own
 * install id is this computer read over a connection, and in remote mode `viewedHostId` (the computer
 * this window shows) answers the list's own reads (T-8): either way its to-dos are already the local rows.
 */
export function otherMachines(machines: readonly MachineState[], viewedHostId: string | null = null): MachineState[] {
  const self = machines.find(machine => machine.kind === 'local')?.installId;
  return machines.filter(machine => machine.kind === 'remote' && machine.id !== LOCAL_MACHINE_ID
    && machine.id !== viewedHostId && !(self && machine.installId === self));
}

export function mergeTodoEntries(local: TodosSnapshot | null, remotes: readonly RemoteTodos[]): TodoEntry[] {
  const entries: TodoEntry[] = [];
  for (const row of local?.rows ?? []) {
    if (row.todo.parentNumber !== null) continue;
    entries.push({ key: todoKeyOfRow(LOCAL_MACHINE_ID, row), row, machineId: LOCAL_MACHINE_ID, remote: false, offline: false });
  }
  for (const remote of remotes) {
    for (const row of remote.snapshot?.rows ?? []) {
      if (row.todo.parentNumber !== null) continue;
      const shown: TodoListRow = remote.offline ? offlineRow(row, remote.label) : { ...row, machine: remote.label };
      entries.push({ key: todoKeyOfRow(remote.machineId, row), row: { ...shown, machineId: remote.machineId }, machineId: remote.machineId, remote: true, offline: remote.offline });
    }
  }
  return entries.sort((a, b) => b.row.todo.updatedAt - a.row.todo.updatedAt);
}

function isClosed(entry: TodoEntry): boolean {
  return !isOpenTodoState(entry.row.todo.state);
}

function inTab(entry: TodoEntry, tab: TodosTab): boolean {
  switch (tab) {
    case 'open': return !isClosed(entry);
    case 'waiting': return !isClosed(entry) && entry.row.status.status === 'waiting';
    case 'snoozed': return !isClosed(entry) && entry.row.status.status === 'snoozed';
    case 'done': return isClosed(entry);
    case 'all': return true;
  }
}

export function tabCounts(entries: readonly TodoEntry[]): TodosTabCounts {
  return {
    open: entries.filter(entry => inTab(entry, 'open')).length,
    waiting: entries.filter(entry => inTab(entry, 'waiting')).length,
    snoozed: entries.filter(entry => inTab(entry, 'snoozed')).length,
    done: entries.filter(entry => inTab(entry, 'done')).length,
    all: entries.length,
  };
}

/** Who asked for it, as a chip and a group: "You", or the requesting Session ("Billing rewrite orchestrator" reads "Billing rewrite"). */
export function requesterLabel(row: TodoListRow): string {
  const { requester } = row.todo;
  if (requester.kind === 'person') return 'You';
  return requester.name.replace(/\s+orchestrator$/i, '') || requester.name;
}

function repoLabel(row: TodoListRow): string {
  return row.projectName ?? 'No repo';
}

function groupKeyOf(entry: TodoEntry, grouping: Exclude<TodosGrouping, 'status'>): string {
  if (grouping === 'requester') return requesterLabel(entry.row);
  if (grouping === 'repo') return repoLabel(entry.row);
  return entry.row.machine;
}

/** The tab's rows in groups. Status groups follow STATUS_ORDER; others keep first-seen order, this machine first. */
export function groupTodos(entries: readonly TodoEntry[], tab: TodosTab, grouping: TodosGrouping): TodoGroup[] {
  const shown = entries.filter(entry => inTab(entry, tab));
  if (grouping === 'status') {
    return STATUS_ORDER.flatMap((status): TodoGroup[] => {
      const members = shown.filter(entry => entry.row.status.status === status);
      // Snoozed: soonest first.
      if (status === 'snoozed') members.sort((a, b) => (a.row.todo.snooze?.until ?? 0) - (b.row.todo.snooze?.until ?? 0));
      return members.length ? [{ key: `status:${status}`, label: TODO_STATUS_LABEL[status], status, entries: members }] : [];
    });
  }
  const ordered = grouping === 'machine'
    ? [...shown.filter(entry => !entry.remote), ...shown.filter(entry => entry.remote)]
    : shown;
  const groups = new Map<string, TodoGroup>();
  for (const entry of ordered) {
    const label = groupKeyOf(entry, grouping);
    const group = groups.get(label) ?? { key: `${grouping}:${label}`, label, entries: [] };
    group.entries.push(entry);
    groups.set(label, group);
  }
  return [...groups.values()];
}

/** The rows in the order J and K move through them. */
export function flattenGroups(groups: readonly TodoGroup[]): TodoEntry[] {
  return groups.flatMap(group => group.entries);
}

export function nextGrouping(grouping: TodosGrouping): TodosGrouping {
  return TODOS_GROUPINGS[(TODOS_GROUPINGS.indexOf(grouping) + 1) % TODOS_GROUPINGS.length];
}

/** J / K: one row down or up, held at the ends. */
export function moveSelection(index: number, count: number, step: 1 | -1): number {
  if (count === 0) return 0;
  return Math.min(count - 1, Math.max(0, index + step));
}

export type TodoRowActionKind = 'stop' | 'resume' | 'start' | 'start-anyway' | 'wake';

/**
 * The one action a row offers: Start anyway while queued, Start before it ever ran, Resume once
 * stopped, Stop while it moves; nothing once closed.
 */
/** A row's action, none while its machine is unreachable. */
export function entryAction(entry: TodoEntry): TodoRowActionKind | null {
  return entry.offline ? null : rowAction(entry.row);
}

export function rowAction(row: TodoListRow): TodoRowActionKind | null {
  const { state } = row.todo;
  if (!isOpenTodoState(state)) return null;
  // Snoozed (round 9): Wake now.
  if (row.todo.snooze) return 'wake';
  if (row.status.status === 'queued') return 'start-anyway';
  if (state === 'todo') return 'start';
  if (state === 'stopped') return 'resume';
  return 'stop';
}

/** The key that asks for an action: S stops, R resumes or starts, or wakes a snoozed to-do now. */
export function actionForKey(row: TodoListRow, key: 's' | 'r'): TodoRowActionKind | null {
  const action = rowAction(row);
  if (key === 's') return action === 'stop' ? 'stop' : null;
  return action === 'resume' || action === 'start' || action === 'wake' ? action : null;
}

/** Z: a top-level open to-do that isn't In review or Accepted, on a machine that answers (round 9). */
export function canSnooze(entry: TodoEntry): boolean {
  const { todo } = entry.row;
  return !entry.offline && todo.parentNumber === null && (todo.state === 'todo' || todo.state === 'in_progress' || todo.state === 'stopped');
}

/** The soonest wake in a group, for the folded Snoozed header ("next wakes Wed 9:00 AM"). */
export function nextWake(group: TodoGroup): number | null {
  const times = group.entries.map(entry => entry.row.todo.snooze?.until).filter((until): until is number => until !== undefined);
  return times.length ? Math.min(...times) : null;
}

// ── Folding groups (D-432) ──────────────────────────────────────────────────

/** Folds the person chose, by tab × grouping × group key: true folded, false opened. Absent: the default. */
export interface TodoFolds {
  readonly [foldKey: string]: boolean;
}

const foldsSchema = boundary.record(boundary.boolean);

const FOLDS_STORAGE_KEY = 'pane-todos-folds';
const SNOOZED_GROUP = 'status:snoozed';

export function foldKey(tab: TodosTab, grouping: TodosGrouping, groupKey: string): string {
  return `${tab}|${grouping}|${groupKey}`;
}

/** Whether a group shows folded: as chosen, else Snoozed starts folded wherever there are other groups. */
export function isFolded(folds: TodoFolds, tab: TodosTab, grouping: TodosGrouping, group: TodoGroup, groupCount: number): boolean {
  const chosen = folds[foldKey(tab, grouping, group.key)];
  if (chosen !== undefined) return chosen;
  return group.key === SNOOZED_GROUP && groupCount > 1;
}

export function withFold(folds: TodoFolds, tab: TodosTab, grouping: TodosGrouping, groupKey: string, folded: boolean): TodoFolds {
  return { ...folds, [foldKey(tab, grouping, groupKey)]: folded };
}

/** The saved folds; anything unreadable reads as none. */
export function readFolds(storage: Pick<Storage, 'getItem'>): TodoFolds {
  try {
    const raw = storage.getItem(FOLDS_STORAGE_KEY);
    if (raw === null) return {};
    return decodeOptionalBoundary(JSON.parse(raw), foldsSchema) ?? {};
  } catch {
    return {};
  }
}

export function writeFolds(storage: Pick<Storage, 'setItem'>, folds: TodoFolds): void {
  try {
    storage.setItem(FOLDS_STORAGE_KEY, JSON.stringify(folds));
  } catch {
    // Storage blocked: folds last for this visit only.
  }
}

/** A folded group's header as a stop: its selection key. */
export function headerKey(groupKey: string): string {
  return `group:${groupKey}`;
}

/** Where J and K stop: each row of an open group, and a folded group once, on its header. */
export type TodoListStop =
  | { kind: 'row'; key: string; entry: TodoEntry; group: TodoGroup }
  | { kind: 'header'; key: string; group: TodoGroup };

export function listStops(groups: readonly TodoGroup[], folded: (group: TodoGroup) => boolean): TodoListStop[] {
  return groups.flatMap((group): TodoListStop[] => folded(group)
    ? [{ kind: 'header', key: headerKey(group.key), group }]
    : group.entries.map(entry => ({ kind: 'row', key: entry.key, entry, group })));
}

/**
 * The stop a selection key lands on: itself, or for a row inside a folded group that group's
 * header (Esc back from a to-do, a woken row whose new group is folded); else the first stop.
 */
export function resolveStop(stops: readonly TodoListStop[], groups: readonly TodoGroup[], selectedKey: string | null): number {
  if (stops.length === 0) return -1;
  if (selectedKey === null) return 0;
  const direct = stops.findIndex(stop => stop.key === selectedKey);
  if (direct >= 0) return direct;
  const home = groups.find(group => group.entries.some(entry => entry.key === selectedKey));
  const header = home ? stops.findIndex(stop => stop.key === headerKey(home.key)) : -1;
  return header >= 0 ? header : 0;
}

/** A row about to leave the visible list (snoozed into a folded Snoozed): the stop after it, or before it at the end. */
export function stopAfterLeaving(stops: readonly TodoListStop[], key: string): string | null {
  const at = stops.findIndex(stop => stop.key === key);
  if (at < 0) return null;
  return (stops[at + 1] ?? stops[at - 1])?.key ?? null;
}

/** Waiting count and whether anything is worked on, for the sidebar entry. */
export interface TodosNavSummary {
  waiting: number;
  working: boolean;
}

export function navSummary(entries: readonly TodoEntry[]): TodosNavSummary {
  const open = entries.filter(entry => inTab(entry, 'open'));
  return {
    waiting: open.filter(entry => entry.row.status.status === 'waiting').length,
    working: open.some(entry => entry.row.status.status === 'working'),
  };
}
