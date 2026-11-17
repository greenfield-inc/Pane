import { describe, expect, it } from 'vitest';
import type { TodoListRow, TodoRecord, TodoShownStatus, TodoState, TodosSnapshot } from '../../../../shared/types/todos';
import type { RemoteTodos } from '../../stores/todosStore';
import {
  actionForKey, entryAction, flattenGroups, groupTodos, mergeTodoEntries, moveSelection, navSummary, nextGrouping, rowAction, tabCounts,
} from './todoList';

interface RowSeed {
  number: number;
  state?: TodoState;
  status?: TodoShownStatus;
  updatedAt?: number;
  parent?: number;
  requester?: string;
  project?: string;
  machine?: string;
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
  return { todo, status: { status: seed.status ?? 'working', reason: '' }, projectName: seed.project, machine: seed.machine ?? 'This Mac' };
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
    expect(tabCounts(entries)).toEqual({ open: 4, waiting: 1, done: 1, all: 5 });
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
