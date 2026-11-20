import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProcessTreeSystem, terminateProcessTrees } from './processTree';

/**
 * Windows teardown against a stand-in system, so it runs on every CI OS.
 */

interface RunCall { file: string; args: readonly string[]; options: { timeout: number; windowsHide: boolean } }

const calls: RunCall[] = [];
let alive = new Set<number>();
/** What the next `run` answers: stdout, or an error carrying partial stdout. */
let answer: (call: RunCall) => { stdout: string } | { error: Error & { stdout?: string } } = () => ({ stdout: '' });

const windows: ProcessTreeSystem = {
  platform: 'win32',
  isAlive: pid => alive.has(pid),
  run: async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const result = answer(call);
    if ('error' in result) throw result.error;
    return result;
  },
};

beforeEach(() => {
  calls.length = 0;
  alive = new Set();
  answer = () => ({ stdout: '' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminateProcessTrees on Windows', () => {
  it('starts no PowerShell when every root has already exited', async () => {
    await expect(terminateProcessTrees([4242, 4343], { system: windows })).resolves.toEqual([]);

    expect(calls).toEqual([]);
  });
});
