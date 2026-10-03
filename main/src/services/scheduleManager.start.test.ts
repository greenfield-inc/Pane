import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScheduleManager, type ScheduleStore, type SessionStarter } from './scheduleManager';
import { SCHEDULE_MISS_GRACE_MS, SCHEDULE_TICK_MS, type ScheduledRun } from '../../../shared/types/schedule';

/**
 * What happens to a schedule that came due while Pane was closed.
 *
 * The tick has always handled an overdue row correctly, but nothing exercised
 * the sequence that actually runs at launch. start() called rescheduleAll(),
 * which recomputed every enabled schedule's next run from now — so a stored
 * time in the past was replaced with a future one before any tick could see
 * it. The missed occurrence was never recorded as skipped, and a run only
 * slightly late, which the grace period exists to let through, was dropped
 * without a trace.
 */

function createStore(initial: ScheduledRun[] = []): ScheduleStore & { rows: Map<string, ScheduledRun> } {
  const rows = new Map(initial.map(row => [row.id, { ...row }]));
  return {
    rows,
    list: (projectId?: number) => [...rows.values()]
      .filter(row => projectId === undefined || row.projectId === projectId)
      .map(row => ({ ...row })),
    get: (id: string) => {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    listRunnable: () => [...rows.values()]
      .filter(row => row.enabled && row.nextRunAtMs !== null)
      .map(row => ({ ...row })),
    upsert: (schedule: ScheduledRun) => { rows.set(schedule.id, { ...schedule }); },
    delete: (id: string) => { rows.delete(id); },
  };
}

function schedule(overrides: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: 'sched-1',
    name: 'Nightly sweep',
    projectId: 1,
    prompt: 'Look for flaky tests',
    toolType: 'claude',
    enabled: true,
    kind: 'daily',
    timeOfDay: '03:30',
    lastRunAtMs: null,
    lastRunStatus: null,
    lastRunError: null,
    lastSessionId: null,
    nextRunAtMs: null,
    createdAtMs: Date.now(),
    ...overrides,
  };
}

describe('ScheduleManager.start', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  /** start() includes the first tick, before the interval begins. */
  async function launch(store: ScheduleStore, start: SessionStarter) {
    const manager = new ScheduleManager(store, start);
    manager.start();
    await vi.advanceTimersByTimeAsync(0);
    manager.stop();
    return manager;
  }

  it('records the run it slept through instead of quietly moving on', async () => {
    const start = vi.fn<SessionStarter>();
    const overdue = Date.now() - SCHEDULE_MISS_GRACE_MS - 60 * 60_000;
    const store = createStore([schedule({ nextRunAtMs: overdue })]);

    await launch(store, start);

    expect(start).not.toHaveBeenCalled();

    const after = store.rows.get('sched-1')!;
    expect(after.lastRunStatus).toBe('skipped');
    expect(after.lastRunError).toBe('Came due while Pane was closed');
    expect(after.nextRunAtMs).toBeGreaterThan(Date.now());
    // The next 03:30, not some point rounded off from the missed one.
    expect(new Date(after.nextRunAtMs!).getHours()).toBe(3);
    expect(new Date(after.nextRunAtMs!).getMinutes()).toBe(30);
  });

  it('writes off one occurrence, not one per interval of downtime', async () => {
    const start = vi.fn<SessionStarter>();
    const store = createStore([schedule({
      kind: 'interval',
      intervalMinutes: 60,
      timeOfDay: undefined,
      // Three days of downtime: 72 intervals came and went.
      nextRunAtMs: Date.now() - 3 * 24 * 60 * 60_000,
      lastRunAtMs: Date.now() - 3 * 24 * 60 * 60_000 - 60 * 60_000,
    })]);

    const upserts: ScheduledRun[] = [];
    const spied = { ...store, upsert: (row: ScheduledRun) => { upserts.push({ ...row }); store.upsert(row); } };

    await launch(spied, start);

    expect(start).not.toHaveBeenCalled();
    expect(upserts.filter(row => row.lastRunStatus === 'skipped')).toHaveLength(1);
    expect(store.rows.get('sched-1')!.nextRunAtMs).toBe(Date.now() + 60 * 60_000);
  });

  /**
   * The grace period is the whole point: a laptop opened two minutes after a
   * run was due should still get that run.
   */
  it('still runs a schedule that is late but inside the grace period', async () => {
    const start = vi.fn<SessionStarter>().mockResolvedValue({ sessionId: 'new-session' });
    const store = createStore([schedule({ nextRunAtMs: Date.now() - 2 * 60_000 })]);

    await launch(store, start);

    expect(start).toHaveBeenCalledTimes(1);
    const after = store.rows.get('sched-1')!;
    expect(after.lastRunStatus).toBe('ok');
    expect(after.lastSessionId).toBe('new-session');
    expect(after.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it('runs immediately when the grace window is about to expire', async () => {
    const start = vi.fn<SessionStarter>().mockResolvedValue({ sessionId: 'new-session' });
    const store = createStore([schedule({ nextRunAtMs: Date.now() - SCHEDULE_MISS_GRACE_MS + 1 })]);

    await launch(store, start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(store.rows.get('sched-1')!.lastRunStatus).toBe('ok');
  });

  it('leaves a schedule that is not due yet exactly where it was', async () => {
    const start = vi.fn<SessionStarter>();
    const nextRun = Date.now() + 5 * 60 * 60_000;
    const store = createStore([schedule({ nextRunAtMs: nextRun, lastRunStatus: 'ok' })]);

    await launch(store, start);

    expect(start).not.toHaveBeenCalled();
    const after = store.rows.get('sched-1')!;
    expect(after.nextRunAtMs).toBe(nextRun);
    expect(after.lastRunStatus).toBe('ok');
  });

  it('does not touch a disabled schedule, however overdue it looks', async () => {
    const start = vi.fn<SessionStarter>();
    const overdue = Date.now() - SCHEDULE_MISS_GRACE_MS - 60_000;
    const store = createStore([schedule({ enabled: false, nextRunAtMs: overdue })]);

    await launch(store, start);

    expect(start).not.toHaveBeenCalled();
    const after = store.rows.get('sched-1')!;
    expect(after.nextRunAtMs).toBe(overdue);
    expect(after.lastRunStatus).toBeNull();
  });

  it('gives an enabled schedule a next run when it has none', async () => {
    const start = vi.fn<SessionStarter>();
    const store = createStore([schedule({ nextRunAtMs: null })]);

    await launch(store, start);

    expect(start).not.toHaveBeenCalled();
    expect(store.rows.get('sched-1')!.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it('keeps ticking after the reconciliation', async () => {
    const start = vi.fn<SessionStarter>().mockResolvedValue({ sessionId: 's' });
    const store = createStore([schedule({ nextRunAtMs: Date.now() + SCHEDULE_TICK_MS / 2 })]);
    const manager = new ScheduleManager(store, start);

    manager.start();
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS + 1);
    manager.stop();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lets Run now start a session at launch without shifting the cadence', async () => {
    const start = vi.fn<SessionStarter>().mockResolvedValue({ sessionId: 'manual' });
    const nextRun = Date.now() + 5 * 60 * 60_000;
    const store = createStore([schedule({ nextRunAtMs: nextRun })]);
    const manager = new ScheduleManager(store, start);

    manager.start();
    await manager.runNow('sched-1');
    manager.stop();

    expect(start).toHaveBeenCalledTimes(1);
    expect(store.rows.get('sched-1')!.nextRunAtMs).toBe(nextRun);
  });
});
