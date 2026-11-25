import { describe, expect, it } from 'vitest';
import type { TodoListRow, TodoRecord, TodoShownStatus, TodoState, TodosSnapshot } from '../../../../shared/types/todos';
import type { RemoteTodos } from '../../stores/todosStore';
import {
  actionForKey, canSnooze, entryAction, flattenGroups, foldKey, groupTodos, isFolded, listStops, mergeTodoEntries, moveSelection, navSummary, nextGrouping,
  nextWake, otherMachines, readFolds, resolveStop, rowAction, stopAfterLeaving, tabCounts, withFold, type TodoFolds,
} from './todoList';
import type { MachineState } from '../../../../shared/types/machineConnections';

interface RowSeed {
  number: number;
  state?: TodoState;
  status?: TodoShownStatus;
  updatedAt?: number;
  parent?: number;
  requester?: string;
  project?: string;
  machine?: string;
  /** Snoozed until this time (ms). */
  until?: number;
  remind?: boolean;
}

function row(seed: RowSeed): TodoListRow {
  const todo: TodoRecord = {
    number: seed.number, ref: `T-${seed.number}`, sessionId: null, parentNumber: seed.parent ?? null, title: `To-do ${seed.number}`, summary: '',
    doneWhen: [], state: seed.state ?? 'in_progress',
    requester: seed.requester ? { kind: 'orchestrator', name: seed.requester } : { kind: 'person', name: 'you' },
    projectId: null, agent: null, assignee: null, createdBy: 'you', createdAt: 0, startedAt: null, updatedAt: seed.updatedAt ?? seed.number,
    acceptedAt: null, closedAt: null, lastProgressAt: null, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0,
    stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
  if (seed.until !== undefined) {
    todo.snooze = { until: seed.until, zone: 'UTC', note: '', action: seed.remind ? 'remind' : 'agents', by: 'you', from: 'in_progress', reminderCardId: null };
  }
  return { todo, status: { status: seed.status ?? (seed.until !== undefined ? 'snoozed' : 'working'), reason: '' }, projectName: seed.project, machine: seed.machine ?? 'This Mac' };
}

function snapshot(rows: TodoListRow[]): TodosSnapshot {
  return { rows, gate: { state: 'normal', enabled: true, since: 0 }, machine: 'This Mac', ownSessionIds: [] };
}

const local = snapshot([
  row({ number: 16, status: 'waiting', updatedAt: 90, requester: 'UI/UX improvements', project: 'Pane' }),
  row({ number: 12, status: 'working', updatedAt: 98, requester: 'UI/UX improvements', project: 'Pane' }),
  row({ number: 14, status: 'working', parent: 12 }),
  row({ number: 24, state: 'todo', status: 'queued', updatedAt: 20, requester: 'Billing rewrite', project: 'billing-api' }),
  row({ number: 31, state: 'stopped', status: 'idle', updatedAt: 1, project: 'docs-site' }),
  row({ number: 9, state: 'done', status: 'done', updatedAt: 5 }),
]);

describe('mergeTodoEntries', () => {
  it('lists top-level to-dos only, newest change first', () => {
    const entries = mergeTodoEntries(local, []);
    expect(entries.map(entry => entry.row.todo.number)).toEqual([12, 16, 24, 9, 31]);
  });

  it('adds a saved machine under its name, and reads it Idle · machine offline while unreachable', () => {
    const remote: RemoteTodos = { machineId: 'devbox-id', label: 'devbox', offline: true, snapshot: snapshot([row({ number: 12, status: 'working', updatedAt: 99 }), row({ number: 3, state: 'done', status: 'done', updatedAt: 2 })]) };
    const entries = mergeTodoEntries(local, [remote]);
    const devbox = entries.filter(entry => entry.remote);
    expect(devbox.map(entry => entry.key)).toEqual(['devbox-id:12', 'devbox-id:3']);
    expect(devbox[0].row.status).toMatchObject({ status: 'idle', reason: 'machine offline' });
    expect(devbox[0].row.machine).toBe('devbox');
    // Closed ones keep their status.
    expect(devbox[1].row.status.status).toBe('done');
    // Nothing to do on an unreachable machine; an online one's rows act there.
    expect(entryAction(devbox[0])).toBeNull();
    const online = mergeTodoEntries(null, [{ ...remote, offline: false }]);
    expect(entryAction(online[0])).toBe('stop');
  });
});

describe('tabs and counts', () => {
  const entries = mergeTodoEntries(local, []);

  it('counts each tab', () => {
    expect(tabCounts(entries)).toEqual({ open: 4, waiting: 1, snoozed: 0, done: 1, all: 5 });
  });

  it('groups by status in order, skipping empty groups', () => {
    const groups = groupTodos(entries, 'open', 'status');
    expect(groups.map(group => [group.label, group.entries.length])).toEqual([['Waiting on you', 1], ['Working', 1], ['Queued', 1], ['Idle', 1]]);
    expect(flattenGroups(groups).map(entry => entry.row.todo.number)).toEqual([16, 12, 24, 31]);
  });

  it('groups by requester, repo and machine', () => {
    expect(groupTodos(entries, 'open', 'requester').map(group => group.label)).toEqual(['UI/UX improvements', 'Billing rewrite', 'You']);
    expect(groupTodos(entries, 'open', 'repo').map(group => group.label)).toEqual(['Pane', 'billing-api', 'docs-site']);
    expect(groupTodos(entries, 'all', 'machine').map(group => group.label)).toEqual(['This Mac']);
  });

  it('shows only waiting or closed to-dos on those tabs', () => {
    expect(flattenGroups(groupTodos(entries, 'waiting', 'status')).map(entry => entry.row.todo.number)).toEqual([16]);
    expect(flattenGroups(groupTodos(entries, 'done', 'status')).map(entry => entry.row.todo.number)).toEqual([9]);
  });

  it('puts this machine first when grouped by machine', () => {
    const remote: RemoteTodos = { machineId: 'devbox-id', label: 'devbox', offline: false, snapshot: snapshot([row({ number: 2, updatedAt: 1000 })]) };
    expect(groupTodos(mergeTodoEntries(local, [remote]), 'open', 'machine').map(group => group.label)).toEqual(['This Mac', 'devbox']);
  });
});

describe('actions and keys', () => {
  it('offers Start anyway while queued, Start before it ran, Resume once stopped, Stop otherwise', () => {
    expect(rowAction(row({ number: 1, state: 'in_progress', status: 'queued' }))).toBe('start-anyway');
    expect(rowAction(row({ number: 1, state: 'todo', status: 'idle' }))).toBe('start');
    expect(rowAction(row({ number: 1, state: 'stopped', status: 'idle' }))).toBe('resume');
    expect(rowAction(row({ number: 1, state: 'in_review', status: 'waiting' }))).toBe('stop');
    expect(rowAction(row({ number: 1, state: 'done', status: 'done' }))).toBeNull();
  });

  it('S stops and R resumes or starts, and nothing else', () => {
    const stopped = row({ number: 1, state: 'stopped', status: 'idle' });
    const moving = row({ number: 2 });
    expect(actionForKey(stopped, 'r')).toBe('resume');
    expect(actionForKey(stopped, 's')).toBeNull();
    expect(actionForKey(moving, 's')).toBe('stop');
    expect(actionForKey(moving, 'r')).toBeNull();
    expect(actionForKey(row({ number: 3, state: 'todo', status: 'queued' }), 'r')).toBeNull();
  });

  it('J and K hold at the ends; G cycles the groupings', () => {
    expect(moveSelection(0, 3, -1)).toBe(0);
    expect(moveSelection(2, 3, 1)).toBe(2);
    expect(moveSelection(1, 3, 1)).toBe(2);
    expect(moveSelection(0, 0, 1)).toBe(0);
    expect(nextGrouping('status')).toBe('requester');
    expect(nextGrouping('machine')).toBe('status');
  });
});

describe('navSummary', () => {
  it('counts open to-dos waiting on you and notes any working', () => {
    expect(navSummary(mergeTodoEntries(local, []))).toEqual({ waiting: 1, working: true });
    expect(navSummary([])).toEqual({ waiting: 0, working: false });
  });
});

describe('otherMachines (T-8)', () => {
  const machine = (id: string, kind: MachineState['kind'], installId?: string): MachineState => ({ id, label: id, kind, status: 'online', offlineSince: null, installId });

  it('leaves out a saved machine that is this computer read over a connection, so its to-dos are not listed twice', () => {
    const machines = [machine('local', 'local', 'mac-1'), machine('self', 'remote', 'mac-1'), machine('devbox', 'remote', 'box-9')];
    expect(otherMachines(machines).map(m => m.id)).toEqual(['devbox']);
  });

  it('leaves out the computer this window shows in remote mode: its to-dos are already the list\'s own rows', () => {
    const machines = [machine('local', 'local', 'book-2'), machine('mini', 'remote', 'mini-1'), machine('devbox', 'remote', 'box-9')];
    expect(otherMachines(machines, 'mini').map(m => m.id)).toEqual(['devbox']);
  });

  it('keeps saved machines whose install id is not known yet, and every machine when this computer has none', () => {
    expect(otherMachines([machine('local', 'local', 'mac-1'), machine('new', 'remote')]).map(m => m.id)).toEqual(['new']);
    expect(otherMachines([machine('local', 'local'), machine('devbox', 'remote', 'box-9')]).map(m => m.id)).toEqual(['devbox']);
  });
});

describe('snoozed (round 9, T-17)', () => {
  const snoozed = snapshot([
    row({ number: 1, status: 'working', updatedAt: 50, project: 'Pane' }),
    row({ number: 2, state: 'stopped', status: 'idle', updatedAt: 40, project: 'Pane' }),
    row({ number: 19, state: 'stopped', until: 9_000, updatedAt: 99, project: 'Pane' }),
    row({ number: 21, state: 'todo', until: 3_000, remind: true, updatedAt: 98, project: 'docs-site' }),
  ]);
  const entries = mergeTodoEntries(snoozed, []);

  it('groups Snoozed after Idle, soonest first, with its own tab and count', () => {
    const groups = groupTodos(entries, 'open', 'status');
    expect(groups.map(group => group.label)).toEqual(['Working', 'Idle', 'Snoozed']);
    expect(groups[2].entries.map(entry => entry.row.todo.number)).toEqual([21, 19]);
    expect(nextWake(groups[2])).toBe(3_000);
    expect(nextWake(groups[0])).toBeNull();
    expect(tabCounts(entries)).toMatchObject({ open: 4, snoozed: 2 });
    expect(flattenGroups(groupTodos(entries, 'snoozed', 'status')).map(entry => entry.row.todo.number)).toEqual([21, 19]);
  });

  it('R wakes a snoozed row now; Z snoozes top-level open to-dos that are not in review or accepted', () => {
    // oxlint-disable-next-line pane/no-bare-todo-number -- the fixture rows are one machine's.
    const asleep = entries.find(entry => entry.row.todo.number === 19)!;
    expect(rowAction(asleep.row)).toBe('wake');
    expect(actionForKey(asleep.row, 'r')).toBe('wake');
    expect(actionForKey(asleep.row, 's')).toBeNull();
    expect(canSnooze(asleep)).toBe(true);
    // oxlint-disable-next-line pane/no-bare-todo-number -- the fixture rows are one machine's.
    expect(canSnooze(entries.find(entry => entry.row.todo.number === 1)!)).toBe(true);
    expect(canSnooze(mergeTodoEntries(snapshot([row({ number: 5, state: 'in_review', status: 'waiting' })]), [])[0])).toBe(false);
    expect(canSnooze(mergeTodoEntries(snapshot([row({ number: 6, state: 'done', status: 'done' })]), [])[0])).toBe(false);
  });

  it('keeps a snoozed to-do Snoozed while its machine is offline (its row adds "machine offline")', () => {
    const remote: RemoteTodos = { machineId: 'devbox', label: 'devbox', offline: true, snapshot: snapshot([row({ number: 7, state: 'stopped', until: 5_000 })]) };
    const [entry] = mergeTodoEntries(null, [remote]);
    expect(entry.row.status.status).toBe('snoozed');
    expect(entryAction(entry)).toBeNull();
    expect(canSnooze(entry)).toBe(false);
  });
});

describe('folding groups (D-432)', () => {
  const entries = mergeTodoEntries(snapshot([
    row({ number: 1, status: 'working', updatedAt: 50, project: 'Pane' }),
    row({ number: 3, status: 'working', updatedAt: 45, project: 'Pane' }),
    row({ number: 2, state: 'stopped', status: 'idle', updatedAt: 40, project: 'docs-site' }),
    row({ number: 19, state: 'stopped', until: 9_000, updatedAt: 99, project: 'Pane' }),
    row({ number: 21, state: 'todo', until: 3_000, updatedAt: 98, project: 'docs-site' }),
  ]), []);
  const none: TodoFolds = {};

  it('Snoozed starts folded where there are other groups, and open in the Snoozed tab', () => {
    const open = groupTodos(entries, 'open', 'status');
    expect(open.map(group => isFolded(none, 'open', 'status', group, open.length))).toEqual([false, false, true]);
    const tab = groupTodos(entries, 'snoozed', 'status');
    expect(isFolded(none, 'snoozed', 'status', tab[0], tab.length)).toBe(false);
  });

  it('remembers each fold per tab × grouping × group, and an opened Snoozed stays open', () => {
    const open = groupTodos(entries, 'open', 'status');
    let folds = withFold(none, 'open', 'status', 'status:idle', true);
    folds = withFold(folds, 'open', 'status', 'status:snoozed', false);
    expect(open.map(group => isFolded(folds, 'open', 'status', group, open.length))).toEqual([false, true, false]);
    expect(folds[foldKey('open', 'status', 'status:idle')]).toBe(true);
    // Idle folded in Open by status doesn't fold it under Waiting on you, or in Open by repo.
    expect(isFolded(folds, 'all', 'status', open[1], open.length)).toBe(false);
    const repo = groupTodos(entries, 'open', 'repo');
    expect(repo.map(group => isFolded(folds, 'open', 'repo', group, repo.length))).toEqual([false, false]);
  });

  it('J/K stops: every row of an open group, and a folded group once, by its header', () => {
    const groups = groupTodos(entries, 'open', 'status');
    const stops = listStops(groups, group => isFolded(none, 'open', 'status', group, groups.length));
    expect(stops.map(stop => stop.key)).toEqual(['local:1', 'local:3', 'local:2', 'group:status:snoozed']);
    const folded = withFold(none, 'open', 'status', 'status:working', true);
    expect(listStops(groups, group => isFolded(folded, 'open', 'status', group, groups.length)).map(stop => stop.key))
      .toEqual(['group:status:working', 'local:2', 'group:status:snoozed']);
  });

  it('a selected row whose group folds resolves to that header; an unknown key to the first stop', () => {
    const groups = groupTodos(entries, 'open', 'status');
    const stops = listStops(groups, group => isFolded(none, 'open', 'status', group, groups.length));
    expect(resolveStop(stops, groups, 'local:21')).toBe(3);
    expect(resolveStop(stops, groups, 'local:3')).toBe(1);
    expect(resolveStop(stops, groups, 'nope')).toBe(0);
    expect(resolveStop([], groups, 'local:1')).toBe(-1);
  });

  it('a row leaving for a folded group hands the selection to the next stop, or the one before at the end', () => {
    const groups = groupTodos(entries, 'open', 'status');
    const stops = listStops(groups, group => isFolded(none, 'open', 'status', group, groups.length));
    expect(stopAfterLeaving(stops, 'local:3')).toBe('local:2');
    expect(stopAfterLeaving(stops.slice(0, 3), 'local:2')).toBe('local:3');
    expect(stopAfterLeaving(stops, 'missing')).toBeNull();
  });

  it('reads saved folds, and anything unreadable as none', () => {
    const storage = new Map<string, string>();
    const store = { getItem: (key: string) => storage.get(key) ?? null };
    expect(readFolds(store)).toEqual({});
    storage.set('pane-todos-folds', '{"open|status|status:idle":true,"open|status|status:snoozed":false}');
    expect(readFolds(store)).toEqual({ 'open|status|status:idle': true, 'open|status|status:snoozed': false });
    storage.set('pane-todos-folds', '{"bad":"x"}');
    expect(readFolds(store)).toEqual({});
    storage.set('pane-todos-folds', 'not json');
    expect(readFolds(store)).toEqual({});
  });
});
