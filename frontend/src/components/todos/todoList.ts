import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { isOpenTodoState, type TodoListRow, type TodoShownStatus, type TodoStatus, type TodosSnapshot } from '../../../../shared/types/todos';
import type { RemoteTodos } from '../../stores/todosStore';
import { TODO_STATUS_LABEL } from './TodoStatusIcon';

/**
 * The To-dos list's logic (D-393, D-409), kept apart from the screen so it is tested on its own:
 * which rows each tab shows, how they group, the counts, and what S, R and Start anyway do.
 */

export const TODOS_TABS = ['open', 'waiting', 'done', 'all'] as const;
export type TodosTab = typeof TODOS_TABS[number];

export const TODOS_GROUPINGS = ['status', 'requester', 'repo', 'machine'] as const;
export type TodosGrouping = typeof TODOS_GROUPINGS[number];

export const TODOS_GROUPING_LABEL = {
  status: 'Status',
  requester: 'Requested by',
  repo: 'Repo',
  machine: 'Machine',
} as const satisfies Record<TodosGrouping, string>;

/** Status groups in the order the list shows them: what needs you first. */
export const STATUS_ORDER: readonly TodoShownStatus[] = ['waiting', 'working', 'queued', 'idle', 'done', 'dropped'];

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
  done: number;
  all: number;
}

const OFFLINE_STATUS: TodoStatus = { status: 'idle', reason: 'machine offline', idleReason: 'offline' };

/** A saved machine's to-do while that machine is unreachable: Idle · machine offline, unless closed. */
function offlineRow(row: TodoListRow, machine: string): TodoListRow {
  const closed = row.status.status === 'done' || row.status.status === 'dropped';
  return { ...row, machine, status: closed ? row.status : OFFLINE_STATUS };
}

/** Every top-level to-do from this machine and each saved one, newest change first. */
export function mergeTodoEntries(local: TodosSnapshot | null, remotes: readonly RemoteTodos[]): TodoEntry[] {
  const entries: TodoEntry[] = [];
  for (const row of local?.rows ?? []) {
    if (row.todo.parentNumber !== null) continue;
    entries.push({ key: `${LOCAL_MACHINE_ID}:${row.todo.number}`, row, machineId: LOCAL_MACHINE_ID, remote: false, offline: false });
  }
  for (const remote of remotes) {
    for (const row of remote.snapshot?.rows ?? []) {
      if (row.todo.parentNumber !== null) continue;
      const shown: TodoListRow = remote.offline ? offlineRow(row, remote.label) : { ...row, machine: remote.label };
      entries.push({ key: `${remote.machineId}:${row.todo.number}`, row: { ...shown, machineId: remote.machineId }, machineId: remote.machineId, remote: true, offline: remote.offline });
    }
  }
  return entries.sort((a, b) => b.row.todo.updatedAt - a.row.todo.updatedAt);
}

function isClosed(entry: TodoEntry): boolean {
  return !isOpenTodoState(entry.row.todo.state);
}

export function inTab(entry: TodoEntry, tab: TodosTab): boolean {
  switch (tab) {
    case 'open': return !isClosed(entry);
    case 'waiting': return !isClosed(entry) && entry.row.status.status === 'waiting';
    case 'done': return isClosed(entry);
    case 'all': return true;
  }
}

export function tabCounts(entries: readonly TodoEntry[]): TodosTabCounts {
  return {
    open: entries.filter(entry => inTab(entry, 'open')).length,
    waiting: entries.filter(entry => inTab(entry, 'waiting')).length,
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

export function repoLabel(row: TodoListRow): string {
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

export type TodoRowActionKind = 'stop' | 'resume' | 'start' | 'start-anyway';

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
  if (row.status.status === 'queued') return 'start-anyway';
  if (state === 'todo') return 'start';
  if (state === 'stopped') return 'resume';
  return 'stop';
}

/** The key that asks for an action: S stops, R resumes or starts. */
export function actionForKey(row: TodoListRow, key: 's' | 'r'): TodoRowActionKind | null {
  const action = rowAction(row);
  if (key === 's') return action === 'stop' ? 'stop' : null;
  return action === 'resume' || action === 'start' ? action : null;
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
