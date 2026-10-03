import {
  MIN_INTERVAL_MINUTES,
  SCHEDULE_MISS_GRACE_MS,
  type ScheduledRun,
  type ScheduleKind,
} from '../../../shared/types/schedule';

/**
 * When a scheduled run is next due.
 *
 * Pure arithmetic on local time, kept out of the scheduler service so it can be
 * tested against the awkward cases without a clock: a daily run whose time has
 * already passed today, a weekly run on today's weekday, and the twice-yearly
 * days that are 23 or 25 hours long.
 */

const MINUTE_MS = 60_000;

export interface ScheduleTiming {
  kind: ScheduleKind;
  intervalMinutes?: number;
  timeOfDay?: string;
  weekday?: number;
  lastRunAtMs?: number | null;
}

/** `"03:30"` → `{ hours: 3, minutes: 30 }`; null when it is not a time. */
export function parseTimeOfDay(value: string | undefined): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

/**
 * The next occurrence of a local wall-clock time, at least one tick away.
 *
 * Built by mutating a `Date` rather than adding milliseconds so it lands on the
 * same wall-clock time across a daylight-saving change — the point of "every
 * day at 03:30" is the 03:30, not the 24 hours.
 */
function nextAtTimeOfDay(
  from: Date,
  time: { hours: number; minutes: number },
  isAcceptableDay: (candidate: Date) => boolean
): number {
  const candidate = new Date(from);
  candidate.setHours(time.hours, time.minutes, 0, 0);

  // Up to a week ahead covers daily and weekly; the guard is a stop, not a
  // limit — an acceptable day always exists within seven.
  for (let day = 0; day <= 7; day++) {
    if (candidate.getTime() > from.getTime() && isAcceptableDay(candidate)) {
      return candidate.getTime();
    }
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(time.hours, time.minutes, 0, 0);
  }

  return candidate.getTime();
}

/**
 * Next run time for a schedule, or null when it can never run.
 *
 * `fromMs` is "now" for a fresh calculation; after a run it is that run's time,
 * which is what keeps an interval schedule on its cadence instead of drifting
 * by however long the run took to start.
 */
export function computeNextRun(schedule: ScheduleTiming, fromMs: number): number | null {
  const from = new Date(fromMs);

  if (schedule.kind === 'interval') {
    const minutes = Math.max(schedule.intervalMinutes ?? 0, MIN_INTERVAL_MINUTES);
    // Counting from the last run keeps the cadence; counting from now would
    // let a schedule drift later every time the app was closed at the moment.
    const anchor = schedule.lastRunAtMs ?? fromMs;
    let next = anchor + minutes * MINUTE_MS;
    if (next <= fromMs) {
      // Skip whole intervals rather than firing repeatedly to catch up.
      const missed = Math.ceil((fromMs - next) / (minutes * MINUTE_MS));
      next += missed * minutes * MINUTE_MS;
      if (next <= fromMs) next += minutes * MINUTE_MS;
    }
    return next;
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (!time) return null;

  if (schedule.kind === 'daily') {
    return nextAtTimeOfDay(from, time, () => true);
  }

  const weekday = schedule.weekday;
  if (weekday === undefined || weekday < 0 || weekday > 6) return null;

  return nextAtTimeOfDay(from, time, candidate => candidate.getDay() === weekday);
}

/**
 * Should this schedule run now?
 *
 * A run that came due while the app was closed is skipped once it is more than
 * the grace period late: starting a nightly sweep at lunchtime because the
 * laptop was shut is worse than not running it at all.
 */
export function isDue(schedule: Pick<ScheduledRun, 'enabled' | 'nextRunAtMs'>, nowMs: number): boolean {
  if (!schedule.enabled || schedule.nextRunAtMs === null) return false;
  return schedule.nextRunAtMs <= nowMs && nowMs - schedule.nextRunAtMs <= SCHEDULE_MISS_GRACE_MS;
}

/** True when the run is past due beyond the grace period and must be skipped. */
export function isMissed(schedule: Pick<ScheduledRun, 'enabled' | 'nextRunAtMs'>, nowMs: number): boolean {
  if (!schedule.enabled || schedule.nextRunAtMs === null) return false;
  return nowMs - schedule.nextRunAtMs > SCHEDULE_MISS_GRACE_MS;
}
