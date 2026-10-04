import os from 'os';
import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitFileWatcher } from '../gitFileWatcher';
import type { CommandRunner } from '../../utils/commandRunner';
import type { Logger } from '../../utils/logger';

// Typed access to the private pure logic under test (no-any policy).
interface GitFileWatcherInternals {
  isIgnoredEventPath(relPath: string, gitignoredDirs: Set<string>, isLeafDirectory?: boolean): boolean;
  getGitignoredDirs(watchPath: string): Promise<Set<string>>;
  transitionToPolling(sessionId: string, worktreePath: string, err: Error): Promise<void>;
  pollStatusSnapshot(sessionId: string): Promise<void>;
  handleWatcherFailure(sessionId: string, err: Error): void;
  watchedSessions: Map<string, { mode: string; watcherErrorLogged: boolean; lastStatusSnapshot?: string }>;
}

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: These fixtures implement every collaborator member exercised by
  // the watcher scenarios; unexpected calls fail immediately.
  return implementation as Contract;
}

function watcherInternals(watcher: GitFileWatcher): GitFileWatcherInternals {
  // SAFETY: The interface above mirrors the private pure/test seam exactly.
  return watcher as GitFileWatcherInternals;
}

function makeLogger(): Logger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return partialMock<Logger & { warns: string[]; errors: string[] }>({
    warns,
    errors,
    info: vi.fn(),
    verbose: vi.fn(),
    warn: (m: string) => warns.push(m),
    error: (m: string) => errors.push(m),
  });
}

function makeCommandRunner(exec: (command: string, cwd: string) => string | Promise<string>): CommandRunner {
  return partialMock<CommandRunner>({ execAsync: async (command, cwd) => ({ stdout: await exec(command, cwd), stderr: '' }), wslContext: null });
}

describe('GitFileWatcher pure logic', () => {
  let watcher: GitFileWatcher;
  let internals: GitFileWatcherInternals;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = makeLogger();
  });

  afterEach(() => {
    watcher?.stopAll();
    vi.useRealTimers();
  });

  function build(exec: (command: string, cwd: string) => string | Promise<string> = () => ''): void {
    watcher = new GitFileWatcher(logger, makeCommandRunner(exec));
    internals = watcherInternals(watcher);
  }

  it('does not start a watcher or invoke Git for the home directory', async () => {
    const exec = vi.fn(() => '');
    build(exec);
    watcher.startWatching('home', os.homedir());
    expect(internals.watchedSessions.size).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(logger.warns[0]).toContain('home directory');
  });

  describe('isIgnoredEventPath', () => {
    const none = new Set<string>();

    it('drops anything under .git (narrow watcher owns those signals)', async () => {
      build();
      expect(internals.isIgnoredEventPath('.git/index.lock', none)).toBe(true);
      expect(internals.isIgnoredEventPath('.git', none)).toBe(true);
    });

    it('drops IGNORED_DIRS at any depth, including the leaf segment', async () => {
      build();
      expect(internals.isIgnoredEventPath('node_modules/pkg/index.js', none)).toBe(true);
      expect(internals.isIgnoredEventPath('apps/web/node_modules/x', none)).toBe(true);
      expect(internals.isIgnoredEventPath('node_modules', none)).toBe(true);
    });

    it('drops gitignore-derived relative prefixes, including nested ones', async () => {
      build();
      const gitignored = new Set(['worktrees', 'main/dist']);
      expect(internals.isIgnoredEventPath('worktrees/wt1/src/a.ts', gitignored)).toBe(true);
      expect(internals.isIgnoredEventPath('main/dist/index.js', gitignored)).toBe(true);
      expect(internals.isIgnoredEventPath('main/src/index.ts', gitignored)).toBe(false);
      // "worktrees" must match as a path prefix, not a substring
      expect(internals.isIgnoredEventPath('worktrees-notes.md', gitignored)).toBe(false);
    });

    it('handles win32 backslash separators', async () => {
      build();
      expect(internals.isIgnoredEventPath('node_modules\\pkg\\x.js', none)).toBe(true);
      expect(internals.isIgnoredEventPath('src\\a.ts', none)).toBe(false);
    });

    it('applies IGNORED_FILE_PATTERNS to the leaf only when it may be a file', async () => {
      build();
      expect(internals.isIgnoredEventPath('src/.DS_Store', none)).toBe(true);
      expect(internals.isIgnoredEventPath('src/backup~', none)).toBe(true);
      // a DIRECTORY named like a temp file must not be pruned when the caller
      // knows it is a directory (chokidar registration path has stats)
      expect(internals.isIgnoredEventPath('src/backup~', none, true)).toBe(false);
      expect(internals.isIgnoredEventPath('src/regular.ts', none)).toBe(false);
    });

    it('never ignores an empty path', async () => {
      build();
      expect(internals.isIgnoredEventPath('', none)).toBe(false);
    });
  });

  describe('getGitignoredDirs', () => {
    it('keeps only trailing-slash directory lines, stripped of the slash', async () => {
      build(() => 'node_modules/\nmain/dist/\nsome-ignored-file.log\nworktrees/\n');
      const dirs = await internals.getGitignoredDirs('/repo');
      expect(dirs).toEqual(new Set(['node_modules', 'main/dist', 'worktrees']));
    });

    it('returns an empty set (hardcoded list still applies) when git fails', async () => {
      build(() => {
        throw new Error('not a git repository');
      });
      expect((await internals.getGitignoredDirs('/not-a-repo')).size).toBe(0);
    });

    it('caches per watchPath and refreshes only after the TTL', async () => {
      const exec = vi.fn(() => 'worktrees/\n');
      build(exec);
      await internals.getGitignoredDirs('/repo');
      await internals.getGitignoredDirs('/repo');
      expect(exec).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await internals.getGitignoredDirs('/repo');
      expect(exec).toHaveBeenCalledTimes(2);
    });
  });

  describe('transitionToPolling / handleWatcherFailure', () => {
    it('discards an in-flight poll after stop and does not emit its old snapshot', async () => {
      let finish = (_snapshot: string): void => { throw new Error('Poll not started'); };
      const pending = new Promise<string>(resolve => { finish = resolve; });
      const exec = vi.fn(() => pending);
      build(exec);
      const refresh = vi.fn();
      watcher.on('needs-refresh', refresh);

      const transition = internals.transitionToPolling('s1', '/repo', new Error('EMFILE'));
      await internals.pollStatusSnapshot('s1');
      expect(exec).toHaveBeenCalledTimes(1);
      watcher.stopWatching('s1');
      finish('M old-file.txt\n');
      await transition;

      expect(refresh).not.toHaveBeenCalled();
      expect(internals.watchedSessions.size).toBe(0);
    });

    it('does not resurrect a watcher stopped during asynchronous startup', async () => {
      let finish = (_snapshot: string): void => { throw new Error('Scan not started'); };
      const pending = new Promise<string>(resolve => { finish = resolve; });
      const exec = vi.fn(() => pending);
      build(exec);

      const start = watcher.startWatching('s1', '/repo');
      watcher.stopAll();
      finish('node_modules/\n');
      await start;

      expect(exec).toHaveBeenCalledTimes(1);
      expect(internals.watchedSessions.size).toBe(0);
    });

    it('builds a complete record with no prior session, warns once, seeds the baseline, emits once', async () => {
      const exec = vi.fn((cmd: string) => (cmd.startsWith('git status') ? 'M file.txt\n' : ''));
      build(exec);
      const emits: string[] = [];
      watcher.on('needs-refresh', (sid: string) => emits.push(sid));

      await internals.transitionToPolling('s1', '/repo', new Error('EMFILE: too many open files'));

      const record = internals.watchedSessions.get('s1');
      expect(record?.mode).toBe('polling');
      expect(record?.watcherErrorLogged).toBe(true);
      // baseline seeded before the initial reconcile event — a change in the 0-5s window diffs against it
      expect(record?.lastStatusSnapshot).toBe('M file.txt\n');
      expect(logger.warns).toHaveLength(1);
      expect(emits).toEqual(['s1']); // immediate reconcile emit, no seed emit
    });

    it('polling emits only on snapshot CHANGE, never while dirty-but-unchanged', async () => {
      let status = 'M file.txt\n';
      build((cmd: string) => (cmd.startsWith('git status') ? status : ''));
      const emits: string[] = [];
      watcher.on('needs-refresh', (sid: string) => emits.push(sid));

      await internals.transitionToPolling('s1', '/repo', new Error('EMFILE'));
      expect(emits).toHaveLength(1); // the immediate degrade emit

      await vi.advanceTimersByTimeAsync(5_000); // tick with unchanged dirty status
      await vi.advanceTimersByTimeAsync(5_000);
      expect(emits).toHaveLength(1); // no spam

      status = 'M file.txt\nM other.ts\n';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(emits).toHaveLength(2); // change detected
    });

    it('handleWatcherFailure swallows repeat failures once degraded', async () => {
      build((cmd: string) => (cmd.startsWith('git status') ? '' : ''));
      await internals.transitionToPolling('s1', '/repo', new Error('EMFILE'));
      internals.handleWatcherFailure('s1', new Error('EMFILE'));
      internals.handleWatcherFailure('s1', new Error('EMFILE'));
      expect(logger.warns).toHaveLength(1);
    });

    it('handleWatcherFailure no-ops for unknown sessions', async () => {
      build();
      internals.handleWatcherFailure('ghost', new Error('EMFILE'));
      expect(logger.warns).toHaveLength(0);
      expect(internals.watchedSessions.size).toBe(0);
    });
  });

  describe('WSL native watcher', () => {
    const originalPlatform = process.platform;
    type FakeStream = EventEmitter & { setEncoding: () => void };
    let child: EventEmitter & { stdout: FakeStream; stderr: FakeStream; kill: () => void };
    let spawnMock: ReturnType<typeof vi.fn<(file: string, args: string[]) => typeof child>>;

    function makeStream(): FakeStream {
      return Object.assign(new EventEmitter(), { setEncoding: () => {} });
    }

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      child = Object.assign(new EventEmitter(), { stdout: makeStream(), stderr: makeStream(), kill: vi.fn() });
      spawnMock = vi.fn(() => child);
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    function buildWsl(exec: (command: string) => string = () => ''): void {
      const runner = partialMock<CommandRunner>({
        execAsync: async (command) => ({ stdout: exec(command), stderr: '' }),
        wslContext: { enabled: true, distribution: 'Ubuntu', linuxPath: '/home/me/repo' },
      });
      // SAFETY: the fake child implements every ChildProcess member the WSL watcher touches.
      watcher = new GitFileWatcher(logger, runner, undefined, partialMock<typeof spawn>(spawnMock));
      internals = watcherInternals(watcher);
    }

    it('execs bash directly so the script and worktree path reach it verbatim', async () => {
      buildWsl();
      await watcher.startWatching('s1', '/home/me/repo');

      // `wsl.exe -- …` re-parses the command line through the distro's login
      // shell, which expands "$1" and "$(git status …)" before our bash runs:
      // the watcher then cd's nowhere and never reports a change.
      const [file, args] = spawnMock.mock.calls[0];
      expect(file).toBe('wsl.exe');
      expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', 'bash']);
      expect(args).not.toContain('--');
      expect(args.slice(-2)).toEqual(['pane-wsl-watch', '/home/me/repo']);
      expect(internals.watchedSessions.get('s1')?.mode).toBe('wsl');
    });

    it('reports a change printed by the in-distro watcher', async () => {
      buildWsl((command) => (command.startsWith('git ls-files --others') ? 'new.txt\n' : ''));
      const emits: string[] = [];
      watcher.on('needs-refresh', (sid: string) => emits.push(sid));
      await watcher.startWatching('s1', '/home/me/repo');

      child.stdout.emit('data', '__PANE_WSL_POLL__\n');
      await vi.advanceTimersByTimeAsync(1_500);

      expect(emits).toEqual(['s1']);
    });

    it('degrades to git status polling when the in-distro watcher dies', async () => {
      let status = '';
      buildWsl((command) => (command.startsWith('git status') ? status : ''));
      const emits: string[] = [];
      watcher.on('needs-refresh', (sid: string) => emits.push(sid));
      await watcher.startWatching('s1', '/home/me/repo');

      child.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      expect(internals.watchedSessions.get('s1')?.mode).toBe('polling');
      expect(emits).toEqual(['s1']);

      status = '?? new.txt\n';
      await vi.advanceTimersByTimeAsync(5_000);
      expect(emits).toEqual(['s1', 's1']);
    });

    it('does not degrade when the watcher was stopped on purpose', async () => {
      buildWsl();
      await watcher.startWatching('s1', '/home/me/repo');
      watcher.stopWatching('s1');
      child.emit('exit', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(0);
      expect(internals.watchedSessions.size).toBe(0);
    });
  });
});
