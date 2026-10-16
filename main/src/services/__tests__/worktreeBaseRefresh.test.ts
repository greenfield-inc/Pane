import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandRunner } from '../../utils/commandRunner';
import { PathResolver } from '../../utils/pathResolver';
import { withArchiveRepositoryLock } from '../archiveRepositoryLock';
import { BASE_REFRESH_REUSE_MS } from '../worktreeBaseRefresh';
import { WorktreeManager } from '../worktreeManager';
import { worktreePoolManager } from '../worktreePoolManager';

const directories: string[] = [];
const previousPaneDir = process.env.PANE_DIR;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', ...args], { cwd, encoding: 'utf8' }).trim();

beforeAll(() => {
  process.env.PANE_DIR = temporaryDirectory();
});

afterAll(async () => {
  // A create replenishes the reserve after it returns. Its git commands run in the
  // fixture's project, and on Windows a folder a process runs in cannot be deleted.
  await worktreePoolManager.idle();
  if (previousPaneDir === undefined) delete process.env.PANE_DIR;
  else process.env.PANE_DIR = previousPaneDir;
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      // TEMPORARY DIAGNOSTIC (remove before merge): which process still holds the fixture?
      if (process.platform === 'win32' && error instanceof Error) {
        const processes = execFileSync('powershell', ['-NoProfile', '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "git|sh|ssh|sleep|bash" } | '
          + 'Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | Format-List | Out-String -Width 400'], { encoding: 'utf8' });
        throw new Error(`${error.message}\nat ${new Date().toISOString()}; live processes:\n${processes}`, { cause: error });
      }
      throw error;
    }
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pane-base-refresh-')));
  directories.push(directory);
  return directory;
}

/**
 * A bare remote, the Pane project cloned from it, and a second clone that
 * pushes to the remote, as in the bug report. The project's origin/main
 * stays at A until something fetches.
 */
function remoteFixture() {
  const root = temporaryDirectory();
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const other = join(root, 'other');
  git(root, 'clone', '-q', remote, other);
  git(other, 'checkout', '-q', '-b', 'main');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'A');
  git(other, 'push', '-q', 'origin', 'main');
  const project = join(root, 'project');
  git(root, 'clone', '-q', remote, project);
  mkdirSync(join(project, 'worktrees'));
  const runner = new CommandRunner({ path: project });
  const resolver = new PathResolver({ path: project });
  const advanceRemote = (message: string): string => {
    git(other, 'commit', '-q', '--allow-empty', '-m', message);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { root, remote, project, runner, resolver, advanceRemote, tipA: git(other, 'rev-parse', 'HEAD') };
}

/** Moves Date.now past the window in which a recent fetch is reused. */
function outlastRecentFetch(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + BASE_REFRESH_REUSE_MS + 1_000);
}

function claimedFromReserve(project: string, branch: string): boolean {
  return /renamed refs\/heads\/_reserve\/[0-9a-f]{8} to refs\/heads\//.test(git(project, 'reflog', 'show', '--format=%gs', branch));
}

function fetchCalls(runner: CommandRunner) {
  const execFile = vi.spyOn(runner, 'execFile');
  return () => execFile.mock.calls.filter(([, args]) => args[0] === 'fetch');
}

describe('creating a worktree Pane on a remote-tracking base', () => {
  it('starts a cold create at the remote tip, not the stale local origin/main', async () => {
    const fixture = remoteFixture();
    const tipB = fixture.advanceRemote('B');
    expect(git(fixture.project, 'rev-parse', 'origin/main')).toBe(fixture.tipA);

    const result = await new WorktreeManager().resolveWorkingDirectory(
      fixture.project, 'cold', undefined, true, undefined, fixture.resolver, fixture.runner,
    );

    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(tipB);
    expect(result.baseCommit).toBe(tipB);
    expect(result.base).toEqual({ ref: 'origin/main', commit: tipB, refresh: 'fetched' });
  });

  it('creates from the local ref with a four-part notice when the remote is missing', async () => {
    const fixture = remoteFixture();
    fixture.advanceRemote('B');
    git(fixture.project, 'remote', 'set-url', 'origin', join(fixture.root, 'missing.git'));

    const result = await new WorktreeManager().resolveWorkingDirectory(
      fixture.project, 'offline', undefined, true, undefined, fixture.resolver, fixture.runner,
    );

    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(fixture.tipA);
    expect(result.base).toMatchObject({ ref: 'origin/main', commit: fixture.tipA, refresh: 'failed' });
    const notice = result.base?.notice ?? '';
    expect(notice).toMatch(/^Could not refresh origin\/main before creating this Pane \(git fetch failed: .*missing\.git.*\)\./);
    expect(notice).toContain(`It starts from the local origin/main at ${fixture.tipA.slice(0, 7)}, which may be behind the remote.`);
    expect(notice).toContain('Check the network or credentials, then run `git pull --rebase origin main` in the Pane if it needs newer commits.');
  });

  it('stops waiting for a hanging fetch at the cap, without prompting or holding the repository lock', async () => {
    const fixture = remoteFixture();
    git(fixture.project, 'remote', 'set-url', 'origin', 'ssh://pane.invalid/remote.git');
    // Leave the project first: on Windows, stopping git at the cap leaves this command running,
    // and a process whose folder is inside the fixture keeps it from being deleted (EBUSY).
    git(fixture.project, 'config', 'core.sshCommand', 'cd / && exec sleep 20 #');
    const fetches = fetchCalls(fixture.runner);
    const started = Date.now();

    const create = new WorktreeManager().resolveWorkingDirectory(
      fixture.project, 'hang', undefined, true, undefined, fixture.resolver, fixture.runner,
    );
    await vi.waitFor(() => expect(fetches()).toHaveLength(1));
    const lockStarted = Date.now();
    await withArchiveRepositoryLock(fixture.project, fixture.runner, async () => undefined);
    expect(Date.now() - lockStarted).toBeLessThan(2_000);

    const result = await create;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.base).toMatchObject({ refresh: 'failed', commit: fixture.tipA });
    expect(result.base?.notice).toContain('(git fetch timed out after 10s)');
    expect(fetches()[0][3]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0' });
  }, 30_000);

  it('shares one fetch across creates that run together', async () => {
    const fixture = remoteFixture();
    const tipB = fixture.advanceRemote('B');
    const fetches = fetchCalls(fixture.runner);
    const manager = new WorktreeManager();

    const results = await Promise.all(['one', 'two', 'three'].map(name => manager.resolveWorkingDirectory(
      fixture.project, name, undefined, true, undefined, fixture.resolver, fixture.runner,
    )));

    expect(fetches()).toHaveLength(1);
    for (const result of results) {
      expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(tipB);
    }
  });

  it.each([
    ['a local branch', () => 'main'],
    ['a commit', (tip: string) => tip],
  ])('does not fetch for %s', async (_label, base) => {
    const fixture = remoteFixture();
    fixture.advanceRemote('B');
    const fetches = fetchCalls(fixture.runner);

    const result = await new WorktreeManager().resolveWorkingDirectory(
      fixture.project, 'local', base(fixture.tipA), true, undefined, fixture.resolver, fixture.runner,
    );

    expect(fetches()).toHaveLength(0);
    expect(result.base).toMatchObject({ refresh: 'skipped', commit: fixture.tipA });
    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(fixture.tipA);
  });
});

describe('the reserve worktree pool', () => {
  it('discards a reserve made before the remote moved', async () => {
    const fixture = remoteFixture();
    await worktreePoolManager.createReserve(fixture.project, 'origin/main', undefined, fixture.resolver, fixture.runner);
    expect(worktreePoolManager.hasReserve(fixture.project, 'origin/main')).toBe(true);
    const tipB = fixture.advanceRemote('B');
    outlastRecentFetch();

    const result = await new WorktreeManager().resolveWorkingDirectory(
      fixture.project, 'moved', undefined, true, undefined, fixture.resolver, fixture.runner,
    );

    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(tipB);
    expect(claimedFromReserve(fixture.project, 'moved')).toBe(false);
  });

  it('hands out a reserve that is still on the remote tip', async () => {
    const fixture = remoteFixture();
    await worktreePoolManager.createReserve(fixture.project, 'origin/main', undefined, fixture.resolver, fixture.runner);
    outlastRecentFetch();

    const result = await new WorktreeManager().resolveWorkingDirectory(
      fixture.project, 'warm', undefined, true, undefined, fixture.resolver, fixture.runner,
    );

    expect(claimedFromReserve(fixture.project, 'warm')).toBe(true);
    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(fixture.tipA);
    expect(result.base).toEqual({ ref: 'origin/main', commit: fixture.tipA, refresh: 'fetched' });
  });

  it('never hands out a reserve whose base ref moved while it was being made', async () => {
    for (let run = 0; run < 8; run++) {
      const fixture = remoteFixture();
      // The bug report's race: a fetch lands between the reserve's
      // `worktree add` and the pool recording which commit it is on.
      const execFile = fixture.runner.execFile.bind(fixture.runner);
      let raced = false;
      vi.spyOn(fixture.runner, 'execFile').mockImplementation(async (file, args, cwd, options) => {
        const result = await execFile(file, args, cwd, options);
        if (!raced && args[0] === 'worktree' && args[1] === 'add' && args.includes('--no-track')) {
          raced = true;
          fixture.advanceRemote(`race ${run}`);
          git(fixture.project, 'fetch', '-q', 'origin');
        }
        return result;
      });
      await worktreePoolManager.createReserve(fixture.project, 'origin/main', undefined, fixture.resolver, fixture.runner);
      expect(raced).toBe(true);

      const result = await new WorktreeManager().resolveWorkingDirectory(
        fixture.project, `race-${run}`, undefined, true, undefined, fixture.resolver, fixture.runner,
      );

      expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(git(fixture.project, 'rev-parse', 'origin/main'));
    }
  }, 60_000);

  it('seeds the reserve under the default base even when the project is on a feature branch', async () => {
    const fixture = remoteFixture();
    git(fixture.project, 'checkout', '-q', '-b', 'feature/elsewhere');
    const manager = new WorktreeManager();

    await manager.seedReserve(fixture.project, undefined, fixture.resolver, fixture.runner);

    expect(worktreePoolManager.hasReserve(fixture.project, 'origin/main')).toBe(true);
    const result = await manager.resolveWorkingDirectory(
      fixture.project, 'seeded', undefined, true, undefined, fixture.resolver, fixture.runner,
    );
    expect(claimedFromReserve(fixture.project, 'seeded')).toBe(true);
    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(fixture.tipA);
    // The claim's replacement reserve is still being made after the create returned.
    expect(worktreePoolManager.hasReserve(fixture.project, 'origin/main')).toBe(false);
    await worktreePoolManager.idle();
    expect(worktreePoolManager.hasReserve(fixture.project, 'origin/main')).toBe(true);
  });
});
