import { spawn } from 'child_process';
import { once } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveProcessTracker, attachKernelStarts, parseProcStat, readArchiveProcesses, stopProcessIdentities, type ArchiveProcessIdentity, type ArchiveProcessObservation } from './archiveProcessTracker';
import { isProcessAlive } from '../utils/processTree';
import { spawnDetachedWorkerPty } from '../test/detachedWorkerPty';

it('retains children born after the initial capture while refreshing only known lifetimes', async () => {
  const birth = (n: number) => process.platform === 'win32' ? String(100 + n) : `2026-10-03T00:00:0${n}Z`;
  let saved: ArchiveProcessIdentity[] = [];
  const tracker = new ArchiveProcessTracker([{ pid: 1000001, parent: 0, started: birth(1) }], items => { saved = items; }, async () => [
    { pid: 1000001, parent: 0, started: birth(1), exited: false },
    { pid: 1000002, parent: 1000001, started: birth(2), exited: false },
  ]);
  await tracker.refresh();
  expect(saved.map(item => item.pid)).toEqual([1000001, 1000002]);
});

it('does not adopt a child whose stale PPID now belongs to a newer parent', async () => {
  const birth = (n: number) => process.platform === 'win32' ? String(100 + n) : `2026-10-03T00:00:0${n}Z`;
  let saved: ArchiveProcessIdentity[] = [];
  const tracker = new ArchiveProcessTracker([], items => { saved = items; }, async () => [
    { pid: 1000001, parent: 0, started: birth(2), exited: false },
    { pid: 1000002, parent: 1000001, started: birth(1), exited: false },
  ]);
  await tracker.capture([1000001]);
  expect(saved.map(item => item.pid)).toEqual([1000001]);
});

it('never escalates a reused PID or its new descendants', async () => {
  let saved: ArchiveProcessIdentity[] = [];
  const terminate = vi.fn(async (_identities: readonly ArchiveProcessIdentity[]) => {});
  const tracker = new ArchiveProcessTracker([{ pid: 1000001, parent: 0, started: 'old' }], items => { saved = items; }, async () => [
    { pid: 1000001, parent: 0, started: 'new', exited: false },
    { pid: 1000002, parent: 1000001, started: 'new-child', exited: false },
  ], terminate);
  await tracker.terminateSurvivors();
  await tracker.verifyExited(0);
  expect(terminate).toHaveBeenCalledWith([]);
  expect(saved).toEqual([]);
});

it('fails closed on snapshot failure and retains the durable identities', async () => {
  const identities = [{ pid: 1000001, parent: 0, started: 'known' }];
  const save = vi.fn();
  const tracker = new ArchiveProcessTracker(identities, save, async () => { throw new Error('snapshot denied'); });
  await expect(tracker.terminateSurvivors()).rejects.toThrow('snapshot denied');
  await expect(tracker.verifyExited(0)).rejects.toThrow('snapshot denied');
  expect(save).not.toHaveBeenCalled();
  expect(identities).toHaveLength(1);
});

it('captures and terminates a test-owned child using the same kernel birth identity', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  try {
    const pid = child.pid!;
    const snapshot = await readArchiveProcesses();
    expect(snapshot.find(item => item.pid === pid)?.started).toBeTruthy();
    let saved: ArchiveProcessIdentity[] = [];
    const tracker = new ArchiveProcessTracker([], items => { saved = items; });
    await tracker.capture([pid]);
    expect(saved.some(item => item.pid === pid)).toBe(true);
    if (process.platform === 'win32') {
      // CIM birth times have microsecond precision. Pinned .NET handles have
      // 100ns precision; truncation must retain exact Int64 digits, not doubles.
      expect(BigInt(saved.find(item => item.pid === pid)!.started) % 10n).toBe(0n);
    }
    await tracker.terminateSurvivors();
    await tracker.verifyExited();
    expect(saved).toEqual([]);
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}, 30000);

it.skipIf(process.platform === 'win32')('captures and terminates a worker that left the shell\'s tree but kept its terminal', async () => {
  const terminal = await spawnDetachedWorkerPty();
  try {
    let saved: ArchiveProcessIdentity[] = [];
    const tracker = new ArchiveProcessTracker([], items => { saved = items; });
    await tracker.capture([terminal.shellPid]);
    expect(saved.map(item => item.pid)).toContain(terminal.workerPid);

    terminal.close();
    await tracker.terminateSurvivors();
    await tracker.verifyExited(5000);

    expect(isProcessAlive(terminal.workerPid)).toBe(false);
  } finally {
    terminal.close();
    if (isProcessAlive(terminal.workerPid)) process.kill(terminal.workerPid, 'SIGKILL');
  }
}, 30000);

it.skipIf(process.platform === 'win32')('matches by terminal only at capture, only from a session leader, and only processes born after it', async () => {
  let saved: ArchiveProcessIdentity[] = [];
  const terminate = vi.fn(async (_identities: readonly ArchiveProcessIdentity[]) => {});
  let table = [
    { pid: 1000001, parent: 0, started: '2026-10-03T00:00:02Z', sessionLeader: true, exited: false },
    { pid: 1000002, parent: 1, started: '2026-10-03T00:00:03Z', exited: false },
    { pid: 1000003, parent: 1, started: '2026-10-03T00:00:01Z', exited: false },
    { pid: 1000004, parent: 1, started: '2026-10-03T00:00:03Z', exited: false },
    { pid: 1000006, parent: 0, started: '2026-10-03T00:00:02Z', exited: false },
    { pid: 1000007, parent: 1, started: '2026-10-03T00:00:03Z', exited: false },
  ];
  const terminals = new Map([
    [1000001, 'ttys009'], [1000002, 'ttys009'], [1000003, 'ttys009'], [1000004, 'ttys010'],
    // 1000006 shares a terminal it does not lead, like a child of Pane launched from a developer's shell.
    [1000006, 'ttys011'], [1000007, 'ttys011'],
  ]);
  const tracker = new ArchiveProcessTracker([], items => { saved = items; }, async () => table, terminate, async () => terminals);
  await tracker.capture([1000001, 1000006]);
  expect(saved.map(item => item.pid)).toEqual([1000001, 1000002, 1000006]);

  // After the PTY closes its name can belong to another terminal.
  table = [...table, { pid: 1000005, parent: 1, started: '2026-10-03T00:00:09Z', exited: false }];
  terminals.set(1000005, 'ttys009');
  await tracker.terminateSurvivors();
  expect(terminate.mock.calls[0][0].map(item => item.pid)).toEqual([1000006, 1000002, 1000001]);
});

describe('stopProcessIdentities', () => {
  const row = (pid: number, started: string): ArchiveProcessObservation => ({ pid, parent: 1, started, exited: false });

  it('signals a pid only while its start time still matches, so a reused pid is never hit', async () => {
    const signalled: number[] = [];
    const forced: number[] = [];
    let table = [row(10, 'Mon Nov 16 09:00:00 2026'), row(11, 'Mon Nov 16 10:30:00 2026')];
    const left = await stopProcessIdentities(
      [{ pid: 10, started: 'Mon Nov 16 09:00:00 2026' }, { pid: 11, started: 'Mon Nov 16 08:00:00 2026' }],
      {
        read: async () => table,
        signal: pid => { signalled.push(pid); table = table.filter(item => item.pid !== pid); },
        terminate: async identities => { forced.push(...identities.map(identity => identity.pid)); },
        graceMs: 0,
      },
    );
    // pid 11 now belongs to another program started at 10:30: never signalled, never forced.
    expect(signalled).toEqual(process.platform === 'win32' ? [] : [10]);
    expect(forced).toEqual(process.platform === 'win32' ? [10] : []);
    expect(left).toEqual(process.platform === 'win32' ? [{ pid: 10, started: 'Mon Nov 16 09:00:00 2026' }] : []);
  });

  it('force-stops what ignores the request to quit, and reports what still runs', async () => {
    const table = [row(20, 'Mon Nov 16 09:00:00 2026')];
    const forced: number[] = [];
    const left = await stopProcessIdentities([{ pid: 20, started: 'Mon Nov 16 09:00:00 2026' }], {
      read: async () => table, signal: () => {}, terminate: async identities => { forced.push(...identities.map(identity => identity.pid)); }, graceMs: 0,
    });
    expect(forced).toEqual([20]);
    expect(left).toEqual([{ pid: 20, started: 'Mon Nov 16 09:00:00 2026' }]);
  });
});

/** A `/proc/<pid>/stat` line: pid, (comm), state, ppid, then fields 5..21, starttime (22) and the rest. */
const procStat = (pid: number, comm: string, parent: number, startTicks: number) =>
  `${pid} (${comm}) S ${parent} ${Array.from({ length: 17 }, (_, index) => index + 5).join(' ')} ${startTicks} 4096 512 18446744073709551615\n`;

describe('parseProcStat', () => {
  it('reads the parent and start ticks', () => {
    expect(parseProcStat(procStat(4242, 'node', 1, 987654))).toEqual({ parent: 1, startTicks: '987654' });
  });

  it('counts fields from the last parenthesis, so a command name with spaces and parentheses does not shift them', () => {
    expect(parseProcStat(procStat(4242, 'tmux: server) (2 3', 77, 123456))).toEqual({ parent: 77, startTicks: '123456' });
  });

  it('rejects a line it cannot read', () => {
    expect(parseProcStat('')).toBeUndefined();
    expect(parseProcStat('4242 (node) S 1 2 3')).toBeUndefined();
    expect(parseProcStat('4242 node S 1')).toBeUndefined();
  });
});

describe('attachKernelStarts', () => {
  const boot = '6a1f0c7e-3b44-4f0e-9a51-2a0c1d9e7b10';
  const row = (pid: number, parent: number): ArchiveProcessObservation => ({ pid, parent, started: 'Mon Nov 16 09:00:00 2026', exited: false });
  const files = (entries: Record<string, string>) => async (path: string) => {
    const text = entries[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return text;
  };

  it('tags each row with the boot and its start ticks', async () => {
    const rows = [row(10, 1), row(11, 10)];
    await attachKernelStarts(rows, files({
      '/proc/sys/kernel/random/boot_id': `${boot}\n`,
      '/proc/10/stat': procStat(10, 'bash', 1, 500),
      '/proc/11/stat': procStat(11, 'sleep (x)', 10, 600),
    }));
    expect(rows.map(item => item.kernelStart)).toEqual([`${boot}:500`, `${boot}:600`]);
  });

  it('leaves a row on its lstart when its /proc entry is gone or names another parent', async () => {
    const rows = [row(10, 1), row(11, 10)];
    await attachKernelStarts(rows, files({
      '/proc/sys/kernel/random/boot_id': boot,
      // pid 10 exited after ps ran; pid 11 was reused by a child of another process.
      '/proc/11/stat': procStat(11, 'sleep', 999, 600),
    }));
    expect(rows.map(item => item.kernelStart)).toEqual([undefined, undefined]);
  });

  it('leaves every row on its lstart when /proc cannot be read', async () => {
    const rows = [row(10, 1)];
    await attachKernelStarts(rows, files({ '/proc/10/stat': procStat(10, 'bash', 1, 500) }));
    expect(rows[0].kernelStart).toBeUndefined();
  });

  it.runIf(process.platform === 'linux')('reads the live table with a kernel start for this process', async () => {
    const self = (await readArchiveProcesses()).find(item => item.pid === process.pid);
    expect(self?.kernelStart).toMatch(/^[0-9a-f-]+:\d+$/u);
  });
});
