import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import type { TodoListRow, TodoRecord } from '../../../../shared/types/todos';
import { inTodoScope, sessionTodos, todoApprovalScope, todoRefOf } from './sessionTodos';

function row(number: number, opts: { own?: string; requestedBy?: string; parent?: number; state?: TodoRecord['state'] } = {}): TodoListRow {
  const todo: TodoRecord = {
    number, ref: `T-${number}`, sessionId: opts.own ?? null, parentNumber: opts.parent ?? null, title: `To-do ${number}`, summary: '', doneWhen: [],
    state: opts.state ?? 'in_progress', requester: { kind: 'person', name: 'you' }, projectId: null, agent: null, assignee: null, createdBy: 'you',
    createdAt: 0, startedAt: null, updatedAt: number, acceptedAt: null, closedAt: null, lastProgressAt: null, stuckSince: null, episodeReminders: 0,
    episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
  };
  if (opts.requestedBy) todo.requester = { kind: 'orchestrator', name: 'UI/UX orchestrator', sessionId: opts.requestedBy, panelId: 'p' };
  return { todo, status: { status: 'working', reason: '' }, machine: 'This Mac' };
}

function item(id: string, opts: { session?: string; todo?: number; connected?: string } = {}): NotifyItem {
  const made: NotifyItem = { id, ui: 'options', title: id, state: 'waiting', createdAt: 1, source: { name: 'agent', agent: 'Agent' } };
  if (opts.session) made.source.session = { id: opts.session, name: 's', paneId: 'p' };
  if (opts.todo) made.todo = { number: opts.todo, title: `To-do ${opts.todo}` };
  if (opts.connected) made.connected = { kind: 'session', id: opts.connected, name: 'c', paneId: 'p' };
  return made;
}

const rows = [
  row(3, { own: 'hidden-3', requestedBy: 'uiux' }),
  row(10, { own: 'hidden-10', requestedBy: 'uiux' }),
  row(11, { parent: 10, requestedBy: 'uiux' }),
  row(12, { own: 'hidden-12', requestedBy: 'billing' }),
  row(13, { own: 'hidden-13' }),
];

describe('a Session\'s to-dos (T-22, T-23)', () => {
  it('lists the top-level to-dos a Session requested, and none for a Session that requested none', () => {
    expect(sessionTodos(rows, 'uiux').map(r => r.todo.number)).toEqual([3, 10]);
    expect(sessionTodos(rows, 'nobody')).toEqual([]);
  });

  it('a to-do\'s own hidden Session lists that to-do', () => {
    expect(sessionTodos(rows, 'hidden-13').map(r => r.todo.number)).toEqual([13]);
  });

  it('scopes a Session\'s approvals to its to-dos\' hidden Sessions and numbers', () => {
    const scope = todoApprovalScope(rows, 'uiux');
    expect(inTodoScope(item('perm', { session: 'hidden-3' }), scope)).toBe(true);
    expect(inTodoScope(item('review', { todo: 10 }), scope)).toBe(true);
    expect(inTodoScope(item('sub', { todo: 11 }), scope)).toBe(true);
    expect(inTodoScope(item('conn', { connected: 'hidden-10' }), scope)).toBe(true);
    expect(inTodoScope(item('other', { session: 'hidden-12', todo: 12 }), scope)).toBe(false);
    expect(inTodoScope(item('plain', { session: 'uiux' }), scope)).toBe(false);
  });

  it('a closed to-do no longer brings its approvals', () => {
    const scope = todoApprovalScope([row(5, { own: 'hidden-5', requestedBy: 'uiux', state: 'done' })], 'uiux');
    expect(inTodoScope(item('late', { session: 'hidden-5' }), scope)).toBe(false);
  });

  it('names the to-do an approval belongs to (T-24): linked, or asked in its hidden Session; none for the Session\'s own', () => {
    expect(todoRefOf(item('review', { todo: 10 }), rows, 'uiux')).toBe('T-10');
    expect(todoRefOf(item('perm', { session: 'hidden-3' }), rows, 'uiux')).toBe('T-3');
    expect(todoRefOf(item('own', { session: 'uiux' }), rows, 'uiux')).toBeUndefined();
    expect(todoRefOf(item('in-own-hidden', { session: 'hidden-13' }), rows, 'hidden-13')).toBeUndefined();
  });
});
