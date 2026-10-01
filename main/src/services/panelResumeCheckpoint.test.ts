import { describe, expect, it, vi } from 'vitest';
import { ScrollbackCheckpoint } from './panelResumeCheckpoint';

function harness(generations: Record<string, number>) {
  const save = vi.fn(async (_panelId: string) => undefined);
  const checkpoint = new ScrollbackCheckpoint({
    intervalMs: 10_000,
    listRunningPanelIds: () => Object.keys(generations),
    getOutputGeneration: panelId => generations[panelId] ?? 0,
    save,
    log: () => undefined,
  });
  return { checkpoint, save };
}

describe('ScrollbackCheckpoint', () => {
  it('saves only panels with output since their last save', async () => {
    const generations = { a: 1, b: 5 };
    const { checkpoint, save } = harness(generations);

    expect(await checkpoint.checkpoint()).toBe(2);
    expect(await checkpoint.checkpoint()).toBe(0);
    generations.b = 6;
    expect(await checkpoint.checkpoint()).toBe(1);
    expect(save.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'b']);
  });

  it('retries a panel whose save failed', async () => {
    const { checkpoint, save } = harness({ a: 1 });
    save.mockRejectedValueOnce(new Error('disk full'));

    expect(await checkpoint.checkpoint()).toBe(0);
    expect(await checkpoint.checkpoint()).toBe(1);
  });

  it('joins overlapping checkpoints into one run', async () => {
    const { checkpoint, save } = harness({ a: 1 });
    const [first, second] = await Promise.all([checkpoint.checkpoint(), checkpoint.checkpoint()]);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('runs on its interval until stopped', async () => {
    vi.useFakeTimers();
    try {
      const { checkpoint, save } = harness({ a: 1 });
      checkpoint.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).toHaveBeenCalledTimes(1);
      checkpoint.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
