import { type ChildProcess, execFile, spawn } from 'child_process';
import { mkdtempSync, promises as fs, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { isProcessAlive, listDescendantPids, terminateProcessTrees, waitForProcessesToExit, windowsTerminateScript } from './processTree';

const spawned: ChildProcess[] = [];
const reportedChildren = new Set<number>();
const directories: string[] = [];

/**
 * A node process that idles forever, plus `children` identical grandchildren.
 * It prints the grandchildren's pids once they exist, so tests check for those
 * pids rather than counting the tree: under a loaded Windows runner the table
 * has shown one to five extra short-lived descendants, so a count flakes.
 */
function idleProcess(cwd: string, children = 0, detachedChildren = false): ChildProcess & { childPids: Promise<number[]> } {
  const script = `
    const { spawn } = require('child_process');
    const pids = [];
    for (let i = 0; i < ${children}; i++) {
      pids.push(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), stdio: 'ignore', detached: ${detachedChildren} }).pid);
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
      try {
        const pids: unknown = JSON.parse(line);
        if (!Array.isArray(pids) || pids.length !== children || !pids.every(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== child.pid)) {
          throw new Error(`idle process reported ${line}, not its children's pids`);
        }
        for (const pid of pids) reportedChildren.add(pid);
        resolve(pids);
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', reject);
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
  // Teardown knows every process a test started: the roots and the children
  // they reported. It kills them by pid instead of walking the tree, because a
  // walk costs two PowerShell processes on Windows, and on a loaded runner
  // those alone outlast the 10 s hook timeout.
  const exited = spawned.map(child => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('exit', resolve)));
  const roots = spawned.flatMap(child => child.pid ? [child.pid] : []);
  const pids = [...new Set([...roots, ...reportedChildren])].filter(isProcessAlive);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Exited since the check.
    }
  }
  expect(await waitForProcessesToExit(pids, 5000)).toEqual([]);
  // On Windows, a root's 'exit' fires once it has closed its handles, its cwd among them.
  await Promise.all(exited);
  spawned.length = 0;
  reportedChildren.clear();
  for (const directory of directories.splice(0)) {
    // Windows can release a dead process's cwd handle after it leaves the table.
    await fs.rm(directory, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 5 : 0, retryDelay: 100 });
  }
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

describe('terminateProcessTrees', () => {
  it('retains a reported child for teardown after its parent exits', async () => {
    // Escape the helper's Windows kill-on-close job so its child really survives.
    const child = idleProcess(temporaryDirectory(), 1, true);
    if (!child.pid) throw new Error('spawn reported no pid');
    const [grandchild] = await child.childPids;

    child.kill();
    expect(await waitForProcessesToExit([child.pid], 5000)).toEqual([]);
    expect(isProcessAlive(grandchild)).toBe(true);
  });

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

describe.skipIf(process.platform !== 'win32')('windowsTerminateScript', () => {
  it('leaves alone a pid that a newer process holds than the table read', async () => {
    const child = idleProcess(temporaryDirectory());
    if (!child.pid) throw new Error('spawn reported no pid');
    // The table says this pid belonged to a process born yesterday: whatever
    // holds it now is a different process that took the pid since.
    const staleTable = `function Get-CimInstance { [pscustomobject]@{ ProcessId = ${child.pid}; ParentProcessId = 0; CreationDate = (Get-Date).AddDays(-1) } }`;
    const script = `${staleTable}\n${windowsTerminateScript([child.pid], Date.now() + 10_000)}`;

    const { stdout } = await promisify(execFile)('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true });

    expect(stdout.split(/\r?\n/u)).toEqual(expect.arrayContaining([`tree ${child.pid}`, `exited ${child.pid}`]));
    expect(isProcessAlive(child.pid)).toBe(true);
  }, 30_000);
});
