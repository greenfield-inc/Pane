import { randomUUID } from 'crypto';
import { computeNextRun, isDue, isMissed } from './scheduleCalculator';
import {
  MIN_INTERVAL_MINUTES,
  SCHEDULE_TICK_MS,
  type ScheduledRun,
  type ScheduledRunInput,
} from '../../../shared/types/schedule';
import type { Logger } from '../utils/logger';

/**
 * Runs schedules when they come due.
 *
 * Deliberately dumb about time: one timer, one pass over the table, all the
 * arithmetic in `scheduleCalculator`. A timer per schedule would drift, would
 * need rebuilding on every edit, and would silently do nothing after a laptop
 * sleeps — which is precisely when a nightly run matters.
 */

/** Starts a session; the same call the create dialog makes. */
export type SessionStarter = (input: {
  prompt: string;
  worktreeTemplate: string;
  projectId: number;
  toolType: 'claude' | 'none';
}) => Promise<{ sessionId?: string }>;

/**
 * The storage this needs, named as an interface so tests can supply a plain
 * in-memory one — the scheduling behaviour is the part worth testing, and it
 * has nothing to do with SQLite.
 */
export interface ScheduleStore {
  list(projectId?: number): ScheduledRun[];
  get(id: string): ScheduledRun | null;
  listRunnable(nowMs: number): ScheduledRun[];
  upsert(schedule: ScheduledRun): void;
  delete(id: string): void;
}

export class ScheduleManager {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly executingIds = new Set<string>();

  /**
   * The store is injected rather than reached for: importing the database
   * module loads a native SQLite binding, and a scheduling test has no
   * business doing that.
   */
  constructor(
    private repo: ScheduleStore,
    private startSession: SessionStarter,
    private logger?: Logger,
  ) {}

  /**
   * Begin ticking, once what happened while Pane was closed has been settled.
   */
  start(): void {
    if (this.timer) return;

    try {
      this.reconcileOnStart();
    } catch (error) {
      this.logger?.error('[Schedule] Failed to prime schedules', error instanceof Error ? error : undefined);
    }

    void this.tick().catch(error => {
      this.logger?.error('[Schedule] Initial tick failed', error instanceof Error ? error : undefined);
    });

    this.timer = setInterval(() => {
      void this.tick().catch(error => {
        this.logger?.error('[Schedule] Tick failed', error instanceof Error ? error : undefined);
      });
    }, SCHEDULE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  list(projectId?: number): ScheduledRun[] {
    return this.repo.list(projectId);
  }

  /** Create or update a schedule; the next run is always recomputed here. */
  save(input: ScheduledRunInput): ScheduledRun {
    const existing = input.id ? this.repo.get(input.id) : null;
    const nowMs = Date.now();

    const schedule: ScheduledRun = {
      id: input.id ?? randomUUID(),
      name: input.name.trim() || 'Scheduled run',
      projectId: input.projectId,
      prompt: input.prompt,
      toolType: input.toolType,
      enabled: input.enabled,
      kind: input.kind,
      lastRunAtMs: existing?.lastRunAtMs ?? null,
      lastRunStatus: existing?.lastRunStatus ?? null,
      lastRunError: existing?.lastRunError ?? null,
      lastSessionId: existing?.lastSessionId ?? null,
      nextRunAtMs: null,
      createdAtMs: existing?.createdAtMs ?? nowMs,
    };

    if (input.worktreeTemplate) schedule.worktreeTemplate = input.worktreeTemplate;
    if (input.intervalMinutes !== undefined) {
      schedule.intervalMinutes = Math.max(input.intervalMinutes, MIN_INTERVAL_MINUTES);
    }
    if (input.timeOfDay !== undefined) schedule.timeOfDay = input.timeOfDay;
    if (input.weekday !== undefined) schedule.weekday = input.weekday;

    schedule.nextRunAtMs = schedule.enabled
      ? computeNextRun(schedule, nowMs)
      : null;

    this.repo.upsert(schedule);
    return schedule;
  }

  delete(id: string): void {
    this.repo.delete(id);
  }

  setEnabled(id: string, enabled: boolean): ScheduledRun | null {
    const schedule = this.repo.get(id);
    if (!schedule) return null;

    schedule.enabled = enabled;
    schedule.nextRunAtMs = enabled
      ? computeNextRun(schedule, Date.now())
      : null;
    this.repo.upsert(schedule);
    return schedule;
  }

  /** Run one schedule now, without touching its cadence. */
  async runNow(id: string): Promise<ScheduledRun | null> {
    const schedule = this.repo.get(id);
    if (!schedule) return null;
    if (this.executingIds.has(id)) throw new Error('This schedule is already running');
    return this.execute(schedule, { manual: true });
  }

  /** One pass: start what is due, skip what is too late, keep the rest. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const nowMs = Date.now();
      for (const schedule of this.repo.listRunnable(nowMs)) {
        if (this.executingIds.has(schedule.id)) continue;
        if (isDue(schedule, nowMs)) {
          await this.execute(schedule, { manual: false });
        } else if (isMissed(schedule, nowMs)) {
          this.recordMissed(schedule, nowMs);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Settle the schedules Pane slept through, before the first tick looks at them.
   *
   * This used to recompute every enabled schedule's next run from now, which
   * quietly erased the evidence: a stored time in the past was replaced with a
   * future one, so the tick that followed saw nothing overdue and never marked
   * the occurrence skipped. A run that came due two minutes before the app
   * opened — well inside the grace period, and meant to happen — disappeared
   * the same way.
   *
   * So only two things are decided here. A schedule with no next run at all
   * gets one, and one that is late beyond the grace period is written off as
   * missed. Everything else keeps the time it was stored with and the tick
   * decides, which is where that decision belongs.
   */
  private reconcileOnStart(): void {
    const nowMs = Date.now();

    for (const schedule of this.repo.list()) {
      if (!schedule.enabled) continue;

      if (schedule.nextRunAtMs === null) {
        schedule.nextRunAtMs = computeNextRun(schedule, nowMs);
        this.repo.upsert(schedule);
        continue;
      }

      if (isMissed(schedule, nowMs)) this.recordMissed(schedule, nowMs);
    }
  }

  /**
   * Write off one occurrence that came and went unattended.
   *
   * One, not one per interval that elapsed: `computeNextRun` counts from now,
   * so a weekend of downtime leaves a single skipped entry rather than a
   * backlog nobody wants run.
   */
  private recordMissed(schedule: ScheduledRun, nowMs: number): void {
    this.logger?.info(`[Schedule] Skipping "${schedule.name}" — it came due while Pane was not running.`);
    schedule.lastRunStatus = 'skipped';
    schedule.lastRunError = 'Came due while Pane was closed';
    schedule.nextRunAtMs = computeNextRun({ ...schedule, lastRunAtMs: nowMs }, nowMs);
    this.repo.upsert(schedule);
  }

  private async execute(schedule: ScheduledRun, options: { manual: boolean }): Promise<ScheduledRun> {
    if (this.executingIds.has(schedule.id)) throw new Error('This schedule is already running');
    this.executingIds.add(schedule.id);
    const startedAtMs = Date.now();
    let lastRunStatus: ScheduledRun['lastRunStatus'];
    let lastRunError: string | null;
    let lastSessionId = schedule.lastSessionId;

    try {
      try {
        const result = await this.startSession({
          prompt: schedule.prompt,
          worktreeTemplate: schedule.worktreeTemplate ?? '',
          projectId: schedule.projectId,
          toolType: schedule.toolType,
        });

        lastRunStatus = 'ok';
        lastRunError = null;
        lastSessionId = result.sessionId ?? null;
        this.logger?.info(`[Schedule] Started "${schedule.name}"`);
      } catch (error) {
        lastRunStatus = 'failed';
        lastRunError = error instanceof Error ? error.message : String(error);
        this.logger?.error(`[Schedule] "${schedule.name}" failed to start: ${lastRunError}`);
      }

      // The schedule may have been edited, disabled, or deleted while session
      // creation was pending. Apply execution history only to the latest row.
      const latest = this.repo.get(schedule.id);
      const result = latest ?? { ...schedule };
      result.lastRunAtMs = startedAtMs;
      result.lastRunStatus = lastRunStatus;
      result.lastRunError = lastRunError;
      result.lastSessionId = lastSessionId;

      if (!latest) return result;

      // A manual run must not shift the cadence: "run now" is not "run at this
      // time from now on".
      if (!options.manual) {
        result.nextRunAtMs = result.enabled
          ? computeNextRun(result, startedAtMs)
          : null;
      }

      this.repo.upsert(result);
      return result;
    } finally {
      this.executingIds.delete(schedule.id);
    }
  }
}
