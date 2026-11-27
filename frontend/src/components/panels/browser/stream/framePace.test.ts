import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { framePace } from '../../../../../../shared/utils/browserFramePace';

/** The times a still page is read in `ms`, as a stream reads it: each read waits a second on the host, then the pace decides. */
async function readsOfStillPage(ms: number): Promise<number[]> {
  const pace = framePace();
  const start = Date.now();
  const reads: number[] = [];
  while (Date.now() - start < ms) {
    reads.push(Date.now() - start);
    await vi.advanceTimersByTimeAsync(1_000);
    const next = pace.next(false);
    await vi.runOnlyPendingTimersAsync();
    await next;
  }
  return reads;
}

describe('framePace', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads a still page about every 4 s after its first few seconds, never more than 4 s apart', async () => {
    const reads = await readsOfStillPage(60_000);
    // Once a second for 5 s, then 1 s, 2 s and 3 s pauses: 5 + 1 + 1 + (60 - 5 - 2 - 3) / 4 ≈ 19, not 60.
    expect(reads.length).toBeGreaterThanOrEqual(17);
    expect(reads.length).toBeLessThanOrEqual(20);
    const gaps = reads.slice(1).map((at, index) => at - reads[index]);
    expect(Math.max(...gaps)).toBe(4_000);
  });

  it('reads at once after a frame, and when hurried in a pause', async () => {
    const pace = framePace();
    for (let index = 0; index < 8; index += 1) void pace.next(false);
    let read = false;
    void pace.next(false).then(() => { read = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toBe(false);
    pace.hurry();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toBe(true);
    // Hurried, the next "unchanged" answers read straight away again.
    let again = false;
    void pace.next(false).then(() => { again = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe(true);
    let afterFrame = false;
    void pace.next(true).then(() => { afterFrame = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(afterFrame).toBe(true);
  });

  it('ends a pause when the stream stops', async () => {
    const pace = framePace();
    for (let index = 0; index < 8; index += 1) void pace.next(false);
    let ended = false;
    void pace.next(false).then(() => { ended = true; });
    pace.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(true);
  });
});
