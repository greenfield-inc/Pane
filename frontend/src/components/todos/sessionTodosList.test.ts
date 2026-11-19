import { describe, expect, it } from 'vitest';
import type { TodoListRow, TodoRecord, TodoShownStatus } from '../../../../shared/types/todos';
import { listStops, type TodoGroup } from './todoList';
import { sessionGroupFolded, sessionOpenCount, sessionTodoEntries, sessionTodoGroups, stepTodo, withSessionFold, DONE_THIS_WEEK_MS } from './sessionTodosList';

const NOW = Date.UTC(2026, 10, 18, 12, 0);
const DAY = 24 * 3_600_000;

function row(number: number, status: TodoShownStatus, opts: { requestedBy?: string; own?: string; parent?: number; closedAt?: number; updatedAt?: number; until?: number } = {}): TodoListRow {
  const closed = status === 'done' || status === 'dropped';
  const todo: TodoRecord = {
    number, ref: `T-${number}`, sessionId: opts.own ?? null, parentNumber: opts.parent ?? null, title: `To-do ${number}`, summary: '', doneWhen: [],
    state: closed ? status : 'in_progress', requester: { kind: 'orchestrator', name: 'Billing rewrite orchestrator', sessionId: opts.requestedBy ?? 'billing', panelId: 'p' },
    projectId: null, agent: null, assignee: null, createdBy: 'orchestrator', createdAt: 0, startedAt: null, updatedAt: opts.updatedAt ?? NOW - number * 60_000,
    acceptedAt: null, closedAt: opts.closedAt ?? null, lastProgressAt: null, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0,
    stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
  if (opts.until !== undefined) todo.snooze = { until: opts.until, zone: 'UTC', note: '', action: 'agents', by: 'you', from: 'stopped', reminderCardId: null };
  return { todo, status: { status, reason: '' }, machine: 'This Mac' };
}

const rows: TodoListRow[] = [
  row(15, 'waiting'),
  row(14, 'working'),
  row(16, 'working'),
  row(17, 'queued'),
  row(18, 'idle'),
  row(19, 'snoozed', { until: NOW + 2 * DAY }),
  row(20, 'snoozed', { until: NOW + DAY }),
  row(12, 'done', { closedAt: NOW - 2 * DAY }),
  row(11, 'dropped', { closedAt: NOW - 3 * DAY }),
  row(5, 'done', { closedAt: NOW - 9 * DAY }),
  row(30, 'working', { requestedBy: 'other' }),
  row(31, 'working', { parent: 14 }),
];

const keys = (groups: readonly TodoGroup[]) => groups.map(group => [group.key, group.entries.map(entry => entry.row.todo.number)]);

describe('a Session\'s To-dos tab (T-23)', () => {
  it('groups its to-dos as the To-dos screen does, with the done ones from this week last', () => {
    const groups = sessionTodoGroups(sessionTodoEntries(rows, 'billing'), NOW);
    expect(keys(groups)).toEqual([
      ['status:waiting', [15]],
      ['status:working', [14, 16]],
      ['status:queued', [17]],
      ['status:idle', [18]],
      // Soonest first.
      ['status:snoozed', [20, 19]],
      // Newest first; a to-do closed nine days ago stays on the To-dos screen.
      ['status:done', [12, 11]],
    ]);
    expect(groups.map(group => group.label)).toEqual(['Waiting on you', 'Working', 'Queued', 'Idle', 'Snoozed', 'Done this week']);
  });

  it('counts the open ones, leaving out snoozed and done', () => {
    const entries = sessionTodoEntries(rows, 'billing');
    expect(sessionOpenCount(entries)).toBe(5);
  });

  it('a done to-do counts as this week for seven days after it closed', () => {
    const edge = [row(1, 'done', { closedAt: NOW - DONE_THIS_WEEK_MS + 1 }), row(2, 'done', { closedAt: NOW - DONE_THIS_WEEK_MS - 1 })];
    expect(keys(sessionTodoGroups(sessionTodoEntries(edge, 'billing'), NOW))).toEqual([['status:done', [1]]]);
  });

  it('keys each entry by machine and number, as the To-dos screen does', () => {
    expect(sessionTodoEntries([row(15, 'waiting')], 'billing', 'studio')[0]).toMatchObject({ key: 'studio:15', machineId: 'studio', remote: false });
  });

  it('starts with Snoozed folded beside other groups, and Done this week always folded', () => {
    const groups = sessionTodoGroups(sessionTodoEntries(rows, 'billing'), NOW);
    const folded = groups.filter(group => sessionGroupFolded({}, group, groups.length)).map(group => group.key);
    expect(folded).toEqual(['status:snoozed', 'status:done']);
    const alone = sessionTodoGroups(sessionTodoEntries([row(19, 'snoozed', { until: NOW + DAY })], 'billing'), NOW);
    expect(sessionGroupFolded({}, alone[0], alone.length)).toBe(false);
    const done = sessionTodoGroups(sessionTodoEntries([row(12, 'done', { closedAt: NOW - DAY })], 'billing'), NOW);
    expect(sessionGroupFolded({}, done[0], done.length)).toBe(true);
  });

  it('keeps the person\'s folds', () => {
    const groups = sessionTodoGroups(sessionTodoEntries(rows, 'billing'), NOW);
    const folds = withSessionFold(withSessionFold({}, 'status:done', false), 'status:working', true);
    const folded = groups.filter(group => sessionGroupFolded(folds, group, groups.length)).map(group => group.key);
    expect(folded).toEqual(['status:working', 'status:snoozed']);
  });

  it('steps an open to-do through the rows shown, held at the ends', () => {
    const groups = sessionTodoGroups(sessionTodoEntries(rows, 'billing'), NOW);
    const stops = listStops(groups, group => sessionGroupFolded({}, group, groups.length));
    expect(stepTodo(stops, groups, 'local:15', 1)).toBe('local:14');
    expect(stepTodo(stops, groups, 'local:14', -1)).toBe('local:15');
    expect(stepTodo(stops, groups, 'local:15', -1)).toBe('local:15');
    // The last row shown is Idle's: folded Snoozed and Done this week are passed over.
    expect(stepTodo(stops, groups, 'local:18', 1)).toBe('local:18');
  });

  it('steps through every row when the open one sits in a folded group', () => {
    const groups = sessionTodoGroups(sessionTodoEntries(rows, 'billing'), NOW);
    const stops = listStops(groups, group => sessionGroupFolded({}, group, groups.length));
    expect(stepTodo(stops, groups, 'local:20', 1)).toBe('local:19');
    expect(stepTodo(stops, groups, 'local:12', -1)).toBe('local:19');
    // A sub-to-do opened from its parent's page isn't in the list: nothing to step to.
    expect(stepTodo(stops, groups, 'local:31', 1)).toBeNull();
  });
});
