import { describe, expect, it } from 'vitest';
import { DEFAULT_LEAK_RULE, findLeak, type RssSample } from './leakRule';

const MIN = 60_000;

/** One sample a minute from `fromMin` to `toMin` (inclusive), RSS from `mb(minute)`. */
function series(fromMin: number, toMin: number, mb: (minute: number) => number): RssSample[] {
  const samples: RssSample[] = [];
  for (let m = fromMin; m <= toMin; m++) samples.push({ at: m * MIN, rssMB: mb(m) });
  return samples;
}

describe('findLeak with the default rule (30 min window, 5 min slices, 1 GB, +500 MB and +50%)', () => {
  it('flags a process that climbs 25 MB a minute for the whole window', () => {
    // 1000 MB at minute 30, 1750 MB at minute 60: +750 MB, +75%.
    const samples = series(30, 60, m => 1000 + (m - 30) * 25);
    expect(findLeak(samples, 0, 60 * MIN, DEFAULT_LEAK_RULE)).toEqual({ growthMB: 750, windowMs: 30 * MIN, rssMB: 1750 });
  });

  it('ignores an install that climbs for 5 minutes and then holds', () => {
    // 1000 → 1800 MB by minute 35, then flat: later slices set no new high.
    const samples = series(30, 60, m => (m <= 35 ? 1000 + (m - 30) * 160 : 1800));
    expect(findLeak(samples, 0, 60 * MIN, DEFAULT_LEAK_RULE)).toBeNull();
  });

  it('ignores a process still under 1 GB', () => {
    const samples = series(30, 60, m => 300 + (m - 30) * 20); // 300 → 900 MB
    expect(findLeak(samples, 0, 60 * MIN, DEFAULT_LEAK_RULE)).toBeNull();
  });

  it('ignores a process younger than 30 minutes', () => {
    const samples = series(30, 60, m => 1000 + (m - 30) * 25);
    expect(findLeak(samples, 40 * MIN, 60 * MIN, DEFAULT_LEAK_RULE)).toBeNull();
  });

  it('waits until samples cover the whole window', () => {
    const samples = series(45, 60, m => 1000 + (m - 45) * 60); // 15 minutes of history
    expect(findLeak(samples, 0, 60 * MIN, DEFAULT_LEAK_RULE)).toBeNull();
  });

  it('ignores growth under 50% even when it passes 500 MB', () => {
    const samples = series(30, 60, m => 2000 + (m - 30) * 20); // 2000 → 2600 MB, +30%
    expect(findLeak(samples, 0, 60 * MIN, DEFAULT_LEAK_RULE)).toBeNull();
  });
});

describe('findLeak with the QA rule (5 min window, 1 min slices, +150 MB and +50%, no minimum size)', () => {
  const qaRule = { windowMs: 5 * MIN, sliceMs: MIN, minRssMB: 0, minGrowthMB: 150, minGrowthRatio: 0.5, minAgeMs: 0 };

  it('flags the fixture that grows 40 MB a minute within 6 minutes', () => {
    const samples = series(0, 6, m => 200 + m * 40); // window minute 1 → 6: 240 → 440 MB
    expect(findLeak(samples, 0, 6 * MIN, qaRule)).toEqual({ growthMB: 200, windowMs: 5 * MIN, rssMB: 440 });
  });

  it('ignores the fixture that grows 300 MB in 2 minutes and then holds', () => {
    const samples = series(0, 6, m => (m <= 2 ? 200 + m * 150 : 500));
    expect(findLeak(samples, 0, 6 * MIN, qaRule)).toBeNull();
  });
});
