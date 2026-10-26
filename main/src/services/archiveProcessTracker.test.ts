import { spawn } from 'child_process';
import { once } from 'events';
import { expect, it, vi } from 'vitest';
import { ArchiveProcessTracker, readArchiveProcesses, type ArchiveProcessIdentity } from './archiveProcessTracker';
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
