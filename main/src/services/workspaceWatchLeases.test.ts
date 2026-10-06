import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceWatchLeases } from './workspaceWatchLeases';
import { WorkspaceJournal } from './workspaceJournal';

afterEach(() => vi.useRealTimers());

describe('WorkspaceWatchLeases', () => {
  it('reaps a stalled request even when no disconnect arrives', async () => {
    vi.useFakeTimers();
    const leases = new WorkspaceWatchLeases();
    const journal = new WorkspaceJournal();
    const lease = leases.acquire('stalled');
    const waiting = journal.waitAfter(0, {}, 300_000, 256, 'stalled', lease.signal);
    const rejected = expect(waiting).rejects.toThrow('lease expired');
    await vi.advanceTimersByTimeAsync(125_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    lease.release();
  });

  it('does not let a superseded owner release the replacement', () => {
    const leases = new WorkspaceWatchLeases();
    const old = leases.acquire('monitor');
    const replacement = leases.acquire('monitor');
    expect(old.signal.aborted).toBe(true);
    old.release();
    const newest = leases.acquire('monitor');
    expect(replacement.signal.aborted).toBe(true);
    newest.release();
  });

  it('disconnects only the requests owned by that connection', () => {
    const leases = new WorkspaceWatchLeases();
    const connection = new AbortController();
    const disconnected = leases.acquire('one', connection.signal);
    const live = leases.acquire('two');
    connection.abort(new Error('disconnected'));
    expect(disconnected.signal.aborted).toBe(true);
    expect(live.signal.aborted).toBe(false);
    live.release();
  });

  it('does not let an already disconnected request take over a live cursor', () => {
    const leases = new WorkspaceWatchLeases();
    const live = leases.acquire('monitor');
    expect(() => leases.acquire('monitor', AbortSignal.abort())).toThrow();
    expect(live.signal.aborted).toBe(false);
    live.release();
  });
});
