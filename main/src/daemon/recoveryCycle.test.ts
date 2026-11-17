import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryCycle, relayRecoveryCycle } from '../../../shared/remoteClient/recoveryCycle';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('remote recovery deadline', () => {
  it('keeps one five-minute budget through failed restoration and stops after sleep', () => {
    vi.useFakeTimers();
    const cycle = new RecoveryCycle(() => 0.5);
    expect(cycle.nextDelay()).toBe(250);
    vi.advanceTimersByTime(45_000);
    expect(cycle.nextDelay()).toBe(750);
    vi.advanceTimersByTime(254_000);
    expect(cycle.nextDelay()).toBe(1000);
    vi.advanceTimersByTime(1000);
    expect(cycle.nextDelay()).toBeNull();
    cycle.reset();
    expect(cycle.nextDelay()).toBe(250);
  });

  it('tries three times in the first three seconds, then doubles up to thirty seconds', () => {
    vi.useFakeTimers();
    const cycle = new RecoveryCycle(() => 0.5);
    expect(Array.from({ length: 8 }, () => cycle.nextDelay())).toEqual([250, 750, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('retries a relay computer every 5 s for an hour, then about once a minute, and never gives up', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const cycle = relayRecoveryCycle();
    for (let i = 0; i < 6; i += 1) cycle.nextDelay();
    expect(cycle.nextDelay()).toBe(5_000);
    vi.advanceTimersByTime(59 * 60_000);
    expect(cycle.nextDelay()).toBe(5_000);
    vi.advanceTimersByTime(60_000);
    expect(cycle.nextDelay()).toBe(60_000);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(cycle.nextDelay()).toBe(60_000);
    cycle.reset();
    expect(cycle.nextDelay()).toBe(250);
  });
});
