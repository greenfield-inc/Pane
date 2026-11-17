import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifyItem, NotifySnapshot } from '../../../shared/types/notify';
import { notifyFixture } from '../../../tests/fixtures/notifySnapshot';
import { archiveApprovals, paneHasWaitingQuestion, selectNotifyItems, sendArchived, sessionWaitingCount, subscribeNotify, undoArchive, useNotifyStore, waitingCount, waitingElsewhere } from './notifyStore';

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
});

describe('selectNotifyItems', () => {
  it('returns the same empty list every time before the first snapshot, so a component reading it never loops (review F-3)', () => {
    expect(selectNotifyItems({ snapshot: null })).toBe(selectNotifyItems({ snapshot: null }));
    expect(selectNotifyItems({ snapshot: null })).toEqual([]);
  });
});

describe('Archive', () => {
  afterEach(() => vi.unstubAllGlobals());

  function connect(snapshot: NotifySnapshot) {
    const run = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      electronAPI: { notify: { run, onSnapshot: () => () => undefined, getSnapshot: async () => snapshot } },
    });
    subscribeNotify();
    return run;
  }

  it('takes archived items out of every count at once, sends nothing until the Undo ends, then closes each with no reason', async () => {
    const loop = [item('run-1'), item('run-2'), item('other', { source: { name: 'docs', agent: 'Cursor' } })];
    const run = connect(withItems(...loop));
    await vi.waitFor(() => expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(3));

    archiveApprovals(loop.slice(0, 2));
    expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(1);
    expect(useNotifyStore.getState().archived?.message).toBe('Archived 2 approvals');

    undoArchive();
    expect(waitingCount(useNotifyStore.getState().snapshot)).toBe(3);

    archiveApprovals([loop[0]]);
    sendArchived();
    // Sending again (the screen closing after the toast ended) sends nothing twice.
    sendArchived();
    expect(run.mock.calls).toEqual([[{ type: 'close', id: 'run-1' }]]);
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'run-2' }));
  });
});
