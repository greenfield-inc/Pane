import { type ChildProcess, execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../../utils/commandRunner';
import { PathResolver } from '../../utils/pathResolver';
import { terminateProcessTrees } from '../../utils/processTree';
import { classifyWorktree, removeWorktreeViaTrash, sweepWorktreeTrash, waitForPendingWorktreeTrash } from '../worktreeTrash';
import { ArchiveProgressManager } from '../archiveProgressManager';

const directories: string[] = [];
const holders: ChildProcess[] = [];

/**
 * A process sitting in `cwd` and doing nothing else, like the panel shell and
 * the agent CLI a Pane leaves in its worktree. Windows will not let the
 * directory be renamed or removed while it is a live process's cwd.
 */
function processHolding(cwd: string): ChildProcess {
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
  holders.push(holder);
  return holder;
}

function busyError(): NodeJS.ErrnoException {
  return Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pane-worktree-trash-')));
  directories.push(directory);
  return directory;
}

function repositoryWithWorktree() {
  const repo = join(temporaryDirectory(), 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
  const worktree = join(temporaryDirectory(), 'worktree');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  mkdirSync(join(worktree, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(worktree, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  return { repo, worktree, runner: new CommandRunner({ path: repo }), resolver: new PathResolver({ path: repo }) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const holder of holders.splice(0)) {
    if (holder.pid) await terminateProcessTrees([holder.pid], { timeoutMs: 5000 });
  }
  await waitForPendingWorktreeTrash();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('removeWorktreeViaTrash', () => {
  it('moves the worktree into the trash, prunes it, deletes it, and keeps the branch', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { label: 'pane-1' });

    expect(outcome).toBe('done');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.replaceAll('\\', '/'));
    expect(git(repo, 'branch', '--list', 'feature')).toContain('feature');
    expect(readdirSync(join(repo, '.git', 'pane-trash'))).toEqual([]);
  });

  it('reports pending after a delete failure and retries on the next sweep', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    const remove = vi.spyOn(fsPromises, 'rm').mockRejectedValue(new Error('file is busy'));
    expect(await removeWorktreeViaTrash(worktree, repo, resolver, runner)).toBe('pending');
    await waitForPendingWorktreeTrash();
    expect(readdirSync(join(repo, '.git', 'pane-trash'))).toHaveLength(1);
    remove.mockRestore();
    await sweepWorktreeTrash(repo, resolver, runner);
    expect(readdirSync(join(repo, '.git', 'pane-trash'))).toEqual([]);
  });

  it('reports pending while the files are still being deleted, then deletes them', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    const realRm = fsPromises.rm.bind(fsPromises);
    let release: () => void = () => undefined;
    const released = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, options) => {
      await released;
      return realRm(target, options);
    });

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { label: 'pane-2', inlineGraceMs: 10 });

    expect(outcome).toBe('pending');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.replaceAll('\\', '/'));
    const [entry] = readdirSync(join(repo, '.git', 'pane-trash'));
    expect(entry).toMatch(/^pane-2-[0-9a-f]{8}$/);

    release();
    await waitForPendingWorktreeTrash();
    expect(readdirSync(join(repo, '.git', 'pane-trash'))).toEqual([]);
  });

  it('retries the rename while something still holds the worktree, rather than falling back to git', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    const realRename = fsPromises.rename.bind(fsPromises);
    let attempts = 0;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (++attempts <= 3) throw busyError();
      return realRename(from, to);
    });
    const execFile = vi.spyOn(runner, 'execFile');

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { label: 'pane-busy' });

    expect(outcome).toBe('done');
    expect(attempts).toBe(4);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.replaceAll('\\', '/'));
    expect(execFile.mock.calls.some(([file, args]) => file === 'git' && args[0] === 'worktree' && args[1] === 'remove')).toBe(false);
  });

  it('removes a worktree a live process is still sitting in', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    const holder = processHolding(worktree);
    // Mirrors the archive ordering bug: the panel process has been asked to
    // stop but is still alive when the worktree removal starts.
    setTimeout(() => holder.kill(), 1200);

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { label: 'pane-held' });

    expect(outcome).toBe('done');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.replaceAll('\\', '/'));
    expect(git(repo, 'branch', '--list', 'feature')).toContain('feature');
  });

  it('trashes the empty directory git leaves behind when it cannot unlink the worktree root', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    const realRename = fsPromises.rename.bind(fsPromises);
    // The Windows signature: git deletes every file inside the worktree and
    // then fails on the root, which is a live process's cwd.
    let rootLocked = true;
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (rootLocked) throw busyError();
      return realRename(from, to);
    });
    const realExecFile = runner.execFile.bind(runner);
    vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
      if (file !== 'git' || args[0] !== 'worktree' || args[1] !== 'remove') {
        return realExecFile(file, args, cwd, options);
      }
      for (const entry of readdirSync(worktree)) rmSync(join(worktree, entry), { recursive: true, force: true });
      rootLocked = false;
      throw new Error(`error: failed to delete '${worktree}': Permission denied`);
    });

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { label: 'pane-leftover', busyRetryMs: 10 });

    expect(outcome).toBe('done');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.replaceAll('\\', '/'));
    await waitForPendingWorktreeTrash();
    expect(readdirSync(join(repo, '.git', 'pane-trash'))).toEqual([]);
  });

  it('retries a busy empty directory in place when it cannot be moved either', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(busyError());
    const realRmdir = fsPromises.rmdir.bind(fsPromises);
    const rmdir = vi.spyOn(fsPromises, 'rmdir').mockRejectedValueOnce(busyError())
      .mockImplementationOnce(target => realRmdir(target));
    const realExecFile = runner.execFile.bind(runner);
    vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
      if (file !== 'git' || args[0] !== 'worktree' || args[1] !== 'remove') {
        return realExecFile(file, args, cwd, options);
      }
      for (const entry of readdirSync(worktree)) rmSync(join(worktree, entry), { recursive: true, force: true });
      throw new Error(`error: failed to delete '${worktree}': Permission denied`);
    });

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner, { busyRetryMs: 10 });

    expect(outcome).toBe('done');
    expect(rmdir).toHaveBeenCalledTimes(2);
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.replaceAll('\\', '/'));
  });

  it('reports the git failure when the worktree directory really cannot be removed', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(busyError());
    vi.spyOn(fsPromises, 'rmdir').mockRejectedValue(busyError());
    const realExecFile = runner.execFile.bind(runner);
    vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
      if (file !== 'git' || args[0] !== 'worktree' || args[1] !== 'remove') {
        return realExecFile(file, args, cwd, options);
      }
      throw new Error(`error: failed to delete '${worktree}': Permission denied`);
    });

    await expect(removeWorktreeViaTrash(worktree, repo, resolver, runner, { busyRetryMs: 10 }))
      .rejects.toThrow(/Permission denied/);

    expect(existsSync(worktree)).toBe(true);
  });

  it('fails a nonempty leftover and advances the archive queue without starting an unbounded recursive delete', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(busyError());
    const realExecFile = runner.execFile.bind(runner);
    vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
      if (file === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error(`error: failed to delete '${worktree}': Filename too long`);
      }
      return realExecFile(file, args, cwd, options);
    });
    // Model the observed fs.rm that never settles. Releasing it in finally
    // keeps even a failing regression run from leaving a live deletion behind.
    let releaseDeletion = () => {};
    const deletion = new Promise<void>(resolve => { releaseDeletion = resolve; });
    const realRm = fsPromises.rm.bind(fsPromises);
    const remove = vi.spyOn(fsPromises, 'rm').mockImplementation((target, options) =>
      target === worktree ? deletion : realRm(target, options));
    const manager = new ArchiveProgressManager();
    let nextStarted = () => {};
    const next = new Promise<boolean>(resolve => { nextStarted = () => resolve(true); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      manager.addTask('blocked', 'blocked', 'blocked', 'test', async () => {
        try {
          await removeWorktreeViaTrash(worktree, repo, resolver, runner, { busyRetryMs: 0 });
        } catch (error) {
          // The session IPC handler reports the failure, then continues its
          // artifact cleanup rather than throwing out of the queued callback.
          manager.updateTaskStatus('blocked', 'failed', error instanceof Error ? error.message : String(error));
        }
        manager.updateTaskStatus('blocked', 'cleaning-artifacts');
      });
      manager.addTask('next', 'next', 'next', 'test', async () => { nextStarted(); });
      const advanced = await Promise.race([
        next,
        new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 1500); }),
      ]);
      expect(advanced).toBe(true);
      expect(manager.getActiveTasks().find(task => task.sessionId === 'blocked')).toMatchObject({
        status: 'failed', error: expect.stringContaining('Filename too long'),
      });
      expect(remove.mock.calls.some(([target]) => target === worktree)).toBe(false);
      expect(existsSync(join(worktree, 'node_modules', 'dep', 'index.js'))).toBe(true);
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(worktree.replaceAll('\\', '/'));
    } finally {
      clearTimeout(deadline);
      releaseDeletion();
      await next;
    }
  });

  it('falls back to git worktree remove when the rename fails, for example across filesystems', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    vi.spyOn(fsPromises, 'rename').mockRejectedValue(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }));

    const outcome = await removeWorktreeViaTrash(worktree, repo, resolver, runner);

    expect(outcome).toBe('done');
    expect(existsSync(worktree)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.replaceAll('\\', '/'));
  });

  it('leaves a locked worktree to git, which refuses to remove it', async () => {
    const { repo, worktree, runner, resolver } = repositoryWithWorktree();
    git(repo, 'worktree', 'lock', worktree);

    await expect(removeWorktreeViaTrash(worktree, repo, resolver, runner)).rejects.toThrow(/locked/);

    expect(existsSync(worktree)).toBe(true);
  });

  it('never moves the main checkout', async () => {
    const { repo, runner, resolver } = repositoryWithWorktree();

    await expect(removeWorktreeViaTrash(repo, repo, resolver, runner)).rejects.toThrow();

    expect(existsSync(join(repo, '.git'))).toBe(true);
  });
});

describe('archive callback lifetime', () => {
  it('keeps failed cleanup active until artifacts settle, then publishes failure', async () => {
    vi.useFakeTimers();
    const manager = new ArchiveProgressManager();
    let release = () => {};
    const artifacts = new Promise<void>(resolve => { release = resolve; });
    try {
      manager.addTask('failed', 'pane', 'worktree', 'project', async () => {
        manager.updateTaskStatus('failed', 'failed', 'Worktree remains busy');
        manager.updateTaskStatus('failed', 'cleaning-artifacts');
        await artifacts;
        manager.updateTaskStatus('failed', 'completed');
      });
      await vi.advanceTimersByTimeAsync(4000);
      expect(manager.hasActiveTasks()).toBe(true);
      expect(manager.getProgress().activeCount).toBe(1);
      expect(manager.getActiveTasks()[0]).toMatchObject({ status: 'cleaning-artifacts', error: 'Worktree remains busy' });
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.hasActiveTasks()).toBe(false);
      expect(manager.getActiveTasks()[0]).toMatchObject({ status: 'failed', error: 'Worktree remains busy' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(manager.getActiveTasks()).toEqual([]);
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});

describe('classifyWorktree', () => {
  it('tells linked worktrees from the main checkout and other repositories', async () => {
    const { repo, worktree, runner } = repositoryWithWorktree();
    const other = repositoryWithWorktree();

    await expect(classifyWorktree(worktree, repo, runner)).resolves.toMatchObject({ kind: 'linked' });
    await expect(classifyWorktree(repo, repo, runner)).resolves.toEqual({ kind: 'main' });
    await expect(classifyWorktree(other.worktree, repo, runner)).resolves.toEqual({ kind: 'foreign' });
    await expect(classifyWorktree(join(repo, 'missing'), repo, runner)).resolves.toEqual({ kind: 'unknown' });
  });
});

describe('sweepWorktreeTrash', () => {
  it('deletes trash left behind by an earlier run', async () => {
    const { repo, runner, resolver } = repositoryWithWorktree();
    const leftover = join(repo, '.git', 'pane-trash', 'pane-old-00000000');
    mkdirSync(join(leftover, 'node_modules'), { recursive: true });
    writeFileSync(join(leftover, 'node_modules', 'file.js'), '');

    await sweepWorktreeTrash(repo, resolver, runner);

    expect(existsSync(leftover)).toBe(false);
  });
});
