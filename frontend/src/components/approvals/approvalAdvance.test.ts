import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { advanceApproval } from './approvalAdvance';

const item = (id: string, extra: Partial<NotifyItem> = {}): NotifyItem => ({
  id, title: id, ui: 'options', source: { name: 'agent', agent: 'Claude' }, state: 'waiting', createdAt: 1, ...extra,
});

describe('advanceApproval (T-88)', () => {
  beforeEach(() => useApprovalColumnStore.setState({ open: {}, advanced: {} }));

  it('opens the next waiting approval and remembers the one just sent', () => {
    const open = vi.fn();
    const caughtUp = vi.fn();
    const next = advanceApproval({ surface: 'approvals', order: ['c', 'b', 'a'], fromId: 'c', items: [item('c'), item('b'), item('a')], sent: true, open, caughtUp, focus: vi.fn() });
    expect(next).toBe('b');
    expect(open).toHaveBeenCalledWith('b');
    expect(caughtUp).not.toHaveBeenCalled();
    expect(useApprovalColumnStore.getState().advanced.approvals).toBe('c');
  });

  it('passes over an approval still in its Undo hold or answered elsewhere', () => {
    const open = vi.fn();
    advanceApproval({ surface: 'approvals', order: ['c', 'b', 'a'], fromId: 'c', items: [item('c'), item('b', { state: 'sent' }), item('a')], sent: true, open, caughtUp: vi.fn(), focus: vi.fn() });
    expect(open).toHaveBeenCalledWith('a');
  });

  it('says all caught up when nothing else waits', () => {
    const open = vi.fn();
    const caughtUp = vi.fn();
    const next = advanceApproval({ surface: 'session:s1', order: ['c'], fromId: 'c', items: [item('c')], sent: true, open, caughtUp, focus: vi.fn() });
    expect(next).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
    expect(caughtUp).toHaveBeenCalled();
  });

  it('after a Dismiss, moves on without a Sent line', () => {
    useApprovalColumnStore.getState().noteAdvanced('approvals', 'old');
    const open = vi.fn();
    advanceApproval({ surface: 'approvals', order: ['c', 'b'], fromId: 'c', items: [item('c'), item('b')], sent: false, open, caughtUp: vi.fn(), focus: vi.fn() });
    expect(open).toHaveBeenCalledWith('b');
    expect(useApprovalColumnStore.getState().advanced.approvals).toBeUndefined();
  });
});
