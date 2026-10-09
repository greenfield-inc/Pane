import { randomUUID } from 'crypto';
import path from 'path';
import type { ArchiveCleanupJob } from '../database/archiveCleanup';
import type { DatabaseService } from '../database/database';
import type { Session } from '../database/models';
import type { SessionManager } from './sessionManager';
import type { ArchiveProgressManager } from './archiveProgressManager';
import type { ArchiveProgressTask } from '../../../shared/types/archiveProgress';
import { classifyWorktree } from './worktreeTrash';
import { stopFsmonitorDaemon } from './gitPerformanceConfig';
import { detectProjectConfig } from './projectConfigDetector';
import { archiveFs, archiveErrorCode, archivePathKey, directoryIdentity, purgeArchiveBatch, type ArchivePurgeCursor } from './archiveCleanupFilesystem';
import { getAppSubdirectory } from '../utils/appDirectory';
import { withArchiveRepositoryKey } from './archiveRepositoryLock';
import { ArchiveProcessTracker } from './archiveProcessTracker';

type CleanupStore = Pick<DatabaseService, 'getArchiveCleanupJobs' | 'saveArchiveCleanupJob' | 'getSession'>;
type CleanupSessions = Pick<SessionManager, 'getProjectContextByProjectId' | 'runArchiveScript'>;

/** Explicit intents only. There is deliberately no scan of archived sessions. */
export class ArchiveCleanupManager {
  private jobs = new Map<string, ArchiveCleanupJob>();
  private active = new Set<string>();
  private repositories = new Set<string>();
  private waitingForTeardown = new Set<string>();
  private inFlight = new Set<Promise<void>>();
  private teardownCallbacks = new Map<string, (tracker: ArchiveProcessTracker) => Promise<void>>();
  private teardownSession?: (sessionId: string, tracker: ArchiveProcessTracker) => Promise<void>;
  private processRoots: (sessionId: string) => number[] = () => [];
  private purgeCursors = new Map<string, ArchivePurgeCursor>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private db: CleanupStore, private sessions: CleanupSessions, private progress: ArchiveProgressManager) {
    for (const job of db.getArchiveCleanupJobs()) this.jobs.set(job.sessionId, job);
    progress.setDurableTasks(() => this.getTasks());
  }

  supports(session: Session): boolean {
    const context = session.project_id ? this.sessions.getProjectContextByProjectId(session.project_id) : null;
    return context?.pathResolver.environment !== 'wsl' && !context?.commandRunner.wslContext;
  }

  setTeardownHandler(handler: (sessionId: string, tracker: ArchiveProcessTracker) => Promise<void>): void {
    this.teardownSession = handler;
  }

  setProcessRootsHandler(handler: (sessionId: string) => number[]): void {
    this.processRoots = handler;
  }

  async prepare(session: Session, removeWorktree: boolean, externalRemovalApproved: boolean): Promise<ArchiveCleanupJob> {
    const job = await this.preparePath(session, removeWorktree, externalRemovalApproved);
    // Capture before the atomic archive/intent commit. A capture failure leaves
    // the session active; a crash after commit retains the known process tree.
    job.processes = [];
    await new ArchiveProcessTracker([], identities => { job.processes = identities; })
      .capture(this.processRoots(session.id));
    return job;
  }

  private async preparePath(session: Session, removeWorktree: boolean, externalRemovalApproved: boolean): Promise<ArchiveCleanupJob> {
    const context = session.project_id ? this.sessions.getProjectContextByProjectId(session.project_id) : null;
    const id = randomUUID();
    const job: ArchiveCleanupJob = {
      id, sessionId: session.id, sessionName: session.name, worktreeName: session.worktree_name || '',
      projectName: context?.project.name ?? '', projectId: session.project_id ?? undefined,
      projectPath: context?.project.path ?? '', source: session.worktree_path || '',
      repository: `artifacts:${session.id}`, quarantine: '', gitDirectory: '', identity: '',
      removeWorktree, externalRemovalApproved, status: 'queued', phase: 'script',
      scriptStarted: false, scriptFinished: false, attempts: 0, nextAttempt: 0,
      startTime: new Date().toISOString(), endTime: undefined, error: undefined, processes: undefined,
    };
    if (!removeWorktree) return job;
    try {
      if (!context) throw new Error('Project is unavailable; cleanup needs its original project');
      if (context.pathResolver.environment === 'wsl' || context.commandRunner.wslContext) {
        throw new Error('Automatic durable cleanup is unavailable for WSL paths; the archived worktree is preserved');
      }
      if (session.is_main_repo) throw new Error('Cannot clean up a main checkout');
      if (session.worktree_ownership === 'external' && !externalRemovalApproved) throw new Error('External worktree removal was not approved');
      const identity = await directoryIdentity(job.source);
      if (identity === undefined) {
        const { stdout } = await context.commandRunner.execFile('git', ['rev-parse', '--git-common-dir'], job.projectPath, { silent: true, timeout: 30000 });
        job.repository = await archiveFs.realpath(path.resolve(job.projectPath, stdout.trim()));
        job.quarantine = path.join(job.repository, 'pane-archive-cleanup', id);
        job.phase = 'detach';
        job.scriptFinished = true;
        return job;
      }
      job.source = await archiveFs.realpath(job.source);
      job.identity = identity;
      const classification = await classifyWorktree(job.source, job.projectPath, context.commandRunner);
      if (classification.kind !== 'linked') throw new Error(`Expected a linked worktree; found ${classification.kind}`);
      job.repository = classification.commonDirectory;
      job.gitDirectory = classification.gitDirectory;
      // Separate from legacy pane-trash, whose opportunistic sweeper must not
      // race a durable job or erase its crash-reconciliation evidence.
      job.quarantine = path.join(job.repository, 'pane-archive-cleanup', id);
      await this.checkGitIdentity(job);
    } catch (error) {
      // Unsupported/foreign paths never become archived intents that trap
      // Restore. No teardown or filesystem mutation has begun at this point.
      if (!job.identity || !job.quarantine) throw error;
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.endTime = new Date().toISOString();
    }
    return job;
  }

  /** Called immediately after the atomic archive/intent commit, before awaiting teardown. */
  enqueue(job: ArchiveCleanupJob, teardown: (tracker: ArchiveProcessTracker) => Promise<void>): void {
    this.jobs.set(job.sessionId, job);
    this.teardownCallbacks.set(job.sessionId, teardown);
    this.waitingForTeardown.add(job.sessionId);
    this.publish();
    const tracker = new ArchiveProcessTracker([...(job.processes ?? [])], identities => {
      job.processes = identities;
      this.save(job);
    });
    const pending = Promise.resolve().then(async () => {
      if (job.processes === undefined) throw new Error('Process capture is missing; automatic cleanup cannot verify pre-crash processes');
      await teardown(tracker);
      await tracker.terminateSurvivors();
      await tracker.verifyExited();
    });
    const waiting = pending.then(() => {
      this.waitingForTeardown.delete(job.sessionId);
      this.publish();
      this.schedule();
    }, error => {
      this.waitingForTeardown.delete(job.sessionId);
      this.fail(job, new Error(`Terminal teardown failed: ${String(error)}`));
    }).finally(() => this.inFlight.delete(waiting));
    this.inFlight.add(waiting);
  }

  start(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'completed' || job.status === 'failed') continue;
      if (job.scriptStarted && !job.scriptFinished) {
        this.fail(job, new Error('Archive script was interrupted. Retry cleanup explicitly skips the interrupted script.'));
      } else {
        job.status = 'queued';
        this.save(job);
        this.enqueue(job, tracker => this.teardownSession?.(job.sessionId, tracker) ?? Promise.resolve());
      }
    }
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.all(this.inFlight);
  }

  retry(sessionId: string, skipInterruptedScript: boolean): void {
    const job = this.jobs.get(sessionId);
    if (!job || job.status !== 'failed' || this.active.has(sessionId) || this.waitingForTeardown.has(sessionId)) {
      throw new Error('Cleanup is not ready to retry');
    }
    if (job.scriptStarted && !job.scriptFinished) {
      if (!skipInterruptedScript) throw new Error('Retry must explicitly skip the interrupted archive script');
      job.scriptFinished = true;
      job.phase = 'detach';
    }
    job.status = 'queued';
    job.attempts = 0;
    job.nextAttempt = 0;
    job.endTime = undefined;
    this.save(job);
    const teardown = this.teardownCallbacks.get(sessionId)
      ?? (this.teardownSession ? (tracker: ArchiveProcessTracker) => this.teardownSession!(sessionId, tracker) : undefined);
    if (teardown) this.enqueue(job, teardown);
    else this.enqueue(job, async () => {});
  }

  assertRestorable(sessionId: string): void {
    const job = this.jobs.get(sessionId);
    if (job && (job.status !== 'completed' || this.active.has(sessionId))) {
      throw new Error('Finish archive cleanup using Retry cleanup before restoring this pane');
    }
  }

  async assertPathAvailable(target: string): Promise<void> {
    const parent = await archiveFs.realpath(path.dirname(target)).catch(() => path.dirname(target));
    const key = archivePathKey(path.join(parent, path.basename(target)));
    for (const job of this.jobs.values()) {
      const source = archivePathKey(job.source);
      if (job.removeWorktree && job.status !== 'completed'
        && (key === source || key.startsWith(`${source}${path.sep}`) || source.startsWith(`${key}${path.sep}`))) {
        throw new Error('This worktree path is reserved by unfinished archive cleanup');
      }
    }
  }

  getTasks(): ArchiveProgressTask[] {
    const jobs = [...this.jobs.values()];
    const recentCompleted = jobs.filter(job => job.status === 'completed').slice(-10);
    return [...jobs.filter(job => job.status !== 'completed'), ...recentCompleted].map(job => ({
      sessionId: job.sessionId, sessionName: job.sessionName, worktreeName: job.worktreeName, projectName: job.projectName,
      status: this.waitingForTeardown.has(job.sessionId) ? 'pending' : job.status === 'running'
        ? job.phase === 'script' ? 'running-archive-script' : job.phase === 'artifacts' ? 'cleaning-artifacts' : 'removing-worktree'
        : job.status,
      startTime: job.startTime, endTime: job.endTime, error: job.error,
      trashDeletion: job.phase === 'purge' ? 'pending' : job.status === 'completed' ? 'done' : undefined,
      cleanupId: job.id, attempts: job.attempts, nextAttempt: job.nextAttempt || undefined,
      remainingPath: job.phase === 'purge' ? job.quarantine : job.source,
      interruptedScript: job.scriptStarted && !job.scriptFinished,
    }));
  }

  private save(job: ArchiveCleanupJob): void {
    this.db.saveArchiveCleanupJob(job);
    if (job.status === 'completed') {
      this.teardownCallbacks.delete(job.sessionId);
      this.purgeCursors.delete(job.id);
      const completed = [...this.jobs.values()].filter(item => item.status === 'completed')
        .sort((a, b) => (b.endTime ?? '').localeCompare(a.endTime ?? ''));
      for (const old of completed.slice(10)) this.jobs.delete(old.sessionId);
    }
    this.publish();
  }

  private publish(): void { this.progress.publishDurableTasks(); }

  private fail(job: ArchiveCleanupJob, cause: unknown): void {
    this.purgeCursors.delete(job.id);
    job.status = 'failed';
    job.error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2000);
    job.endTime = new Date().toISOString();
    this.save(job);
  }

  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    // Moving each dispatched job to the end gives other jobs/repositories a
    // turn between purge batches and retries. At most one job per repository.
    for (const job of [...this.jobs.values()]) {
      if (this.active.size >= 2) break;
      const key = archivePathKey(job.repository);
      if (job.status !== 'queued' || this.waitingForTeardown.has(job.sessionId)
        || this.repositories.has(key) || job.nextAttempt > Date.now()) continue;
      this.jobs.delete(job.sessionId);
      this.jobs.set(job.sessionId, job);
      this.active.add(job.sessionId);
      this.repositories.add(key);
      const execution = this.run(job).catch(error => this.fail(job, error)).finally(() => {
        this.active.delete(job.sessionId);
        this.repositories.delete(key);
        this.inFlight.delete(execution);
        this.schedule();
      });
      this.inFlight.add(execution);
    }
    if ([...this.jobs.values()].some(job => job.status === 'queued')) {
      this.timer = setTimeout(() => this.schedule(), 100);
      this.timer.unref();
    }
  }

  private async checkGitIdentity(job: ArchiveCleanupJob): Promise<void> {
    const context = job.projectId ? this.sessions.getProjectContextByProjectId(job.projectId) : null;
    if (!context || context.project.path !== job.projectPath) throw new Error('Cleanup project identity changed');
    const classification = await classifyWorktree(job.source, job.projectPath, context.commandRunner);
    if (classification.kind !== 'linked' || archivePathKey(classification.gitDirectory) !== archivePathKey(job.gitDirectory)
      || archivePathKey(classification.commonDirectory) !== archivePathKey(job.repository)) throw new Error('Worktree Git identity changed');
    try {
      await archiveFs.access(path.join(job.gitDirectory, 'locked'));
    } catch (error) {
      if (archiveErrorCode(error) === 'ENOENT') return;
      throw error;
    }
    throw new Error('Worktree is locked; unlock it before retrying cleanup');
  }

  private async run(job: ArchiveCleanupJob): Promise<void> {
    job.status = 'running';
    this.save(job);
    try {
      if (job.phase === 'script') {
        if (job.removeWorktree && await directoryIdentity(job.source) !== undefined) {
          if (!job.identity || !job.quarantine) throw new Error(job.error ?? 'Worktree identity could not be captured; cleanup is blocked');
          if (await directoryIdentity(job.source) !== job.identity) throw new Error('Worktree directory identity changed');
          await this.checkGitIdentity(job);
          const context = job.projectId ? this.sessions.getProjectContextByProjectId(job.projectId) : null;
          if (!context) throw new Error('Cleanup project is unavailable');
          const detected = context.project.archive_script ? null
            : await detectProjectConfig(job.source, context.pathResolver.environment, context.commandRunner);
          const script = context.project.archive_script || detected?.archive;
          if (script && !job.scriptFinished) {
            // Persist before executing arbitrary user code. Recovery never
            // guesses whether that code ran, nor automatically replays it.
            job.scriptStarted = true;
            this.save(job);
            const result = await this.sessions.runArchiveScript(job.sessionId, script.split('\n').filter(line => line.trim()), job.source, context.commandRunner);
            job.scriptFinished = true;
            this.save(job);
            if (!result.success) throw new Error('Archive script failed; Retry cleanup continues without rerunning it');
          }
        }
        job.scriptFinished = true;
        job.phase = job.removeWorktree ? 'detach' : 'artifacts';
        this.save(job);
      }
      if (job.phase === 'detach') {
        await withArchiveRepositoryKey(job.repository, () => this.detach(job));
        job.phase = 'purge';
        this.save(job);
      }
      if (job.phase === 'purge') {
        const cursor = this.purgeCursors.get(job.id) ?? { stack: [] };
        this.purgeCursors.set(job.id, cursor);
        if (!await purgeArchiveBatch(job.quarantine, job.identity, cursor)) {
          job.status = 'queued';
          this.save(job);
          return;
        }
        job.phase = 'artifacts';
        this.purgeCursors.delete(job.id);
        this.save(job);
      }
      if (job.phase === 'artifacts') {
        const artifacts = getAppSubdirectory('artifacts', job.sessionId);
        const identity = await directoryIdentity(artifacts);
        const cursor = this.purgeCursors.get(job.id) ?? { stack: [] };
        this.purgeCursors.set(job.id, cursor);
        if (identity && !await purgeArchiveBatch(artifacts, identity, cursor)) {
          job.status = 'queued';
          this.save(job);
          return;
        }
        for (const subdir of ['images', 'files']) {
          const directory = getAppSubdirectory(subdir);
          const entries = await archiveFs.readdir(directory).catch((cause: unknown) => {
            if (archiveErrorCode(cause) === 'ENOENT') return [];
            throw cause;
          });
          for (const entry of entries.filter(name => name.startsWith(`${job.sessionId}_`))) {
            await archiveFs.unlink(path.join(directory, entry));
          }
        }
        job.status = 'completed';
        job.endTime = new Date().toISOString();
        job.error = undefined;
        this.save(job);
      }
    } catch (error) {
      job.attempts++;
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(archiveErrorCode(error) ?? '') && job.attempts < 3) {
        job.status = 'queued';
        job.nextAttempt = Date.now() + job.attempts * 2000;
        job.error = error instanceof Error ? error.message : String(error);
        this.save(job);
      } else this.fail(job, error);
    }
  }

  private async detach(job: ArchiveCleanupJob): Promise<void> {
    const source = await directoryIdentity(job.source);
    const quarantine = await directoryIdentity(job.quarantine);
    if (source !== undefined && quarantine !== undefined) throw new Error('Both source and quarantine exist; cleanup requires inspection');
    if (source !== undefined) {
      if (source !== job.identity) throw new Error('Worktree directory identity changed; refusing to delete a replacement');
      await this.checkGitIdentity(job);
      const context = job.projectId ? this.sessions.getProjectContextByProjectId(job.projectId) : null;
      if (!context) throw new Error('Cleanup project is unavailable');
      await stopFsmonitorDaemon(job.source, context.commandRunner);
      await archiveFs.mkdir(path.dirname(job.quarantine), { recursive: true });
      if (archivePathKey(await archiveFs.realpath(path.dirname(job.quarantine))) !== archivePathKey(path.dirname(job.quarantine))) {
        throw new Error('Cleanup quarantine parent is redirected');
      }
      if (await directoryIdentity(job.source) !== job.identity) throw new Error('Worktree identity changed before detach');
      await archiveFs.rename(job.source, job.quarantine);
    } else if (quarantine !== undefined && quarantine !== job.identity) {
      throw new Error('Quarantine directory identity changed');
    }
    const context = job.projectId ? this.sessions.getProjectContextByProjectId(job.projectId) : null;
    if (!context || context.project.path !== job.projectPath) throw new Error('Cleanup project is unavailable or changed');
    await context.commandRunner.execFile('git', ['worktree', 'prune'], job.projectPath, { silent: true, timeout: 30000 });
    const { stdout } = await context.commandRunner.execFile('git', ['worktree', 'list', '--porcelain', '-z'], job.projectPath, { silent: true, timeout: 30000 });
    if (stdout.split('\0').some(line => line.startsWith('worktree ')
      && archivePathKey(line.slice(9)) === archivePathKey(job.source))) {
      throw new Error('Git still registers the missing worktree; check whether its registration is locked before retrying');
    }
  }
}
