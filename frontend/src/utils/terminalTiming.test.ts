import { describe, expect, it } from 'vitest';
import { TerminalTiming } from '../../../shared/terminalTiming';

describe('terminal timing samples', () => {
  it('bounds storage, ignores invalid samples, and returns independent snapshots', () => {
    const timing = new TerminalTiming();
    for (let i = 0; i < 10_000; i++) timing.record('outputParse', i);
    timing.record('outputParse', NaN);
    timing.record('outputParse', -1);
    const snapshot = timing.snapshot();
    expect(snapshot.outputParse.count).toBe(10_000);
    expect(snapshot.outputParse.recentMs).toHaveLength(128);
    expect(Math.min(...snapshot.outputParse.recentMs)).toBe(9872);
    snapshot.outputParse.recentMs.length = 0;
    expect(timing.snapshot().outputParse.recentMs).toHaveLength(128);
  });
});
