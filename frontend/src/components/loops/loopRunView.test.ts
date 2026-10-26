import { describe, expect, it } from 'vitest';
import { formatDuration, formatNextRun } from './loopRunView';

describe('formatDuration', () => {
  it('reads in the largest two units', () => {
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(65 * 60_000)).toBe('1h 5m');
    expect(formatDuration(120 * 60_000)).toBe('2h');
    expect(formatDuration(26 * 3_600_000)).toBe('1d 2h');
  });
});

describe('formatNextRun', () => {
  const now = new Date(2026, 9, 24, 13, 0).getTime();

  it('names today and tomorrow, and dates anything later', () => {
    expect(formatNextRun(new Date(2026, 9, 24, 16, 0).getTime(), now)).toBe('Today 16:00');
    expect(formatNextRun(new Date(2026, 9, 25, 3, 0).getTime(), now)).toBe('Tomorrow 03:00');
    expect(formatNextRun(new Date(2026, 9, 27, 9, 0).getTime(), now)).toBe('Tue Oct 27 09:00');
  });
});
