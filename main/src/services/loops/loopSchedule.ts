import { Cron } from 'croner';
import {
  LOOP_MIN_INTERVAL_MS,
  LOOP_MISS_GRACE_MS,
  type LoopSchedulePreview,
} from '../../../../shared/types/loop';
import { describeSchedule, scheduleFromCron } from '../../../../shared/utils/loopSchedule';

/**
 * When a loop runs. Cron in the host's local time zone, read by croner, which
 * handles daylight saving: a slot in the skipped hour runs at the first valid
 * time, and a repeated hour runs once.
 */

/** Enough upcoming runs to catch a pair closer than an hour in any weekly pattern. */
const MIN_INTERVAL_SAMPLE = 24;

function parseCron(cron: string): Cron {
  return new Cron(cron.trim(), { paused: true, mode: '5-part' });
}

/** A stored cron that no longer parses (say, after a parser upgrade) never runs, rather than stopping every other loop. */
function parseStoredCron(cron: string): Cron | null {
  try {
    return parseCron(cron);
  } catch {
    return null;
  }
}

/** The first run strictly after `afterMs`, or null when the cron never runs again. */
export function nextLoopRun(cron: string, afterMs: number): number | null {
  return parseStoredCron(cron)?.nextRun(new Date(afterMs))?.getTime() ?? null;
}

/** What a cron means, or why a loop cannot use it. */
export function previewLoopSchedule(cron: string, nowMs: number): LoopSchedulePreview {
  let runs: Date[];
  try {
    runs = parseCron(cron).nextRuns(MIN_INTERVAL_SAMPLE, new Date(nowMs));
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^CronPattern: /, '') : String(error);
    return { ok: false, error: `"${cron}" is not a five-field cron: ${reason}` };
  }
  if (runs.length === 0) return { ok: false, error: `"${cron}" never runs.` };

  for (let index = 1; index < runs.length; index++) {
    const gapMs = runs[index].getTime() - runs[index - 1].getTime();
    // croner lists the first time after a skipped hour twice (02:00 and 03:00 both run at 03:00); that is one run.
    if (gapMs > 0 && gapMs < LOOP_MIN_INTERVAL_MS) {
      return {
        ok: false,
        error: `"${cron}" runs more often than once an hour. Loops need at least 60 minutes between runs; for short waits, use your agent's own sleep and wake.`,
      };
    }
  }

  return {
    ok: true,
    scheduleText: describeCron(cron),
    nextRunAtMs: runs[0].getTime(),
    nextRunsAtMs: runs.slice(0, 3).map(run => run.getTime()),
  };
}

/** A picker shape in the picker's words; an hourly step or anything else as its cron. */
function describeCron(cron: string): string {
  const text = cron.trim().replace(/\s+/g, ' ');
  const picked = describeSchedule(scheduleFromCron(text));
  if (picked) return picked;
  const [minute, hour, day, month, weekday] = text.split(' ');
  const step = /^\*\/(\d{1,2})$/.exec(hour ?? '');
  if (step && minute === '0' && day === '*' && month === '*' && weekday === '*') {
    return step[1] === '1' ? 'Hourly, on the hour' : `Every ${step[1]} hours`;
  }
  return `Cron ${text}`;
}

export type LoopDecision =
  | { kind: 'wait'; atMs: number | null }
  | { kind: 'run'; slotAtMs: number }
  | { kind: 'skip'; slotAtMs: number };

/**
 * What to do about a loop now, counting only slots after `fromMs` (the last
 * slot it handled, or when its schedule last started counting).
 *
 * A slot up to the grace period late runs. Later than that, only the latest
 * missed slot is recorded as skipped: missed runs are never caught up.
 */
export function decideLoop(cron: string, fromMs: number, nowMs: number): LoopDecision {
  const schedule = parseStoredCron(cron);
  if (!schedule) return { kind: 'wait', atMs: null };
  let latest = schedule.nextRun(new Date(fromMs));
  if (!latest || latest.getTime() > nowMs) return { kind: 'wait', atMs: latest?.getTime() ?? null };

  // The 60-minute floor bounds this walk to one step per hour away.
  for (let next = schedule.nextRun(latest); next && next.getTime() <= nowMs; next = schedule.nextRun(next)) {
    latest = next;
  }

  const slotAtMs = latest.getTime();
  return nowMs - slotAtMs <= LOOP_MISS_GRACE_MS ? { kind: 'run', slotAtMs } : { kind: 'skip', slotAtMs };
}
