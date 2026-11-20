import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ProcessTreeSystem, terminateProcessTrees } from './processTree';

/**
 * Windows teardown against a stand-in system, so it runs on every CI OS. The
 * real PowerShell script runs in processTree.test.ts on the Windows runner.
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

  it('reads the table, kills and waits in exactly one PowerShell process', async () => {
    alive = new Set([100, 101]);
    answer = () => ({ stdout: 'tree 100\r\ntree 101\r\nexited 101\r\nexited 100\r\n' });

    await expect(terminateProcessTrees([100, 100], { system: windows })).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('powershell');
    expect(calls[0].options.windowsHide).toBe(true);
    const script = calls[0].args.at(-1) ?? '';
    expect(script).toContain('$roots = @(100)');
    expect(script).not.toContain('Add-Type');
  });

  it('stops waiting at the timeout and reports what is still running', async () => {
    alive = new Set([100, 101]);
    answer = () => ({ stdout: 'tree 100\ntree 101\nexited 101\nalive 100\n' });
    const before = Date.now();

    await expect(terminateProcessTrees([100], { timeoutMs: 1_500, system: windows })).resolves.toEqual([100]);

    const after = Date.now();
    expect(calls).toHaveLength(1);
    // The script's deadline is the caller's, in .NET ticks, and execFile gives it only start-up room beyond that.
    const deadline = /^\$deadline = \[long\](\d+)$/mu.exec(calls[0].args.at(-1) ?? '');
    const toTicks = (ms: number) => BigInt(ms) * 10_000n + 621_355_968_000_000_000n;
    expect(BigInt(deadline?.[1] ?? 0)).toBeGreaterThanOrEqual(toTicks(before + 1_500));
    expect(BigInt(deadline?.[1] ?? 0)).toBeLessThanOrEqual(toTicks(after + 1_500));
    expect(calls[0].options.timeout).toBeLessThanOrEqual(1_500 + 5_000);
  });

  it('answers within the timeout when PowerShell is stopped mid-wait, without starting another process', async () => {
    alive = new Set([100, 101]);
    answer = () => ({ error: Object.assign(new Error('Command failed: powershell'), { killed: true, stdout: 'tree 100\ntree 101\nexited 101\n' }) });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = Date.now();

    await expect(terminateProcessTrees([100], { timeoutMs: 200, system: windows })).resolves.toEqual([100]);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toHaveLength(1);
  });

  it('polls by exit code a process the script could not hold a handle to', async () => {
    alive = new Set([100, 101]);
    // Constrained Language Mode: the script kills by pid and reports no wait.
    answer = () => ({ stdout: 'tree 100\ntree 101\n' });

    await expect(terminateProcessTrees([100], { timeoutMs: 100, system: windows })).resolves.toEqual([100, 101]);

    expect(calls).toHaveLength(1);
  });

  it('never kills a pid that a new process took since the table was read', async () => {
    // 101 was a child when the table was read; the script found a newer process holding it.
    alive = new Set([100, 101]);
    answer = () => ({ stdout: 'tree 100\ntree 101\nexited 101\nexited 100\n' });

    await expect(terminateProcessTrees([100], { system: windows })).resolves.toEqual([]);

    // Nothing outside the script could have killed it: no taskkill, and the script left it alone.
    expect(calls.map(call => call.file)).toEqual(['powershell']);
    expect(alive.has(101)).toBe(true);
  });

  it('kills only the roots, by pid, when PowerShell cannot start', async () => {
    alive = new Set([100]);
    answer = call => call.file === 'powershell'
      ? { error: Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }) }
      : { stdout: '' };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await terminateProcessTrees([100], { timeoutMs: 100, system: windows });

    expect(calls.map(call => call.file)).toEqual(['powershell', 'taskkill']);
    expect(calls[1].args).toEqual(['/F', '/PID', '100']);
    expect(calls[1].options.windowsHide).toBe(true);
  });
});
