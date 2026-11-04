import { describe, expect, it } from 'vitest';
import type { NotifyItem, NotifySnapshot } from '../../../shared/types/notify';
import { notifyFixture } from '../../../tests/fixtures/notifySnapshot';
import { sessionWaitingCount, waitingCount, waitingElsewhere } from './notifyStore';

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
    expect(sessionWaitingCount(snapshot, 'session-launch')).toBe(3);
    expect(sessionWaitingCount(snapshot, 'session-other')).toBe(0);
    expect(sessionWaitingCount(snapshot, 'session-launch', 'local')).toBe(3);
    expect(sessionWaitingCount(snapshot, 'session-launch', 'studio')).toBe(0);
    // The badge: every Session's count plus what isn't in a Session.
    expect(waitingCount(snapshot)).toBe(4);
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
