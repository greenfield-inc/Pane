import { afterEach, describe, expect, it, vi } from 'vitest';
import { parkUnderLease, WorkspaceWatchLeaseExpiredError, WorkspaceWatchLeases } from './workspaceWatchLeases';
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

  it('counts a named watcher as attached while it polls and briefly between polls', () => {
    vi.useFakeTimers();
    const leases = new WorkspaceWatchLeases();
    expect(leases.isAttached('dictate', 30_000)).toBe(false);

    const poll = leases.acquire('dictate');
    expect(leases.isAttached('dictate', 30_000)).toBe(true);
    expect(leases.isAttached('monitor', 30_000)).toBe(false);

    poll.release();
    vi.advanceTimersByTime(29_000);
    expect(leases.isAttached('dictate', 30_000)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(leases.isAttached('dictate', 30_000)).toBe(false);
  });

  it('keeps the newest watcher attached when a superseded one releases', () => {
    vi.useFakeTimers();
    const leases = new WorkspaceWatchLeases();
    const old = leases.acquire('dictate');
    const replacement = leases.acquire('dictate');
    old.release();
    vi.advanceTimersByTime(60_000);
    expect(leases.isAttached('dictate', 30_000)).toBe(true);
    replacement.release();
  });

  describe('parkUnderLease', () => {
    const LATE_PARK_MS = 130_000;
    const timedOutAt = (journal: WorkspaceJournal, cursor: number) => () => ({ ...journal.readAfter(cursor, {}, 256), timedOut: true });

    it('ends a park the lease outlived past its deadline as a normal timeout', async () => {
      vi.useFakeTimers();
      const leases = new WorkspaceWatchLeases();
      const journal = new WorkspaceJournal();
      const lease = leases.acquire('until-event');
      const deadlineAt = Date.now() + 120_000;
      // The park's own timer runs late, as after post-timeout work or a machine sleep.
      const parked = parkUnderLease(lease, deadlineAt, signal => journal.waitAfter(0, {}, LATE_PARK_MS, 256, 'until-event', signal), timedOutAt(journal, 0));
      await vi.advanceTimersByTimeAsync(125_000);
      await expect(parked).resolves.toEqual({ entries: [], generation: 0, timedOut: true });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still rejects when the lease runs out before the deadline', async () => {
      vi.useFakeTimers();
      const leases = new WorkspaceWatchLeases();
      const journal = new WorkspaceJournal();
      const lease = leases.acquire('stalled');
      const deadlineAt = Date.now() + 300_000;
      const parked = parkUnderLease(lease, deadlineAt, signal => journal.waitAfter(0, {}, 300_000, 256, 'stalled', signal), timedOutAt(journal, 0));
      const rejected = expect(parked).rejects.toBeInstanceOf(WorkspaceWatchLeaseExpiredError);
      await vi.advanceTimersByTimeAsync(125_000);
      await rejected;
      await expect(parked).rejects.toMatchObject({ code: 'ERR_WATCH_LEASE_EXPIRED' });
    });

    it('still rejects a superseded park after its deadline', async () => {
      vi.useFakeTimers();
      const leases = new WorkspaceWatchLeases();
      const journal = new WorkspaceJournal();
      const lease = leases.acquire('monitor');
      const deadlineAt = Date.now();
      const parked = parkUnderLease(lease, deadlineAt, signal => journal.waitAfter(0, {}, 60_000, 256, 'monitor', signal), timedOutAt(journal, 0));
      const rejected = expect(parked).rejects.toThrow('superseded');
      await vi.advanceTimersByTimeAsync(1_000);
      const replacement = leases.acquire('monitor');
      await rejected;
      replacement.release();
    });

    it('keeps a long-lived cursor working across repeated late parks', async () => {
      vi.useFakeTimers();
      const leases = new WorkspaceWatchLeases();
      const journal = new WorkspaceJournal();
      for (let poll = 0; poll < 3; poll += 1) {
        const lease = leases.acquire('until-event');
        try {
          const deadlineAt = Date.now() + 120_000;
          const parked = parkUnderLease(lease, deadlineAt, signal => journal.waitAfter(0, {}, LATE_PARK_MS, 256, 'until-event', signal), timedOutAt(journal, 0));
          await vi.advanceTimersByTimeAsync(LATE_PARK_MS);
          await expect(parked).resolves.toMatchObject({ entries: [], timedOut: true });
        } finally {
          lease.release();
        }
        expect(leases.isAttached('until-event', 30_000)).toBe(true);
      }
      const lease = leases.acquire('until-event');
      const parked = parkUnderLease(lease, Date.now() + 120_000, signal => journal.waitAfter(0, {}, 120_000, 256, 'until-event', signal), timedOutAt(journal, 0));
      journal.append({ kind: 'pane.created', paneId: 'one', paneName: 'One', source: 'session' });
      await expect(parked).resolves.toMatchObject({ entries: [{ kind: 'pane.created', paneId: 'one' }], timedOut: false });
      lease.release();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
