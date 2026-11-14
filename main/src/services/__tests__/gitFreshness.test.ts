import { execFileSync, spawn } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../database/models';
import { CommandRunner } from '../../utils/commandRunner';
import { PathResolver } from '../../utils/pathResolver';
import type { Logger } from '../../utils/logger';
import type { Session } from '../../types/session';
import { GitDiffManager } from '../gitDiffManager';
import { stopFsmonitorDaemon } from '../gitPerformanceConfig';
import { GitStatusManager } from '../gitStatusManager';
import type { SessionManager } from '../sessionManager';
import { onFetch } from '../worktreeBaseRefresh';
import { WorktreeManager } from '../worktreeManager';

const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', ...args], { cwd, encoding: 'utf8' }).trim();

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: each fixture supplies the members GitStatusManager reads; a missing one fails the test.
  return value as Contract;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const TEN_MINUTES_AGO = () => new Date(Date.now() - 10 * 60_000);

/**
 * A bare origin, a second clone that pushes to it, and the Pane project with two
 * Panes (worktrees `a` and `b`) based on origin/main. The project last fetched ten
 * minutes ago, as its FETCH_HEAD says.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pane-git-freshness-')));
  directories.push(root);
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const other = join(root, 'other');
  git(root, 'clone', '-q', remote, other);
  git(other, 'checkout', '-q', '-b', 'main');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'A');
  git(other, 'push', '-q', 'origin', 'main');
  git(other, 'push', '-q', 'origin', 'main:side');
  const project = join(root, 'project');
  git(root, 'clone', '-q', remote, project);
  git(project, 'fetch', '-q', 'origin');
  utimesSync(join(project, '.git', 'FETCH_HEAD'), TEN_MINUTES_AGO(), TEN_MINUTES_AGO());
  const runner = new CommandRunner({ path: project });

  const sessions = ['a', 'b'].map(name => {
    const worktreePath = join(project, 'worktrees', name);
    git(project, 'worktree', 'add', '-q', '-b', `pane-${name}`, worktreePath, 'origin/main');
    return partial<Session>({ id: name, worktreePath, baseBranch: 'origin/main', projectId: 1, archived: false, status: 'stopped' });
  });
  cleanups.push(async () => {
    for (const session of sessions) await stopFsmonitorDaemon(session.worktreePath ?? '', runner);
  });

  const ctx = { project: partial<Project>({ id: 1, path: project }), commandRunner: runner, pathResolver: new PathResolver({ path: project }) };
  const sessionManager = partial<SessionManager>({
    getSession: async (id: string) => sessions.find(session => session.id === id),
    getAllSessions: () => sessions,
    getProjectForSession: () => ctx.project,
    getProjectContext: () => ctx,
  });

  const lines: string[] = [];
  const record = (message: string) => { lines.push(message); };
  const logger = partial<Logger>({ info: record, warn: record, error: record, verbose: record, debug: () => undefined });
  const manager = new GitStatusManager(sessionManager, new WorktreeManager(), new GitDiffManager(), logger);
  const stopListening = onFetch(projectPath => { if (projectPath === project) void manager.refreshProjectAfterFetch(projectPath); });
  cleanups.push(() => { stopListening(); manager.stopPolling(); });

  const execFile = vi.spyOn(runner, 'execFile');
  const fetches = () => execFile.mock.calls.filter(([, args]) => args[0] === 'fetch');
  const advanceRemote = () => {
    git(other, 'commit', '-q', '--allow-empty', '-m', 'B');
    git(other, 'push', '-q', 'origin', 'main');
  };
  const behind = (id: string) => manager.getCachedStatus(id)?.status.behind ?? 0;
  const loadStatuses = () => Promise.all(sessions.map(session => manager.getGitStatus(session.id)));
  const logged = (text: string) => lines.some(line => line.includes(text));
  const tip = (ref: string) => git(project, 'rev-parse', ref);
  return { root, remote, project, sessions, manager, fetches, advanceRemote, behind, loadStatuses, logged, lines, tip };
}

describe('every fetch keeps the Panes in its project current', () => {
  it('updates every other Pane when an agent fetches inside the active Pane for the first time', async () => {
    const f = fixture();
    await f.loadStatuses();
    f.manager.setActiveSession('a');
    await vi.waitFor(() => expect(f.logged('Started file watching for session a')).toBe(true), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    f.advanceRemote();

    git(f.sessions[0].worktreePath ?? '', 'fetch', '-q', 'origin');

    await vi.waitFor(() => expect(f.behind('b')).toBe(1), { timeout: 10_000 });
    expect(f.fetches()).toHaveLength(0);
  }, 20_000);

  it('recomputes a Pane\'s whole status when a fetch moves it, so it is no longer ready to merge', async () => {
    const f = fixture();
    git(f.sessions[1].worktreePath ?? '', 'commit', '-q', '--allow-empty', '-m', 'work');
    await f.loadStatuses();
    expect(f.manager.getCachedStatus('b')?.status.isReadyToMerge).toBe(true);
    f.manager.setActiveSession('a');
    await vi.waitFor(() => expect(f.logged('Started file watching for session a')).toBe(true), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    f.advanceRemote();

    git(f.sessions[0].worktreePath ?? '', 'fetch', '-q', 'origin');

    await vi.waitFor(() => expect(f.behind('b')).toBe(1), { timeout: 10_000 });
    expect(f.manager.getCachedStatus('b')?.status.isReadyToMerge).toBe(false);
  }, 20_000);

  it('shows when the base branch was fetched, not when another branch was', async () => {
    const f = fixture();
    const fetchedAt = TEN_MINUTES_AGO();
    utimesSync(join(f.project, '.git', 'FETCH_HEAD'), fetchedAt, fetchedAt);
    git(f.sessions[0].worktreePath ?? '', 'fetch', '-q', 'origin', 'side');
    // A failed fetch leaves an empty FETCH_HEAD behind.
    writeFileSync(join(f.project, '.git', 'worktrees', 'b', 'FETCH_HEAD'), '');

    await f.loadStatuses();

    const shown = Date.parse(f.manager.getCachedStatus('a')?.status.lastFetchedAt ?? '');
    expect(Math.abs(shown - fetchedAt.getTime())).toBeLessThan(1_000);
  }, 20_000);

  it('counts a fetch from an SSH remote, which FETCH_HEAD names without its user', async () => {
    const f = fixture();
    git(f.project, 'remote', 'set-url', 'origin', 'git@example.invalid:team/repo.git');
    // What `git fetch origin main` writes for that remote: git drops `git@` and `.git`.
    writeFileSync(join(f.project, '.git', 'worktrees', 'a', 'FETCH_HEAD'), `${f.tip('origin/main')}\t\tbranch 'main' of example.invalid:team/repo\n`);

    await f.loadStatuses();

    const shown = Date.parse(f.manager.getCachedStatus('b')?.status.lastFetchedAt ?? '');
    expect(Date.now() - shown).toBeLessThan(10_000);
  }, 20_000);
});
