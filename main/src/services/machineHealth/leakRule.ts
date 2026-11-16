import { MACHINE_HEALTH_DEFAULTS, type MachineHealthSettings } from '../../../../shared/types/machineHealth';

/** One resident-memory reading of a process. */
export interface RssSample {
  at: number;
  rssMB: number;
}

export interface LeakRule {
  /** How far back the growth is measured. */
  windowMs: number;
  /** The window splits into slices; each must set a new high. */
  sliceMs: number;
  minRssMB: number;
  minGrowthMB: number;
  /** Growth as a fraction of the RSS at the start of the window (0.5 is 50%). */
  minGrowthRatio: number;
  minAgeMs: number;
}

export interface LeakFinding {
  growthMB: number;
  windowMs: number;
  rssMB: number;
}

const MINUTE = 60_000;
/** A slice's high counts as new only when it beats the last by this much, so jitter is not a climb. */
const MIN_SLICE_RISE_MB = 10;

/** The rule from config.json's settings, each falling back to MACHINE_HEALTH_DEFAULTS. */
export function leakRuleOf(settings: MachineHealthSettings | undefined): LeakRule {
  const value = <K extends keyof MachineHealthSettings>(key: K) => settings?.[key] ?? MACHINE_HEALTH_DEFAULTS[key];
  return {
    windowMs: value('leakWindowMinutes') * MINUTE,
    sliceMs: value('leakSliceMinutes') * MINUTE,
    minRssMB: value('leakMinRssMB'),
    minGrowthMB: value('leakMinGrowthMB'),
    minGrowthRatio: value('leakMinGrowthPercent') / 100,
    minAgeMs: value('leakMinAgeMinutes') * MINUTE,
  };
}

export const DEFAULT_LEAK_RULE: LeakRule = leakRuleOf(undefined);

/**
 * A likely leak keeps climbing: installs and builds climb for minutes and then
 * stop, so the process must set a new high in every slice of the window, not
 * only grow overall. `samples` are in time order; the reading at or just before
 * the window start is the baseline, so history must reach past the window.
 */
export function findLeak(samples: readonly RssSample[], startedAt: number, now: number, rule: LeakRule): LeakFinding | null {
  if (now - startedAt < rule.minAgeMs || samples.length === 0) return null;
  const windowStart = now - rule.windowMs;
  let baselineIndex = -1;
  for (let i = 0; i < samples.length && samples[i].at <= windowStart; i++) baselineIndex = i;
  if (baselineIndex < 0) return null;

  const baseline = samples[baselineIndex].rssMB;
  const current = samples[samples.length - 1].rssMB;
  const growth = current - baseline;
  if (current < rule.minRssMB || growth < rule.minGrowthMB || baseline <= 0 || growth / baseline < rule.minGrowthRatio) return null;

  let high = baseline;
  const slices = Math.max(1, Math.round(rule.windowMs / rule.sliceMs));
  for (let slice = 0; slice < slices; slice++) {
    const from = windowStart + slice * rule.sliceMs;
    const to = slice === slices - 1 ? now : from + rule.sliceMs;
    let sliceHigh = -Infinity;
    for (let i = baselineIndex + 1; i < samples.length; i++) {
      const { at, rssMB } = samples[i];
      if (at > from && at <= to) sliceHigh = Math.max(sliceHigh, rssMB);
    }
    if (sliceHigh < high + MIN_SLICE_RISE_MB) return null;
    high = sliceHigh;
  }
  return { growthMB: Math.round(growth), windowMs: rule.windowMs, rssMB: Math.round(current) };
}
