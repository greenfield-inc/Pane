import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import type { TodoListRow, TodoRecord } from '../../../../shared/types/todos';
import { approvalsByTodo, inTodoScope, sessionTodos, todoApprovalScope, todoRefOf } from './sessionTodos';

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

  it('counts each approval on its top-level to-do (T-37): linked, through a sub-to-do, or asked or connected in its hidden Session', () => {
    const counts = approvalsByTodo([
      item('review', { todo: 10 }),
      item('sub', { todo: 11 }),
      item('perm', { session: 'hidden-3' }),
      item('conn', { connected: 'hidden-10' }),
      item('stray', { session: 'nobody' }),
    ], rows, 'local');
    expect(Object.fromEntries(counts)).toEqual({ 'local:3': 1, 'local:10': 3 });
  });
});

describe('to-dos keyed by machine and number (T-51)', () => {
  // The reported bug: the MacBook's Q-84, linked to the MacBook's T-28, docked in the mini's Firecracker Grain, whose
  // T-27 has a sub-to-do that is also numbered T-28.
  const mini = [row(27, { own: 'hidden-27', requestedBy: 'firecracker' }), row(28, { parent: 27, requestedBy: 'firecracker' })];
  const fromMacbook = (made: NotifyItem): NotifyItem => ({ ...made, machineId: 'macbook', machine: 'Tylers-MacBook-Pro' });

  it('another machine\'s T-28 is not in a local Session\'s scope; this machine\'s T-28 is', () => {
    const scope = todoApprovalScope(mini, 'firecracker', 'local');
    expect(inTodoScope(fromMacbook(item('q-84', { session: 'workspaces', todo: 28 })), scope)).toBe(false);
    expect(inTodoScope(item('local-28', { todo: 28 }), scope)).toBe(true);
    expect(inTodoScope({ ...item('local-28', { todo: 28 }), machineId: 'local' }, scope)).toBe(true);
  });

  it('a row\'s count takes only its own machine\'s card on that number (T-51 PR 5, the lint rule\'s hit)', () => {
    const counts = approvalsByTodo([fromMacbook(item('q-84', { todo: 28 })), item('local-28', { todo: 28 })], mini, 'local');
    expect(Object.fromEntries(counts)).toEqual({ 'local:27': 1 });
    expect(Object.fromEntries(approvalsByTodo([fromMacbook(item('q-84', { todo: 28 }))], mini, 'local'))).toEqual({});
    expect(Object.fromEntries(approvalsByTodo([fromMacbook(item('q-84', { todo: 28 }))], mini, 'macbook'))).toEqual({ 'macbook:27': 1 });
  });

  it('a card from another machine asked or connected in a Session with the same id counts nowhere (review F-5)', () => {
    const asked = fromMacbook(item('q-90', { session: 'hidden-27' }));
    const connected = fromMacbook(item('q-91', { connected: 'hidden-27' }));
    expect(Object.fromEntries(approvalsByTodo([asked, connected], mini, 'local'))).toEqual({});
    expect(Object.fromEntries(approvalsByTodo([item('own', { session: 'hidden-27' })], mini, 'local'))).toEqual({ 'local:27': 1 });
  });

  it('builds nothing when no approval is waiting (review F-6)', () => {
    const untouched = Object.defineProperty([...mini], 'map', { value: () => { throw new Error('rows were indexed'); } });
    expect(approvalsByTodo([], untouched, 'local').size).toBe(0);
  });

  it('a hidden Session\'s card counts only from the to-do\'s own machine', () => {
    const scope = todoApprovalScope(mini, 'firecracker', 'local');
    expect(inTodoScope(item('perm', { session: 'hidden-27' }), scope)).toBe(true);
    expect(inTodoScope(fromMacbook(item('perm', { session: 'hidden-27' })), scope)).toBe(false);
    expect(inTodoScope(fromMacbook(item('conn', { connected: 'hidden-27' })), scope)).toBe(false);
  });

  it('a saved machine\'s Session takes that machine\'s cards, not this one\'s', () => {
    const scope = todoApprovalScope(mini, 'firecracker', 'macbook');
    expect(inTodoScope(fromMacbook(item('q-84', { todo: 28 })), scope)).toBe(true);
    expect(inTodoScope(item('local-28', { todo: 28 }), scope)).toBe(false);
  });
});
