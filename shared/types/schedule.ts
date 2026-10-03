import { boundary } from '../validation/boundaryDecoder';
import type { BoundarySchema } from '../validation/boundaryDecoder';

/**
 * Recurring agent runs.
 *
 * A scheduled run creates a session — the same way the create dialog does —
 * with a fixed prompt, at a fixed time. Nightly bug sweeps, a weekly
 * dependency check, a "review yesterday's diffs" pass every morning.
 *
 * Deliberately not cron syntax. Three shapes cover what people actually ask
 * for, and each one can be stated in a sentence the UI can render back.
 */

export type ScheduleKind = 'interval' | 'daily' | 'weekly';

export type ScheduleRunStatus = 'ok' | 'failed' | 'skipped';

export interface ScheduledRun {
  id: string;
  name: string;
  projectId: number;
  /** Sent to the agent as the session's opening prompt. */
  prompt: string;
  /** Which agent to start; `none` opens a plain terminal. */
  toolType: 'claude' | 'none';
  /** Optional worktree/branch name template, as in the create dialog. */
  worktreeTemplate?: string;
  enabled: boolean;

  kind: ScheduleKind;
  /** `interval`: minutes between runs. */
  intervalMinutes?: number;
  /** `daily` and `weekly`: local time of day, `HH:MM`. */
  timeOfDay?: string;
  /** `weekly`: 0 = Sunday … 6 = Saturday. */
  weekday?: number;

  lastRunAtMs: number | null;
  lastRunStatus: ScheduleRunStatus | null;
  lastRunError: string | null;
  /** Session created by the last successful run, for a link in the UI. */
  lastSessionId: string | null;
  nextRunAtMs: number | null;
  createdAtMs: number;
}

export type ScheduledRunInput = Omit<
  ScheduledRun,
  'id' | 'lastRunAtMs' | 'lastRunStatus' | 'lastRunError' | 'lastSessionId' | 'nextRunAtMs' | 'createdAtMs'
> & { id?: string };

export const scheduledRunInputSchema = boundary.object({
  id: boundary.optional(boundary.string),
  name: boundary.string,
  projectId: boundary.number,
  prompt: boundary.string,
  toolType: boundary.enumeration('claude', 'none'),
  worktreeTemplate: boundary.optional(boundary.string),
  enabled: boundary.boolean,
  kind: boundary.enumeration('interval', 'daily', 'weekly'),
  intervalMinutes: boundary.optional(boundary.number),
  timeOfDay: boundary.optional(boundary.string),
  weekday: boundary.optional(boundary.number),
}) satisfies BoundarySchema<ScheduledRunInput>;

/** How often the scheduler wakes to look for due runs. */
export const SCHEDULE_TICK_MS = 30_000;

/**
 * A run more than this late is not worth starting.
 *
 * Missed runs are skipped rather than caught up: waking a laptop after a
 * weekend should not start three days of nightly sweeps at once.
 */
export const SCHEDULE_MISS_GRACE_MS = 15 * 60 * 1000;

export const MIN_INTERVAL_MINUTES = 5;
