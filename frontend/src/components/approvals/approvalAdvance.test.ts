import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { advanceApproval, canAdvanceTo } from './approvalAdvance';

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

  it('passes over dismissed approvals, so two Dismisses in a row end all caught up (review M-1)', () => {
    const open = vi.fn();
    const caughtUp = vi.fn();
    // Dismiss A: B opens.
    advanceApproval({ surface: 'approvals', order: ['a', 'b'], fromId: 'a', items: [item('a'), item('b')], sent: false, open, caughtUp, focus: vi.fn() });
    expect(open).toHaveBeenLastCalledWith('b');
    // Dismiss B: A still waits in Approvals, dismissed, so it doesn't open again.
    advanceApproval({ surface: 'approvals', order: ['a', 'b'], fromId: 'b', items: [item('a', { dismissedAt: 5 }), item('b')], sent: false, open, caughtUp, focus: vi.fn() });
    expect(open).toHaveBeenCalledTimes(1);
    expect(caughtUp).toHaveBeenCalledTimes(1);
  });

  it('one check decides what it moves on to, counts and replaces caught-up with (review M-1)', () => {
    expect(canAdvanceTo(item('a'))).toBe(true);
    expect(canAdvanceTo(item('a', { dismissedAt: 5 }))).toBe(false);
    expect(canAdvanceTo(item('a', { state: 'sent' }))).toBe(false);
    expect(canAdvanceTo(item('a', { staleSince: 5 }))).toBe(false);
    expect(canAdvanceTo(item('a', { unreachable: true }))).toBe(false);
    expect(canAdvanceTo(item('a', { reply: { id: 'r', text: 'why?', at: 2, state: 'reading' } }))).toBe(false);
  });

  it('reads the order as it is when the Send returns, keeping the answered card\'s place (review S-2)', () => {
    const open = vi.fn();
    const caughtUp = vi.fn();
    // Sent A with B below it; meanwhile B was answered elsewhere and C arrived on top. A has left the list.
    advanceApproval({ surface: 'approvals', order: ['c'], before: ['a', 'b'], fromId: 'a', items: [item('a', { state: 'sent' }), item('b', { state: 'answered' }), item('c')], sent: true, open, caughtUp, focus: vi.fn() });
    expect(open).toHaveBeenCalledWith('c');
    expect(caughtUp).not.toHaveBeenCalled();
    // A still listed further down: the next one below it, not the top.
    open.mockClear();
    advanceApproval({ surface: 'approvals', order: ['c', 'a', 'd'], before: ['a', 'd'], fromId: 'a', items: [item('a', { state: 'sent' }), item('c'), item('d')], sent: true, open, caughtUp, focus: vi.fn() });
    expect(open).toHaveBeenCalledWith('d');
  });
});
