import { describe, it, expect } from 'vitest';
import {
  computeNextRun,
  isDue,
  isMissed,
  parseTimeOfDay,
} from './scheduleCalculator';
import { SCHEDULE_MISS_GRACE_MS } from '../../../shared/types/schedule';

/** Local time, because that is what "every day at 03:30" means to a person. */
function at(year: number, month: number, day: number, hours: number, minutes: number): number {
  return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

describe('parseTimeOfDay', () => {
  it('accepts the times a person types', () => {
    expect(parseTimeOfDay('03:30')).toEqual({ hours: 3, minutes: 30 });
    expect(parseTimeOfDay('3:05')).toEqual({ hours: 3, minutes: 5 });
    expect(parseTimeOfDay(' 23:59 ')).toEqual({ hours: 23, minutes: 59 });
  });

  it('rejects impossible and malformed times', () => {
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('12:60')).toBeNull();
    expect(parseTimeOfDay('midnight')).toBeNull();
    expect(parseTimeOfDay(undefined)).toBeNull();
  });
});

describe('computeNextRun — daily', () => {
  it('runs later today when the time is still ahead', () => {
    const next = computeNextRun({ kind: 'daily', timeOfDay: '03:30' }, at(2026, 8, 11, 1, 0));
    expect(next).toBe(at(2026, 8, 11, 3, 30));
  });

  it('waits for tomorrow when today is already past', () => {
    const next = computeNextRun({ kind: 'daily', timeOfDay: '03:30' }, at(2026, 8, 11, 9, 0));
    expect(next).toBe(at(2026, 8, 12, 3, 30));
  });

  it('does not fire twice at the exact minute it just ran', () => {
    const next = computeNextRun({ kind: 'daily', timeOfDay: '03:30' }, at(2026, 8, 11, 3, 30));
    expect(next).toBe(at(2026, 8, 12, 3, 30));
  });

  it('rolls over the end of a month', () => {
    const next = computeNextRun({ kind: 'daily', timeOfDay: '02:00' }, at(2026, 8, 31, 5, 0));
    expect(next).toBe(at(2026, 9, 1, 2, 0));
  });

  it('is null without a usable time', () => {
    expect(computeNextRun({ kind: 'daily', timeOfDay: 'nope' }, Date.now())).toBeNull();
  });
});

describe('computeNextRun — weekly', () => {
  it('finds the next matching weekday', () => {
    // 2026-08-11 is a Tuesday; asking for Friday (5).
    const next = computeNextRun({ kind: 'weekly', timeOfDay: '09:00', weekday: 5 }, at(2026, 8, 11, 10, 0));
    expect(next).not.toBeNull();
    if (next === null) throw new Error('Expected a weekly run time');
    expect(new Date(next).getDay()).toBe(5);
    expect(next).toBe(at(2026, 8, 14, 9, 0));
  });

  it('uses today when the weekday matches and the time has not passed', () => {
    const next = computeNextRun({ kind: 'weekly', timeOfDay: '23:00', weekday: 2 }, at(2026, 8, 11, 10, 0));
    expect(next).toBe(at(2026, 8, 11, 23, 0));
  });

  it('waits a full week when today matches but the time has passed', () => {
    const next = computeNextRun({ kind: 'weekly', timeOfDay: '09:00', weekday: 2 }, at(2026, 8, 11, 10, 0));
    expect(next).toBe(at(2026, 8, 18, 9, 0));
  });

  it('is null for a weekday outside 0-6', () => {
    expect(computeNextRun({ kind: 'weekly', timeOfDay: '09:00', weekday: 7 }, Date.now())).toBeNull();
    expect(computeNextRun({ kind: 'weekly', timeOfDay: '09:00' }, Date.now())).toBeNull();
  });
});

describe('computeNextRun — interval', () => {
  it('counts from the last run, so the cadence does not drift', () => {
    const lastRun = at(2026, 8, 11, 10, 0);
    const next = computeNextRun(
      { kind: 'interval', intervalMinutes: 60, lastRunAtMs: lastRun },
      at(2026, 8, 11, 10, 5),
    );
    expect(next).toBe(at(2026, 8, 11, 11, 0));
  });

  it('starts from now when it has never run', () => {
    const now = at(2026, 8, 11, 10, 0);
    expect(computeNextRun({ kind: 'interval', intervalMinutes: 30 }, now)).toBe(at(2026, 8, 11, 10, 30));
  });

  /** Waking after a long sleep must not queue up every missed interval. */
  it('skips whole missed intervals instead of firing repeatedly', () => {
    const lastRun = at(2026, 8, 11, 0, 0);
    const next = computeNextRun(
      { kind: 'interval', intervalMinutes: 60, lastRunAtMs: lastRun },
      at(2026, 8, 11, 9, 30),
    );
    expect(next).toBe(at(2026, 8, 11, 10, 0));
  });

  it('never schedules below the minimum interval', () => {
    const now = at(2026, 8, 11, 10, 0);
    const next = computeNextRun({ kind: 'interval', intervalMinutes: 1 }, now);
    expect(next).toBe(at(2026, 8, 11, 10, 5));
  });
});

describe('isDue and isMissed', () => {
  const now = at(2026, 8, 11, 10, 0);

  it('is due at its time and shortly after', () => {
    expect(isDue({ enabled: true, nextRunAtMs: now }, now)).toBe(true);
    expect(isDue({ enabled: true, nextRunAtMs: now - 60_000 }, now)).toBe(true);
  });

  it('is not due before its time', () => {
    expect(isDue({ enabled: true, nextRunAtMs: now + 1000 }, now)).toBe(false);
  });

  it('is neither due nor missed while disabled', () => {
    expect(isDue({ enabled: false, nextRunAtMs: now }, now)).toBe(false);
    expect(isMissed({ enabled: false, nextRunAtMs: now - SCHEDULE_MISS_GRACE_MS - 1 }, now)).toBe(false);
  });

  /**
   * The behaviour that keeps a closed laptop from starting a night's worth of
   * agents at breakfast.
   */
  it('counts a long-overdue run as missed rather than due', () => {
    const overdue = now - SCHEDULE_MISS_GRACE_MS - 60_000;
    expect(isDue({ enabled: true, nextRunAtMs: overdue }, now)).toBe(false);
    expect(isMissed({ enabled: true, nextRunAtMs: overdue }, now)).toBe(true);
  });
});
