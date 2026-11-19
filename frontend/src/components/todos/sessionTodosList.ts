import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { isOpenTodoState, type TodoListRow } from '../../../../shared/types/todos';
import { sessionTodos } from './sessionTodos';
import { flattenGroups, groupTodos, tabCounts, type TodoEntry, type TodoGroup, type TodoListStop } from './todoList';

/**
 * A Session's To-dos tab (T-23, D-440): the list's logic, kept apart from the tab so it is tested on its own.
 * Its to-dos in the To-dos screen's status groups, then the ones done this week, folded at the end.
 */

/** How long a closed to-do stays in the tab's Done this week: older ones stay on the To-dos screen. */
export const DONE_THIS_WEEK_MS = 7 * 24 * 3_600_000;

export const SESSION_DONE_GROUP = 'status:done';
export const SESSION_SNOOZED_GROUP = 'status:snoozed';

/** The Session's to-dos as list entries, keyed `<machine id>:<number>` as the To-dos screen keys them. */
export function sessionTodoEntries(rows: readonly TodoListRow[], sessionId: string, machineId: string = LOCAL_MACHINE_ID): TodoEntry[] {
  return sessionTodos(rows, sessionId)
    .map((row): TodoEntry => ({ key: `${machineId}:${row.todo.number}`, row, machineId, remote: false, offline: false }))
    .sort((a, b) => b.row.todo.updatedAt - a.row.todo.updatedAt);
}

function closedAt(entry: TodoEntry): number {
  return entry.row.todo.closedAt ?? entry.row.todo.updatedAt;
}

/** The open groups as the To-dos screen orders them, then Done this week (newest first) when there is one. */
export function sessionTodoGroups(entries: readonly TodoEntry[], now: number): TodoGroup[] {
  const open = groupTodos(entries, 'open', 'status');
  const done = entries
    .filter(entry => !isOpenTodoState(entry.row.todo.state) && now - closedAt(entry) < DONE_THIS_WEEK_MS)
    .sort((a, b) => closedAt(b) - closedAt(a));
  return done.length ? [...open, { key: SESSION_DONE_GROUP, label: 'Done this week', status: 'done', entries: done }] : open;
}

/** "To-dos · 4 open": the ones that aren't snoozed or closed. */
export function sessionOpenCount(entries: readonly TodoEntry[]): number {
  const counts = tabCounts(entries);
  return counts.open - counts.snoozed;
}

/** The person's folds in one Session's tab, by group key: true folded, false opened. Absent: the default. */
export interface SessionFolds {
  readonly [groupKey: string]: boolean;
}

/** As chosen; else Done this week starts folded, and Snoozed does wherever there are other groups. */
export function sessionGroupFolded(folds: SessionFolds, group: TodoGroup, groupCount: number): boolean {
  const chosen = folds[group.key];
  if (chosen !== undefined) return chosen;
  if (group.key === SESSION_DONE_GROUP) return true;
  return group.key === SESSION_SNOOZED_GROUP && groupCount > 1;
}

export function withSessionFold(folds: SessionFolds, groupKey: string, folded: boolean): SessionFolds {
  return { ...folds, [groupKey]: folded };
}

/**
 * ↑ ↓ (J K) on an open to-do: the next or previous row shown, held at the ends. One opened from a folded
 * group steps through every row; one that isn't in the list (a sub-to-do) has nowhere to go.
 */
export function stepTodo(stops: readonly TodoListStop[], groups: readonly TodoGroup[], key: string, step: 1 | -1): string | null {
  const shown = stops.flatMap(stop => (stop.kind === 'row' ? [stop.key] : []));
  const order = shown.includes(key) ? shown : flattenGroups(groups).map(entry => entry.key);
  const at = order.indexOf(key);
  if (at < 0) return null;
  return order[Math.min(order.length - 1, Math.max(0, at + step))];
}
