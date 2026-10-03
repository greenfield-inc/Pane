import { afterEach, describe, expect, it, vi } from 'vitest';
import type Bull from 'bull';
import { TaskQueue } from './taskQueue';
import * as sessionClaudeTerminal from './sessionClaudeTerminal';

// No job is run in these constructor tests; record configuration without opening Redis.
function fakeQueue(_name: string, _options: Bull.QueueOptions) {
  return { process: vi.fn(), on: vi.fn().mockReturnThis() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('TaskQueue Redis configuration', () => {
  it.each([undefined, 'redis://user:secret@localhost:6379/1'])('retains cleanup defaults with Redis URL %s', redisUrl => {
    vi.stubEnv('REDIS_URL', redisUrl);
    const createQueue = vi.fn(fakeQueue);
    const queueConstructor: unknown = createQueue;
    // SAFETY: The fake supports process/on; jobs and Redis connections are deliberately not run.
    const RedisQueue = queueConstructor as typeof Bull;
    // SAFETY: Processor dependencies are not accessed until a job runs.
    new TaskQueue({ useSimpleQueue: false } as ConstructorParameters<typeof TaskQueue>[0], RedisQueue);
    expect(createQueue).toHaveBeenCalledTimes(3);
    for (const [name, options] of createQueue.mock.calls) {
      expect(['session-creation', 'session-input', 'session-continue']).toContain(name);
      expect(options.defaultJobOptions).toEqual({ removeOnComplete: true, removeOnFail: false });
      expect(options.redis).toBe(redisUrl);
    }
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain('secret');
  });
});

it('reports queued input completion and failure through the in-process backend', async () => {
  vi.useFakeTimers();
  const runClaude = vi.spyOn(sessionClaudeTerminal, 'runSessionClaude')
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('Claude terminal is still starting'));
  // SAFETY: Only input jobs run, with their session-controller boundary explicitly stubbed above.
  const queue = new TaskQueue({ useSimpleQueue: true } as ConstructorParameters<typeof TaskQueue>[0]);
  try {
    const completed = await queue.sendInput('session-a', 'first prompt');
    const failed = await queue.sendInput('session-b', 'second prompt');
    await vi.waitFor(() => {
      expect(completed).toMatchObject({ status: 'completed' });
      expect(failed).toMatchObject({ status: 'failed', error: expect.objectContaining({ message: 'Claude terminal is still starting' }) });
    });
    expect(runClaude).toHaveBeenNthCalledWith(1, undefined, 'session-a', 'first prompt', { mode: 'input' }, undefined);
    expect(runClaude).toHaveBeenNthCalledWith(2, undefined, 'session-b', 'second prompt', { mode: 'input' }, undefined);
  } finally {
    await queue.close();
  }
});
