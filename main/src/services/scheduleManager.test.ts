import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScheduleManager, type ScheduleStore, type SessionStarter } from './scheduleManager';
import { SCHEDULE_MISS_GRACE_MS, type ScheduledRun } from '../../../shared/types/schedule';

/** In-memory store: the scheduling behaviour is what these tests are about. */
function createStore(initial: ScheduledRun[] = []): ScheduleStore & { rows: Map<string, ScheduledRun> } {
  const rows = new Map(initial.map(row => [row.id, { ...row }]));
  return {
    rows,
    list: (projectId?: number) => [...rows.values()]
      .filter(row => projectId === undefined || row.projectId === projectId),
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

describe('ScheduleManager.save', () => {
  it('computes the next run when a schedule is created', () => {
    const store = createStore();
    const manager = new ScheduleManager(store, vi.fn());

    const saved = manager.save({
      name: 'Nightly sweep',
      projectId: 1,
      prompt: 'Look for flaky tests',
      toolType: 'claude',
      enabled: true,
      kind: 'daily',
      timeOfDay: '03:30',
    });

    expect(saved.id).toBeTruthy();
    expect(saved.nextRunAtMs).toBeGreaterThan(Date.now());
    expect(store.rows.get(saved.id)?.name).toBe('Nightly sweep');
  });

  it('leaves a disabled schedule without a next run', () => {
    const manager = new ScheduleManager(createStore(), vi.fn());
    const saved = manager.save({
      name: 'Off for now',
      projectId: 1,
      prompt: 'x',
      toolType: 'none',
      enabled: false,
      kind: 'daily',
      timeOfDay: '03:30',
    });

    expect(saved.nextRunAtMs).toBeNull();
  });

  it('keeps the run history when a schedule is edited', () => {
    const existing = schedule({ lastRunAtMs: 1000, lastRunStatus: 'ok', lastSessionId: 'sess-9' });
    const store = createStore([existing]);
    const manager = new ScheduleManager(store, vi.fn());

    const saved = manager.save({
      id: existing.id,
      name: 'Renamed',
      projectId: 1,
      prompt: 'Different prompt',
      toolType: 'claude',
      enabled: true,
      kind: 'daily',
      timeOfDay: '04:00',
    });

    expect(saved.name).toBe('Renamed');
    expect(saved.lastRunAtMs).toBe(1000);
    expect(saved.lastSessionId).toBe('sess-9');
  });

  it('refuses to schedule faster than the minimum interval', () => {
    const manager = new ScheduleManager(createStore(), vi.fn());
    const saved = manager.save({
      name: 'Too eager',
      projectId: 1,
      prompt: 'x',
      toolType: 'none',
      enabled: true,
      kind: 'interval',
      intervalMinutes: 1,
    });

    expect(saved.intervalMinutes).toBe(5);
  });
});

describe('ScheduleManager.tick', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts a session when a schedule is due', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    const start = vi.fn<SessionStarter>().mockResolvedValue({ sessionId: 'new-session' });
    const store = createStore([schedule({ nextRunAtMs: Date.now() - 1000 })]);
    const manager = new ScheduleManager(store, start);

    await manager.tick();

    expect(start).toHaveBeenCalledWith({
      prompt: 'Look for flaky tests',
      worktreeTemplate: '',
      projectId: 1,
      toolType: 'claude',
    });

    const after = store.rows.get('sched-1')!;
    expect(after.lastRunStatus).toBe('ok');
    expect(after.lastSessionId).toBe('new-session');
    expect(after.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it('does nothing before a schedule is due', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    const start = vi.fn<SessionStarter>();
    const store = createStore([schedule({ nextRunAtMs: Date.now() + 60_000 })]);

    await new ScheduleManager(store, start).tick();

    expect(start).not.toHaveBeenCalled();
  });

  it('ignores disabled schedules', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    const start = vi.fn<SessionStarter>();
    const store = createStore([schedule({ enabled: false, nextRunAtMs: Date.now() - 1000 })]);

    await new ScheduleManager(store, start).tick();

    expect(start).not.toHaveBeenCalled();
  });

  /**
   * The behaviour that matters after a weekend: opening the laptop must not
   * start every run that came due while it was shut.
   */
  it('skips a run that came due while Pane was closed', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    const start = vi.fn<SessionStarter>();
    const overdue = Date.now() - SCHEDULE_MISS_GRACE_MS - 60_000;
    const store = createStore([schedule({ nextRunAtMs: overdue })]);
    const manager = new ScheduleManager(store, start);

    await manager.tick();

    expect(start).not.toHaveBeenCalled();
    const after = store.rows.get('sched-1')!;
    expect(after.lastRunStatus).toBe('skipped');
    expect(after.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it('records why a run failed and still moves to the next slot', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    const start = vi.fn<SessionStarter>().mockRejectedValue(new Error('worktree is locked'));
    const store = createStore([schedule({ nextRunAtMs: Date.now() - 1000 })]);

    await new ScheduleManager(store, start).tick();

    const after = store.rows.get('sched-1')!;
    expect(after.lastRunStatus).toBe('failed');
    expect(after.lastRunError).toBe('worktree is locked');
    expect(after.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it('does not start the same schedule twice when ticks overlap', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    let resolveStart: (value: { sessionId: string }) => void = () => {};
    const start = vi.fn<SessionStarter>().mockImplementation(
      () => new Promise(resolve => { resolveStart = resolve; })
    );
    const store = createStore([schedule({ nextRunAtMs: Date.now() - 1000 })]);
    const manager = new ScheduleManager(store, start);

    const first = manager.tick();
    await manager.tick();          // arrives while the first is still starting
    resolveStart({ sessionId: 's' });
    await first;

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('runs an interval schedule on its cadence, counted from the run', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    const start = vi.fn<SessionStarter>().mockResolvedValue({ sessionId: 's' });
    const store = createStore([schedule({
      kind: 'interval',
      intervalMinutes: 60,
      timeOfDay: undefined,
      nextRunAtMs: Date.now() - 1000,
    })]);

    await new ScheduleManager(store, start).tick();

    const after = store.rows.get('sched-1')!;
    expect(after.nextRunAtMs).toBe(Date.now() + 60 * 60_000);
  });
});

describe('ScheduleManager.runNow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts immediately without moving the schedule', async () => {
    vi.setSystemTime(new Date('2026-08-11T10:00:00'));
    const nextRun = Date.now() + 5 * 60 * 60_000;
    const start = vi.fn<SessionStarter>().mockResolvedValue({ sessionId: 'manual' });
    const store = createStore([schedule({ nextRunAtMs: nextRun })]);

    const result = await new ScheduleManager(store, start).runNow('sched-1');

    expect(start).toHaveBeenCalledTimes(1);
    expect(result?.lastSessionId).toBe('manual');
    expect(store.rows.get('sched-1')!.nextRunAtMs).toBe(nextRun);
  });

  it('reports nothing for an id that no longer exists', async () => {
    const manager = new ScheduleManager(createStore(), vi.fn());
    expect(await manager.runNow('gone')).toBeNull();
  });

  it('rejects a second run while the same schedule is starting', async () => {
    let resolveStart: (value: { sessionId: string }) => void = () => {};
    const start = vi.fn<SessionStarter>().mockImplementation(
      () => new Promise(resolve => { resolveStart = resolve; })
    );
    const manager = new ScheduleManager(createStore([schedule()]), start);

    const first = manager.runNow('sched-1');
    await expect(manager.runNow('sched-1')).rejects.toThrow('already running');
    resolveStart({ sessionId: 'manual' });
    await first;

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a schedule deleted while its session is starting', async () => {
    let resolveStart: (value: { sessionId: string }) => void = () => {};
    const start = vi.fn<SessionStarter>().mockImplementation(
      () => new Promise(resolve => { resolveStart = resolve; })
    );
    const store = createStore([schedule()]);
    const manager = new ScheduleManager(store, start);

    const run = manager.runNow('sched-1');
    manager.delete('sched-1');
    resolveStart({ sessionId: 'manual' });
    await run;

    expect(store.rows.has('sched-1')).toBe(false);
  });
});

describe('ScheduleManager concurrent mutations', () => {
  it('preserves a disable made while an automatic run is starting', async () => {
    let resolveStart: (value: { sessionId: string }) => void = () => {};
    const start = vi.fn<SessionStarter>().mockImplementation(
      () => new Promise(resolve => { resolveStart = resolve; })
    );
    const store = createStore([schedule({ nextRunAtMs: Date.now() - 1000 })]);
    const manager = new ScheduleManager(store, start);

    const tick = manager.tick();
    manager.setEnabled('sched-1', false);
    resolveStart({ sessionId: 'scheduled' });
    await tick;

    expect(store.rows.get('sched-1')).toMatchObject({
      enabled: false,
      nextRunAtMs: null,
      lastSessionId: 'scheduled',
    });
  });
});

describe('ScheduleManager.setEnabled', () => {
  it('gives a re-enabled schedule a next run again', () => {
    const store = createStore([schedule({ enabled: false, nextRunAtMs: null })]);
    const manager = new ScheduleManager(store, vi.fn());

    const enabled = manager.setEnabled('sched-1', true);
    expect(enabled?.nextRunAtMs).toBeGreaterThan(Date.now());

    const disabled = manager.setEnabled('sched-1', false);
    expect(disabled?.nextRunAtMs).toBeNull();
  });
});
