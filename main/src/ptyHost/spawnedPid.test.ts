import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForSpawnedPid } from './spawnedPid';

describe('waitForSpawnedPid', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the pid once a Windows terminal finishes connecting', async () => {
    vi.useFakeTimers();
    const pty = { pid: 0 };
    const result = waitForSpawnedPid(pty, () => false);

    await vi.advanceTimersByTimeAsync(300);
    pty.pid = 29996;
    await vi.advanceTimersByTimeAsync(20);

    await expect(result).resolves.toBe(29996);
  });

  it('stops waiting when the process exits before it has a pid', async () => {
    vi.useFakeTimers();
    let exited = false;
    const result = waitForSpawnedPid({ pid: 0 }, () => exited);

    await vi.advanceTimersByTimeAsync(100);
    exited = true;
    await vi.advanceTimersByTimeAsync(20);

    await expect(result).resolves.toBe(0);
  });

  it('gives up after five seconds when the connect never lands', async () => {
    vi.useFakeTimers();
    let settled = false;
    const result = waitForSpawnedPid({ pid: 0 }, () => false).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBe(0);
  });

  it('answers at once on macOS and Linux, where the pid is known at spawn', async () => {
    await expect(waitForSpawnedPid({ pid: 4242 }, () => false)).resolves.toBe(4242);
  });
});
