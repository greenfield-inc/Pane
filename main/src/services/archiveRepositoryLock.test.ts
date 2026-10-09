import { afterEach, expect, it, vi } from 'vitest';
import { withArchiveRepositoryKey } from './archiveRepositoryLock';

afterEach(() => vi.useRealTimers());

it('admits distinct worktree mutations FIFO after more than 30s and lets other repositories progress', async () => {
  vi.useFakeTimers();
  const entered: string[] = [];
  let release = () => {};
  const owner = withArchiveRepositoryKey('/repo/common', async () => {
    entered.push('worktrees/first');
    await new Promise<void>(resolve => { release = resolve; });
  });
  await Promise.resolve();
  const second = withArchiveRepositoryKey('/repo/common', async () => { entered.push('worktrees/second'); });
  const third = withArchiveRepositoryKey('/repo/common', async () => { entered.push('worktrees/third'); });
  try {
    await vi.advanceTimersByTimeAsync(61000);
    await withArchiveRepositoryKey('/other/common', async () => { entered.push('other'); });
    expect(entered).toEqual(['worktrees/first', 'other']);
  } finally {
    release();
    await Promise.all([owner, second, third]);
  }
  expect(entered).toEqual(['worktrees/first', 'other', 'worktrees/second', 'worktrees/third']);
});

it('releases admission after the owner throws', async () => {
  const owner = withArchiveRepositoryKey('/failed/common', async () => { throw new Error('failed'); });
  const next = withArchiveRepositoryKey('/failed/common', async () => 'next');
  await expect(owner).rejects.toThrow('failed');
  await expect(next).resolves.toBe('next');
});
