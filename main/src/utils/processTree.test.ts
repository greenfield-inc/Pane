import { type ChildProcess, spawn } from 'child_process';
import { mkdtempSync, promises as fs, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isProcessAlive, listDescendantPids, listTerminalProcessPids, terminateProcessTrees, waitForProcessesToExit } from './processTree';
import { spawnDetachedWorkerPty } from '../test/detachedWorkerPty';

const spawned: ChildProcess[] = [];
const directories: string[] = [];

/**
 * A node process that idles forever, plus `children` identical grandchildren.
 * It prints the grandchildren's pids once they exist, so tests check for those
 * pids rather than counting the tree: under a loaded Windows runner the table
 * has shown one to five extra short-lived descendants, so a count flakes.
 */
function idleProcess(cwd: string, children = 0): ChildProcess & { childPids: Promise<number[]> } {
  const script = `
    const { spawn } = require('child_process');
    const pids = [];
    for (let i = 0; i < ${children}; i++) {
      pids.push(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), stdio: 'ignore' }).pid);
    }
    process.stdout.write(JSON.stringify(pids) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  spawned.push(child);
  const childPids = new Promise<number[]>((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (!output.includes('\n')) return;
      const line = output.split('\n')[0];
      const pids: unknown = JSON.parse(line);
      if (Array.isArray(pids) && pids.every(Number.isInteger)) resolve(pids);
      else reject(new Error(`idle process reported ${line}, not a list of pids`));
    });
    child.once('exit', code => reject(new Error(`idle process exited (${code}) before reporting its children`)));
  });
  // A test that never reads the pids must not fail on the rejection when teardown kills the process.
  childPids.catch(() => undefined);
  return Object.assign(child, { childPids });
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pane-process-tree-')));
  directories.push(directory);
  return directory;
}

/**
 * Lists `pid`'s descendants until every one of `expected` is among them. Poll
 * rather than sleep a fixed amount: reading the process table costs a
 * PowerShell process on Windows, which is slow enough under a loaded test run
 * to make any guessed delay flaky.
 */
async function waitForDescendants(pid: number, expected: readonly number[]): Promise<number[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const descendants = await listDescendantPids([pid]);
    if (expected.every(child => descendants.includes(child)) || Date.now() >= deadline) return descendants;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

afterEach(async () => {
  // One call, so teardown costs one process-table read rather than one each.
  const pids = spawned.splice(0).flatMap(child => child.pid ? [child.pid] : []);
  if (pids.length > 0) await terminateProcessTrees(pids, { timeoutMs: 15_000 });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('isProcessAlive', () => {
  it('reports a running process, and stops once it exits', async () => {
    const child = idleProcess(temporaryDirectory());
    const pid = child.pid;
    if (!pid) throw new Error('spawn reported no pid');

    expect(isProcessAlive(pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);

    child.kill();
    expect(await waitForProcessesToExit([pid], 5000)).toEqual([]);
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe('waitForProcessesToExit', () => {
  it('returns the pids still running when the budget runs out', async () => {
    const child = idleProcess(temporaryDirectory());
    if (!child.pid) throw new Error('spawn reported no pid');

    expect(await waitForProcessesToExit([child.pid], 100)).toEqual([child.pid]);
  });
});

describe('listDescendantPids', () => {
  it('finds the children a process launched, without the roots themselves', async () => {
    const child = idleProcess(temporaryDirectory(), 2);
    if (!child.pid) throw new Error('spawn reported no pid');
    const grandchildren = await child.childPids;
    expect(grandchildren).toHaveLength(2);

    const descendants = await waitForDescendants(child.pid, grandchildren);

    expect(descendants).toEqual(expect.arrayContaining(grandchildren));
    expect(descendants).not.toContain(child.pid);
    for (const pid of grandchildren) expect(isProcessAlive(pid)).toBe(true);
  }, 30_000);

  it('has nothing to report for a pid that cannot exist', async () => {
    await expect(listDescendantPids([])).resolves.toEqual([]);
    await expect(listDescendantPids([0, -7])).resolves.toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('listTerminalProcessPids', () => {
  it('finds a worker that double-forked out of the shell, by its controlling terminal', async () => {
    const terminal = await spawnDetachedWorkerPty();
    const unrelated = idleProcess(temporaryDirectory());
    try {
      expect(await listDescendantPids([terminal.shellPid])).not.toContain(terminal.workerPid);

      const pids = await listTerminalProcessPids([terminal.shellPid]);

      expect(pids).toContain(terminal.workerPid);
      expect(pids).not.toContain(terminal.shellPid);
      expect(pids).not.toContain(unrelated.pid);
      // The worker shares the terminal but does not lead its session, so it names nothing.
      expect(await listTerminalProcessPids([terminal.workerPid])).not.toContain(terminal.shellPid);
    } finally {
      terminal.close();
      await terminateProcessTrees([terminal.workerPid], { timeoutMs: 5000 });
    }
  }, 30_000);

  it('has nothing to report for a pid that cannot exist', async () => {
    await expect(listTerminalProcessPids([0, -7])).resolves.toEqual([]);
  });
});

describe('terminateProcessTrees', () => {
  it('kills a process and its children, which frees the directory they were sitting in', async () => {
    const parent = temporaryDirectory();
    const held = join(parent, 'held');
    await fs.mkdir(held);
    const child = idleProcess(held, 2);
    if (!child.pid) throw new Error('spawn reported no pid');
    const grandchildren = await child.childPids;
    expect(await waitForDescendants(child.pid, grandchildren)).toEqual(expect.arrayContaining(grandchildren));
    const tree = [child.pid, ...grandchildren];

    // Windows refuses to move a directory that is a live process's cwd; this
    // is the lock that used to make archiving a Pane fail.
    if (process.platform === 'win32') {
      await expect(fs.rename(held, join(parent, 'moved'))).rejects.toMatchObject({ code: 'EBUSY' });
    }

    expect(await terminateProcessTrees(tree, { timeoutMs: 15_000 })).toEqual([]);

    for (const pid of tree) expect(isProcessAlive(pid)).toBe(false);
    await expect(fs.rename(held, join(parent, 'moved'))).resolves.toBeUndefined();
  }, 30_000);

  it('kills a child its parent left behind', async () => {
    const child = idleProcess(temporaryDirectory(), 1);
    if (!child.pid) throw new Error('spawn reported no pid');
    const [grandchild] = await child.childPids;
    expect(await waitForDescendants(child.pid, [grandchild])).toContain(grandchild);

    expect(await terminateProcessTrees([child.pid], { timeoutMs: 15_000 })).toEqual([]);

    expect(isProcessAlive(grandchild)).toBe(false);
  }, 30_000);

  it('does nothing for pids that cannot exist', async () => {
    await expect(terminateProcessTrees([])).resolves.toEqual([]);
    await expect(terminateProcessTrees([0, -7])).resolves.toEqual([]);
  });
});
