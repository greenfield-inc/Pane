import { type ChildProcess, spawn } from 'child_process';
import { mkdtempSync, promises as fs, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isProcessAlive, listDescendantPids, terminateProcessTrees, waitForProcessesToExit } from './processTree';

const spawned: ChildProcess[] = [];
const directories: string[] = [];

/** A node process that idles forever, plus `children` identical grandchildren. */
function idleProcess(cwd: string, children = 0): ChildProcess {
  const script = `
    const { spawn } = require('child_process');
    for (let i = 0; i < ${children}; i++) {
      spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), stdio: 'ignore' });
    }
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { cwd, stdio: 'ignore' });
  spawned.push(child);
  return child;
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pane-process-tree-')));
  directories.push(directory);
  return directory;
}

/**
 * The grandchildren are spawned after the parent is up, so poll for them
 * rather than sleeping a fixed amount: reading the process table costs a
 * PowerShell process on Windows, which is slow enough under a loaded test run
 * to make any guessed delay flaky.
 */
async function waitForDescendants(pid: number, count: number): Promise<number[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const descendants = await listDescendantPids([pid]);
    if (descendants.length >= count || Date.now() >= deadline) return descendants;
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

    const descendants = await waitForDescendants(child.pid, 2);

    expect(descendants).toHaveLength(2);
    expect(descendants).not.toContain(child.pid);
    for (const pid of descendants) expect(isProcessAlive(pid)).toBe(true);
  }, 30_000);

  it('has nothing to report for a pid that cannot exist', async () => {
    await expect(listDescendantPids([])).resolves.toEqual([]);
    await expect(listDescendantPids([0, -7])).resolves.toEqual([]);
  });
});

describe('terminateProcessTrees', () => {
  it('kills a process and its children, which frees the directory they were sitting in', async () => {
    const parent = temporaryDirectory();
    const held = join(parent, 'held');
    await fs.mkdir(held);
    const child = idleProcess(held, 2);
    if (!child.pid) throw new Error('spawn reported no pid');
    const tree = [child.pid, ...await waitForDescendants(child.pid, 2)];
    expect(tree).toHaveLength(3);

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
    const [grandchild] = await waitForDescendants(child.pid, 1);
    expect(grandchild).toBeTypeOf('number');

    expect(await terminateProcessTrees([child.pid], { timeoutMs: 15_000 })).toEqual([]);

    expect(isProcessAlive(grandchild)).toBe(false);
  }, 30_000);

  it('does nothing for pids that cannot exist', async () => {
    await expect(terminateProcessTrees([])).resolves.toEqual([]);
    await expect(terminateProcessTrees([0, -7])).resolves.toEqual([]);
  });
});
