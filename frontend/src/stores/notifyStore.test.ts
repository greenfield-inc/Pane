import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifyItem, NotifySnapshot } from '../../../shared/types/notify';
import { notifyFixture } from '../../../tests/fixtures/notifySnapshot';
import { archiveApprovals, paneHasWaitingQuestion, selectNotifyItems, sendArchived, sessionWaitingCount, subscribeNotify, todosWaitingCount, undoArchive, useNotifyStore, waitingCount, waitingElsewhere } from './notifyStore';
import { EMPTY_TODO_SCOPE } from '../components/todos/sessionTodos';

const launch = { id: 'session-launch', name: 'Launch', paneId: 'session-launch-pane' };

function withItems(...items: NotifyItem[]): NotifySnapshot {
  return { ...notifyFixture(), items };
}
const item = (id: string, extra: Partial<NotifyItem> = {}): NotifyItem =>
  ({ id, ui: 'approve', title: id, source: { name: 'x', agent: 'Claude', session: launch }, state: 'waiting', createdAt: 1, ...extra });

describe('Approvals counts', () => {
  it("counts a Session's waiting items, its fallback items included, and not answers in their Undo hold", () => {
    const snapshot = withItems(
      item('orchestrator', { source: { name: 'Launch', agent: 'Claude', session: { ...launch, orchestrator: true } } }),
      item('prompt'),
      item('fallback', { ui: 'info', relay: { inboxItemId: 'in-1', worker: 'api-fix', question: 'Id or number?' } }),
      item('held', { state: 'sent' }),
      item('done', { state: 'answered' }),
      item('loose', { source: { name: 'docs', agent: 'Cursor' } }),
    );
    // A mirror from an older machine takes no answer, so it isn't counted.
    expect(sessionWaitingCount(snapshot, 'session-launch')).toBe(2);
    expect(sessionWaitingCount(snapshot, 'session-other')).toBe(0);
    expect(sessionWaitingCount(snapshot, 'session-launch', 'local')).toBe(2);
    expect(sessionWaitingCount(snapshot, 'session-launch', 'studio')).toBe(0);
    // The badge: every Session's count plus what isn't in a Session.
    expect(waitingCount(snapshot)).toBe(3);
  });

  it('leaves stale items and an offline machine\'s items out of every count', () => {
    const snapshot = withItems(
      item('live'),
      item('stale', { staleSince: 5 }),
      item('offline', { machineId: 'studio', unreachable: true }),
    );
    expect(waitingCount(snapshot)).toBe(1);
    expect(sessionWaitingCount(snapshot, 'session-launch')).toBe(1);
    expect(waitingElsewhere(snapshot, 'local')).toBe(0);
    expect(paneHasWaitingQuestion(withItems(item('stale', { staleSince: 5, source: { name: 'x', agent: 'Claude', paneId: 'p' } })), 'p')).toBe(false);
  });

  it("leaves dismissed items out of their Session's row count, which still counts a genuinely open one", () => {
    const dismissed = withItems(item('a', { dismissedAt: 5 }), item('b', { dismissedAt: 6, machineId: 'studio' }));
    expect(sessionWaitingCount(dismissed, 'session-launch')).toBe(0);
    expect(sessionWaitingCount(dismissed, 'session-launch', 'studio')).toBe(0);
    // Still waiting in Approvals: the overall count keeps them.
    expect(waitingCount(dismissed)).toBe(2);
    expect(sessionWaitingCount(withItems(item('a', { dismissedAt: 5 }), item('open')), 'session-launch')).toBe(1);
  });

  it('says how many wait on machines other than the one the app is on', () => {
    const snapshot = withItems(
      item('here'),
      item('local', { machineId: 'local' }),
      item('studio:q-1', { machineId: 'studio' }),
      item('studio:q-2', { machineId: 'studio', state: 'answered' }),
    );
    expect(waitingElsewhere(snapshot, 'local')).toBe(1);
    expect(waitingElsewhere(snapshot, 'studio')).toBe(2);
  });

  it("counts a Session's to-dos' waiting approvals once each, for its To-dos tab (T-23)", () => {
    const hidden = { id: 'hidden-15', name: 'T-15', paneId: 'p-15' };
    const scope = { sessionIds: new Set(['hidden-15']), todoNumbers: new Set([15, 16]) };
    const snapshot = withItems(
      // Linked to T-15 and asked in its hidden Session: one approval, counted once.
      item('q-31', { source: { name: 'planner', agent: 'Claude', session: hidden }, todo: { number: 15, title: 'Cadence' } }),
      item('perm', { source: { name: 'T-15', agent: 'Claude', session: hidden } }),
      item('review', { todo: { number: 16, title: 'Copy', kind: 'review' } }),
      // The Session's own question isn't a to-do's.
      item('own'),
      item('answered', { todo: { number: 15, title: 'Cadence' }, state: 'sent' }),
      item('dismissed', { todo: { number: 16, title: 'Copy' }, dismissedAt: 5 }),
      item('elsewhere', { todo: { number: 15, title: 'Cadence' }, machineId: 'studio' }),
    );
    expect(todosWaitingCount(snapshot, scope)).toBe(4);
    expect(todosWaitingCount(snapshot, scope, 'local')).toBe(3);
    expect(todosWaitingCount(snapshot, EMPTY_TODO_SCOPE)).toBe(0);
    expect(todosWaitingCount(null, scope)).toBe(0);
  });
});

describe('selectNotifyItems', () => {
  it('returns the same empty list every time before the first snapshot, so a component reading it never loops (review F-3)', () => {
    expect(selectNotifyItems({ snapshot: null })).toBe(selectNotifyItems({ snapshot: null }));
    expect(selectNotifyItems({ snapshot: null })).toEqual([]);
  });
});

describe('Archive', () => {
  afterEach(() => vi.unstubAllGlobals());

  let push: (snapshot: NotifySnapshot) => void = () => undefined;
  function connect(snapshot: NotifySnapshot, refuse = false) {
    const run = vi.fn(async () => { if (refuse) throw new Error('offline'); });
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: { notify: { run, onSnapshot: (listener: (next: NotifySnapshot) => void) => { push = listener; return () => undefined; }, getSnapshot: async () => snapshot } },
    });
    subscribeNotify();
    return run;
  }

  it('takes archived items out of every count at once, sends nothing until the Undo ends, then closes each with no reason', async () => {
    const loop = [item('run-1'), item('run-2'), item('other', { source: { name: 'docs', agent: 'Cursor' } })];
    const run = connect(withItems(...loop));
    await vi.waitFor(() => expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(3));

    // A second archive joins the first: one toast, and Undo brings back both (D-104).
    archiveApprovals([loop[0]]);
    archiveApprovals([loop[1]]);
    expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(1);
    expect(useNotifyStore.getState().archived?.message).toBe('Archived 2 approvals');
    expect(run).not.toHaveBeenCalled();

    undoArchive();
    expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(3);

    archiveApprovals([loop[0]]);
    sendArchived();
    // Sending again (the screen closing after the toast ended) sends nothing twice.
    sendArchived();
    expect(run.mock.calls).toEqual([[{ type: 'close', id: 'run-1' }]]);
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'run-2' }));
  });

  it('sends no close for an item answered elsewhere while it was held', async () => {
    const run = connect(withItems(item('asked')));
    await vi.waitFor(() => expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(1));
    archiveApprovals([item('asked')]);
    push(withItems(item('asked', { state: 'answered' })));
    sendArchived();
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps a sent row out until a snapshot shows it closed, and brings it back when the close is refused', async () => {
    const run = connect(withItems(item('a'), item('b')));
    await vi.waitFor(() => expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(2));
    archiveApprovals([item('a')]);
    sendArchived();
    // Main has answered the close…
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ type: 'close', id: 'a' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // …and its next snapshot still lists the row as waiting: the row stays out instead of flashing back.
    push(withItems(item('a'), item('b')));
    expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(1);
    push(withItems(item('a', { state: 'expired' }), item('b')));
    push(withItems(item('a', { state: 'expired' }), item('b')));
    expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(1);
  });

  it('brings a row back at once when its close is refused', async () => {
    connect(withItems(item('a')), true);
    await vi.waitFor(() => expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(1));
    archiveApprovals([item('a')]);
    sendArchived();
    await vi.waitFor(() => expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(1));
  });
});
