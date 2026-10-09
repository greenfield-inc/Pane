import { execFileSync, spawn } from 'child_process';
import { once } from 'events';
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, existsSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../../database/database';
import { ArchiveCleanupManager } from '../archiveCleanupManager';
import { ArchiveProgressManager } from '../archiveProgressManager';
import { CommandRunner } from '../../utils/commandRunner';
import { PathResolver } from '../../utils/pathResolver';
import { archiveFs, directoryIdentity, purgeArchiveBatch } from '../archiveCleanupFilesystem';
import { WorktreeManager } from '../worktreeManager';
import { withArchiveRepositoryLock } from '../archiveRepositoryLock';
import { worktreePoolManager } from '../worktreePoolManager';

const fixtures: Array<{ root: string; close: () => Promise<void> }> = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pane-durable-')));
  vi.stubEnv('PANE_DIR', path.join(root, 'data'));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
  const source = path.join(repo, 'worktrees', 'feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', source);
  writeFileSync(path.join(source, 'keep.txt'), 'original');
  const dbPath = path.join(root, 'sessions.db');
  let db = new DatabaseService(dbPath);
  db.initialize();
  const project = db.createProject('test', repo);
  const session = db.createSession({ id: 'pane-1', name: 'Pane 1', initial_prompt: '', worktree_name: 'feature', worktree_path: source, project_id: project.id });
  const runner = new CommandRunner(project);
  const sessions = {
    getProjectContextByProjectId: () => ({ project, commandRunner: runner, pathResolver: new PathResolver(project) }),
    runArchiveScript: vi.fn(async () => ({ success: true, output: '' })),
  };
  const progress = new ArchiveProgressManager();
  let manager = new ArchiveCleanupManager(db, sessions, progress);
  fixtures.push({ root, close: async () => { await manager.stop(); db.close(); } });
  return {
    root, repo, source, session, project, sessions, runner, progress,
    get db() { return db; }, get manager() { return manager; },
    restart() {
      manager.stop();
      db.close();
      db = new DatabaseService(dbPath);
      db.initialize();
      manager = new ArchiveCleanupManager(db, sessions, progress);
      manager.start();
    },
  };
}

async function settled(f: ReturnType<typeof fixture>, status: 'completed' | 'failed') {
  await vi.waitFor(() => expect(f.db.getArchiveCleanupJobs()[0]?.status).toBe(status), { timeout: 10000, interval: 20 });
  // Allow the scheduler's finally block to release its repository slot.
  await new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('durable archive cleanup', () => {
  it('queues pool background creation and orphan cleanup behind repository mutations', async () => {
    const f = fixture();
    const calls = vi.spyOn(f.runner, 'execFile');
    let release = () => {};
    let entered = () => {};
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const owner = withArchiveRepositoryLock(f.repo, f.runner, async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await enteredPromise;
    const pool = worktreePoolManager.createReserve(f.repo, 'HEAD', undefined, new PathResolver(f.project), f.runner);
    const cleanup = worktreePoolManager.cleanupOrphanedReserves(f.repo, f.runner);
    try {
      await vi.waitFor(() => expect(calls.mock.calls.filter(call => call[1][0] === 'rev-parse')).toHaveLength(3));
      expect(calls.mock.calls.some(call => call[1][0] === 'worktree')).toBe(false);
    } finally {
      release();
      await Promise.all([owner, pool, cleanup]);
    }
    expect(worktreePoolManager.hasReserve(f.repo, 'HEAD')).toBe(true);
    const mutations = calls.mock.calls.filter(call => call[1][0] === 'worktree').map(call => call[1][1]);
    // Canonical-repository lookups may complete in either order; FIFO begins
    // at admission. Both must wait for the owner, and neither removes the reserve.
    expect(mutations.sort()).toEqual(['add', 'list']);
  });

  it('fails closed after restart when an old intent has no process capture', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    job.processes = undefined;
    f.db.archiveSession(f.session.id, job);
    f.restart();
    await settled(f, 'failed');
    expect(f.db.getArchiveCleanupJobs()[0].error).toContain('Process capture is missing');
    expect(existsSync(f.source)).toBe(true);
  });

  it('captures before commit and terminates retained processes after a commit-before-enqueue crash', async () => {
    const f = fixture();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const exited = once(child, 'exit');
    await once(child, 'spawn');
    try {
      f.manager.setProcessRootsHandler(() => [child.pid!]);
      const job = await f.manager.prepare(f.session, true, false);
      expect(job.processes?.some(item => item.pid === child.pid)).toBe(true);
      f.db.archiveSession(f.session.id, job);
      // No enqueue/callback ran before the simulated crash. Restart has no PTYs.
      f.restart();
      await settled(f, 'completed');
      await exited;
      expect(existsSync(f.source)).toBe(false);
      expect(f.db.getArchiveCleanupJobs()[0].processes).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  }, 30000);

  it('leaves the repository mutation lock available while an archive script runs', async () => {
    const f = fixture();
    f.project.archive_script = 'held script';
    let release = () => {};
    f.sessions.runArchiveScript.mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ success: true, output: '' });
    }));
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    f.manager.enqueue(job, () => Promise.resolve());
    try {
      await vi.waitFor(() => expect(f.sessions.runArchiveScript).toHaveBeenCalled());
      await expect(withArchiveRepositoryLock(f.repo, f.runner, async () => 'available')).resolves.toBe('available');
      expect(f.progress.getActiveTasks()[0].status).toBe('running-archive-script');
    } finally {
      release();
    }
    await settled(f, 'completed');
  });

  it('yields during deep descent and resumes with a tiny batch budget', async () => {
    const f = fixture();
    const root = path.join(f.root, 'deep');
    let leaf = root;
    for (let i = 0; i < 80; i++) leaf = path.join(leaf, 'd');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(path.join(leaf, 'file'), 'data');
    const identity = await directoryIdentity(root);
    const cursor = { stack: [] };
    expect(await purgeArchiveBatch(root, identity!, cursor, 0)).toBe(false);
    expect(existsSync(leaf)).toBe(true);
    let batches = 1;
    while (!await purgeArchiveBatch(root, identity!, cursor, 0)) {
      if (++batches > 200) throw new Error('Deep traversal did not progress');
    }
    expect(batches).toBeGreaterThan(80);
    expect(existsSync(root)).toBe(false);
  });

  it('retains shutdown protection on preflight failure and redoes failed teardown on retry', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    job.status = 'failed';
    job.error = 'preflight failed';
    f.db.archiveSession(f.session.id, job);
    let reject = (_error: Error) => {};
    const teardown = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    f.manager.enqueue(job, teardown);
    await Promise.resolve();
    expect(f.progress.hasActiveTasks()).toBe(true);
    expect(f.progress.getActiveTasks()[0].status).toBe('pending');
    reject(new Error('still alive'));
    await settled(f, 'failed');
    expect(existsSync(f.source)).toBe(true);
    teardown.mockImplementation(async () => {});
    f.manager.retry(f.session.id, false);
    await settled(f, 'completed');
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it('repairs registration for an already missing source and tolerates absent artifacts', async () => {
    const f = fixture();
    rmSync(f.source, { recursive: true });
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    f.restart();
    await settled(f, 'completed');
    expect(git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('refs/heads/feature');
    expect(git(f.repo, 'branch', '--list', 'feature')).toContain('feature');
  });

  it('rechecks teardown when retrying a persisted failure after restart', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    job.status = 'failed';
    job.error = 'Terminal teardown failed';
    f.db.archiveSession(f.session.id, job);
    f.restart();
    const teardown = vi.fn(async () => { throw new Error('process still running'); });
    f.manager.setTeardownHandler(teardown);
    f.manager.retry(f.session.id, false);
    await settled(f, 'failed');
    expect(existsSync(f.source)).toBe(true);
    teardown.mockImplementation(async () => {});
    f.manager.retry(f.session.id, false);
    await settled(f, 'completed');
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it('repairs a source lost after intent capture without replaying its script', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    rmSync(f.source, { recursive: true });
    f.restart();
    await settled(f, 'completed');
    expect(f.sessions.runArchiveScript).not.toHaveBeenCalled();
    expect(git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain('refs/heads/feature');
  });

  it('rejects unsupported native paths before creating an archive intent', async () => {
    const f = fixture();
    await expect(f.manager.prepare({ ...f.session, worktree_path: f.repo }, true, false)).rejects.toThrow(/linked worktree/);
    expect(f.db.getSession(f.session.id)?.archived).toBeFalsy();
    expect(f.db.getArchiveCleanupJobs()).toEqual([]);
  });

  it('keeps WSL requests on the existing cleanup route', () => {
    const f = fixture();
    const context = f.sessions.getProjectContextByProjectId();
    vi.spyOn(f.sessions, 'getProjectContextByProjectId').mockReturnValue({
      ...context, pathResolver: new PathResolver({ ...f.project, wsl_enabled: true, wsl_distribution: 'Ubuntu' }),
    });
    expect(f.manager.supports(f.session)).toBe(false);
  });

  it('bounds completed history without evicting unresolved jobs', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    f.db.saveArchiveCleanupJob({ ...job, status: 'failed' });
    for (let i = 0; i < 30; i++) {
      f.db.saveArchiveCleanupJob({ ...job, sessionId: `done-${i}`, status: 'completed', endTime: new Date(i * 1000).toISOString() });
    }
    expect(f.db.getArchiveCleanupJobs()).toHaveLength(11);
    f.restart();
    expect(f.progress.getActiveTasks()).toHaveLength(11);
    expect(f.progress.getActiveTasks().find(task => task.sessionId === f.session.id)?.status).toBe('failed');
  });
  it('atomically rolls back archive when persisting intent fails', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    f.db.getDb().exec("CREATE TRIGGER reject_job BEFORE INSERT ON archive_cleanup_jobs BEGIN SELECT RAISE(ABORT, 'injected crash'); END");
    expect(() => f.db.archiveSession(f.session.id, job)).toThrow('injected crash');
    expect(f.db.getSession(f.session.id)?.archived).toBeFalsy();
    expect(f.db.getArchiveCleanupJobs()).toEqual([]);
    expect(existsSync(f.source)).toBe(true);
  });

  it('recovers SQLite atomicity after a process exits inside the enqueue transaction', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    const dependency = createRequire(__filename).resolve('better-sqlite3-multiple-ciphers');
    const child = `
      const Db = require(process.argv[1]);
      const db = new Db(process.argv[2]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run('pane-1');
      db.prepare('INSERT INTO archive_cleanup_jobs(session_id, job) VALUES (?, ?)').run('pane-1', process.argv[3]);
      if (process.argv[4] === 'commit') db.exec('COMMIT');
      process.exit(23);
    `;
    for (const stage of ['before-commit', 'commit']) {
      expect(() => execFileSync(process.execPath, ['-e', child, dependency, path.join(f.root, 'sessions.db'), JSON.stringify(job), stage])).toThrow();
      if (stage === 'before-commit') {
        expect(f.db.getSession(f.session.id)?.archived).toBeFalsy();
        expect(f.db.getArchiveCleanupJobs()).toEqual([]);
      }
    }
    f.restart();
    await settled(f, 'completed');
    expect(existsSync(f.source)).toBe(false);
  });

  it('recovers committed intent without an in-memory enqueue and preserves the branch', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    expect(f.db.archiveSession(f.session.id, job)).toBe(true);
    f.restart();
    await settled(f, 'completed');
    expect(existsSync(f.source)).toBe(false);
    expect(existsSync(job.quarantine)).toBe(false);
    expect(git(f.repo, 'branch', '--list', 'feature')).toContain('feature');
    expect(f.progress.getActiveTasks()[0]).toMatchObject({ status: 'completed', trashDeletion: 'done' });
  });

  it('never imports old archived sessions as removal intent', async () => {
    const f = fixture();
    f.db.archiveSession(f.session.id);
    f.restart();
    expect(f.db.getArchiveCleanupJobs()).toEqual([]);
    expect(existsSync(path.join(f.source, 'keep.txt'))).toBe(true);
  });

  it('does not remove an external worktree without explicit permission', async () => {
    const f = fixture();
    const job = await f.manager.prepare({ ...f.session, worktree_ownership: 'external' }, false, false);
    f.db.archiveSession(f.session.id, job);
    f.restart();
    await settled(f, 'completed');
    expect(existsSync(path.join(f.source, 'keep.txt'))).toBe(true);
    expect(f.db.getArchiveCleanupJobs()[0].externalRemovalApproved).toBe(false);
  });

  it('lets another repository complete while a busy job waits for its next attempt', async () => {
    const f = fixture();
    const otherRepo = path.join(f.root, 'other-repo');
    mkdirSync(otherRepo);
    git(otherRepo, 'init', '-q');
    git(otherRepo, '-c', 'user.name=Pane', '-c', 'user.email=pane@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
    const otherSource = path.join(f.root, 'other-worktree');
    git(otherRepo, 'worktree', 'add', '-q', '-b', 'other', otherSource);
    const otherProject = f.db.createProject('other', otherRepo);
    const otherSession = f.db.createSession({ id: 'pane-2', name: 'Pane 2', initial_prompt: '', worktree_name: 'other', worktree_path: otherSource, project_id: otherProject.id });
    const originalContext = f.sessions.getProjectContextByProjectId();
    vi.spyOn(f.sessions, 'getProjectContextByProjectId').mockImplementation((...args: unknown[]) => args[0] === otherProject.id
      ? { project: otherProject, commandRunner: new CommandRunner(otherProject), pathResolver: new PathResolver(otherProject) }
      : originalContext);
    const first = await f.manager.prepare(f.session, true, false);
    const second = await f.manager.prepare(otherSession, true, false);
    f.db.archiveSession(f.session.id, first);
    f.db.archiveSession(otherSession.id, second);
    const realRename = archiveFs.rename.bind(archiveFs);
    const rename = vi.spyOn(archiveFs, 'rename').mockImplementation((from, to) => from === f.source
      ? Promise.reject(Object.assign(new Error('busy repository'), { code: 'EBUSY' })) : realRename(from, to));
    f.manager.enqueue(first, () => Promise.resolve());
    f.manager.enqueue(second, () => Promise.resolve());
    await vi.waitFor(() => expect(f.db.getArchiveCleanupJobs().find(job => job.sessionId === otherSession.id)?.status).toBe('completed'), { timeout: 4000 });
    expect(f.db.getArchiveCleanupJobs().find(job => job.sessionId === f.session.id)?.status).toBe('queued');
    expect(existsSync(f.source)).toBe(true);
    rename.mockRestore();
    await settled(f, 'completed');
  });

  it('reconciles a crash after rename and before its checkpoint', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    job.phase = 'detach';
    job.scriptFinished = true;
    job.status = 'running';
    f.db.archiveSession(f.session.id, job);
    mkdirSync(path.dirname(job.quarantine), { recursive: true });
    renameSync(job.source, job.quarantine);
    f.restart();
    await settled(f, 'completed');
    expect(existsSync(job.quarantine)).toBe(false);
    expect(git(f.repo, 'worktree', 'list', '--porcelain')).not.toContain(f.source.replaceAll('\\', '/'));
  });

  it('refuses a replacement source and retains the failure across restart', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    renameSync(f.source, `${f.source}-original`);
    mkdirSync(f.source);
    writeFileSync(path.join(f.source, 'replacement.txt'), 'keep');
    f.restart();
    await settled(f, 'failed');
    expect(f.db.getArchiveCleanupJobs()[0].error).toMatch(/identity changed/);
    f.restart();
    expect(f.progress.getActiveTasks()[0].error).toMatch(/identity changed/);
    expect(existsSync(path.join(f.source, 'replacement.txt'))).toBe(true);
    expect(() => f.manager.assertRestorable(f.session.id)).toThrow(/Retry cleanup/);
  });

  it('blocks interrupted scripts and requires explicit skip on retry', async () => {
    const f = fixture();
    f.project.archive_script = 'must not replay';
    const job = await f.manager.prepare(f.session, true, false);
    job.scriptStarted = true;
    job.status = 'running';
    f.db.archiveSession(f.session.id, job);
    f.restart();
    await settled(f, 'failed');
    expect(f.sessions.runArchiveScript).not.toHaveBeenCalled();
    expect(() => f.manager.retry(f.session.id, false)).toThrow(/explicitly skip/);
    f.manager.retry(f.session.id, true);
    await settled(f, 'completed');
    expect(f.sessions.runArchiveScript).not.toHaveBeenCalled();
  });

  it('keeps intent after deleting archive history and rejects duplicate enqueue', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    expect(() => f.db.archiveSession(f.session.id, job)).toThrow(/already pending/);
    f.db.getDb().prepare('DELETE FROM sessions WHERE id = ?').run(f.session.id);
    f.restart();
    await settled(f, 'completed');
    expect(existsSync(f.source)).toBe(false);
  });

  it('reserves the path against creation while teardown or cleanup remains pending', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    let release = () => {};
    const teardown = new Promise<void>(resolve => { release = resolve; });
    f.manager.enqueue(job, () => teardown);
    const worktrees = new WorktreeManager();
    worktrees.setArchivePathGuard(target => f.manager.assertPathAvailable(target));
    await expect(worktrees.createWorktree(f.repo, 'feature', undefined, undefined, undefined, new PathResolver(f.project), f.runner)).rejects.toThrow(/reserved/);
    await expect(worktrees.resolveWorkingDirectory(f.repo, 'feature', undefined, true, undefined, new PathResolver(f.project), f.runner)).rejects.toThrow(/reserved/);
    await expect(f.manager.assertPathAvailable(path.join(f.source, 'nested'))).rejects.toThrow(/reserved/);
    expect(() => f.manager.assertRestorable(f.session.id)).toThrow();
    expect(existsSync(path.join(f.source, 'keep.txt'))).toBe(true);
    release();
    await settled(f, 'completed');
    expect(() => f.manager.assertRestorable(f.session.id)).not.toThrow();
  });

  it('retries busy detach at job level, with a finite budget and an independent manual retry', async () => {
    const f = fixture();
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    const rename = vi.spyOn(archiveFs, 'rename').mockRejectedValue(Object.assign(new Error('sharing lock'), { code: 'EBUSY' }));
    f.manager.enqueue(job, () => Promise.resolve());
    await settled(f, 'failed');
    expect(rename).toHaveBeenCalledTimes(3);
    expect(existsSync(path.join(f.source, 'keep.txt'))).toBe(true);
    rename.mockRestore();
    f.manager.retry(f.session.id, false);
    await settled(f, 'completed');
    expect(f.db.getArchiveCleanupJobs()[0].attempts).toBe(0);
  }, 15000);

  it('never traverses a junction from quarantine into another directory', async () => {
    const f = fixture();
    const outside = path.join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    await archiveFs.symlink(outside, path.join(f.source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const job = await f.manager.prepare(f.session, true, false);
    f.db.archiveSession(f.session.id, job);
    f.manager.enqueue(job, () => Promise.resolve());
    await settled(f, 'completed');
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  });

  it('makes bounded deletion progress on large physical trees and treats .asar as a file', async () => {
    const f = fixture();
    const tree = path.join(f.root, 'purge');
    mkdirSync(tree);
    for (let i = 0; i < 600; i++) writeFileSync(path.join(tree, `${i}.asar`), 'physical bytes');
    const identity = await directoryIdentity(tree);
    expect(identity).toBeDefined();
    expect(await purgeArchiveBatch(tree, identity!)).toBe(false);
    let batches = 1;
    while (!await purgeArchiveBatch(tree, identity!)) batches++;
    expect(batches).toBeGreaterThan(1);
    expect(existsSync(tree)).toBe(false);
  });
});
