import { describe, expect, it } from 'vitest';

import { SilenceWatch, pcmLevelDbfs, recordingClock } from './recordingLimits';

describe('recordingClock', () => {
  it('counts up for the first fourteen minutes', () => {
    expect(recordingClock(0)).toMatchObject({ label: '0:00', countdown: false });
    expect(recordingClock(65_400)).toMatchObject({ label: '1:05', countdown: false });
    expect(recordingClock(840_000)).toMatchObject({ label: '14:00', countdown: false });
  });

  it('counts down the last minute to 0:00 at fifteen minutes', () => {
    expect(recordingClock(840_001)).toMatchObject({ label: '0:59', countdown: true });
    expect(recordingClock(870_000)).toMatchObject({ label: '0:30', countdown: true });
    expect(recordingClock(899_000)).toMatchObject({ label: '0:01', countdown: true });
    expect(recordingClock(900_000)).toMatchObject({ label: '0:00', countdown: true });
    expect(recordingClock(905_000)).toMatchObject({ label: '0:00', countdown: true });
  });
});

function pcm(samples: number[]): ArrayBuffer {
  return new Int16Array(samples).buffer;
}

describe('pcmLevelDbfs', () => {
  it('reads a full-scale square wave as 0 dBFS', () => {
    expect(pcmLevelDbfs(pcm([32767, -32768, 32767, -32768]))).toBeCloseTo(0, 3);
  });

  it('reads a half-scale sine as -9.03 dBFS', () => {
    const sine = Array.from({ length: 1600 }, (_, index) => Math.round(16384 * Math.sin((2 * Math.PI * index) / 16)));
    expect(pcmLevelDbfs(pcm(sine))).toBeCloseTo(-9.03, 1);
  });

  it('reads digital silence and an empty buffer as the -160 floor', () => {
    expect(pcmLevelDbfs(pcm([0, 0, 0, 0]))).toBe(-160);
    expect(pcmLevelDbfs(new ArrayBuffer(0))).toBe(-160);
  });
});

describe('SilenceWatch', () => {
  it('fires after 30 seconds below -50 dBFS', () => {
    const watch = new SilenceWatch(0);
    for (let now = 0; now < 30_000; now += 250) watch.hear(-62, now);
    expect(watch.silent(29_999)).toBe(false);
    expect(watch.silent(30_000)).toBe(true);
  });

  it('restarts the wait whenever it hears speech or steady noise', () => {
    const watch = new SilenceWatch(0);
    watch.hear(-28, 20_000); // speech
    expect(watch.silent(45_000)).toBe(false);
    watch.hear(-42, 45_000); // wind
    expect(watch.silent(70_000)).toBe(false);
    expect(watch.silent(75_000)).toBe(true);
  });
});
