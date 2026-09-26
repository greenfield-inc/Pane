import { HOME_GIT_SCAN_WARNING, isHomeDirectory } from '../utils/gitScanSafety';
import { EventEmitter } from 'events';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import path from 'path';
import type { Stats } from 'fs';
// node:fs recursive watcher — aliased so it doesn't collide with chokidar's
// imported `watch`/`FSWatcher`. Used for the darwin/win32 native path.
import { watch as fsWatch, type FSWatcher as NodeFsWatcher, type WatchEventType } from 'node:fs';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { spawn, type ChildProcess } from 'child_process';
import { commandExecutor } from '../utils/commandExecutor';
import type { CommandRunner } from '../utils/commandRunner';
import type { PathResolver } from '../utils/pathResolver';
import type { Logger } from '../utils/logger';

// Directories that are effectively never tracked in git and are
// expensive to watch (node_modules alone can be tens of thousands of
// subdirectories). Dirs that are SOMETIMES tracked (dist, build,
// target, coverage) are intentionally excluded from this list so that
// repos that commit build output still get accurate status refreshes.
const IGNORED_DIRS = new Set<string>([
  'node_modules',
  '.git', // narrow .git watcher is separate
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.svelte-kit',
]);

const IGNORED_FILE_PATTERNS: RegExp[] = [
  /^\.DS_Store$/,
  /^thumbs\.db$/i,
  /\.swp$/,
  /\.swo$/,
  /~$/,
  /^\.#/,
  /^#.+#$/,
];

// The four ways a session's worktree can be watched. `native` is the
// zero-dependency recursive fs.watch (darwin/win32-non-WSL); `chokidar`
// is the Linux per-directory path; `wsl` is the in-distro inotifywait
// process; `polling` is the degraded 5s snapshot-diff fallback.
type WatchMode = 'native' | 'chokidar' | 'wsl' | 'polling';

interface WatchedSession {
  sessionId: string;
  worktreePath: string;
  mode: WatchMode;
  worktreeWatcher?: FSWatcher; // chokidar (linux)
  gitWatcher?: FSWatcher; // chokidar narrow metadata watcher (all non-WSL modes)
  nativeWatcher?: NodeFsWatcher; // node:fs recursive FSWatcher (darwin/win32)
  wslWatcher?: ChildProcess;
  pollTimer?: NodeJS.Timeout; // 5s snapshot-diff loop (polling mode)
  selfHealTimer?: NodeJS.Timeout; // 60s snapshot-diff (native/chokidar modes)
  lastStatusSnapshot?: string; // last `git status --porcelain` output
  watcherErrorLogged: boolean; // rate-limits the fallback warn
  nonFatalErrorLogged?: boolean; // rate-limits log-only watcher errors (separate from the degrade warn)
  lastModified: number;
  pendingRefresh: boolean;
  pollInFlight?: boolean;
}

interface GitFileWatcherStats {
  totalWatched: number;
  sessionsNeedingRefresh: number;
}

/**
 * Smart file watcher that detects when git status actually needs refreshing
 *
 * Key optimizations:
 * 1. Uses chokidar with function-form ignored for efficient file monitoring
 * 2. Short-circuits descent into heavy directories (node_modules, dist, etc.)
 * 3. Batches rapid file changes
 */
export class GitFileWatcher extends EventEmitter {
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private pendingStarts = new Map<string, symbol>();
  private gitignoreRequests = new Map<string, Promise<Set<string>>>();
  private refreshDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 1500; // 1.5 second debounce for file changes

  // Gitignore-derived ignored-dir set, cached per watchPath on the INSTANCE
  // (not per WatchedSession) so it survives blur/focus teardown-rebuild churn
  // and pane switches without re-running a full `git ls-files` working-tree scan.
  private gitignoreDirCache: Map<string, { dirs: Set<string>; fetchedAt: number }> = new Map();
  private static readonly GITIGNORE_CACHE_TTL_MS = 5 * 60_000;
  private static readonly POLL_INTERVAL_MS = 5_000;
  private static readonly SELF_HEAL_INTERVAL_MS = 60_000;

  constructor(
    private logger?: Logger,
    private commandRunner?: CommandRunner,
    private pathResolver?: PathResolver
  ) {
    super();
    this.setMaxListeners(100);
  }

  setExecutionContext(commandRunner?: CommandRunner, pathResolver?: PathResolver): void {
    this.commandRunner = commandRunner;
    this.pathResolver = pathResolver;
  }

  /**
   * Start watching a session's worktree for changes
   */
  async startWatching(sessionId: string, worktreePath: string): Promise<void> {
    // Stop existing watcher if any
    this.stopWatching(sessionId);

    if (isHomeDirectory(worktreePath)) {
      this.logger?.warn(`[GitFileWatcher] ${HOME_GIT_SCAN_WARNING}`);
      return;
    }

    let metadataWatcher: FSWatcher | undefined;
    const start = Symbol(sessionId);
    this.pendingStarts.set(sessionId, start);
    try {
      if (this.commandRunner?.wslContext) {
        if (this.startWSLNativeWatcher(sessionId, worktreePath)) {
          return;
        }
      }

      // Convert path for the watcher (needs platform-appropriate path)
      const watchPath = this.pathResolver ? this.pathResolver.toFileSystem(worktreePath) : worktreePath;

      // Native recursive fs.watch on darwin/win32 (non-WSL). One O(1) recursive
      // handle instead of chokidar's one-handle-per-directory registration walk,
      // so a huge repo root no longer EMFILEs. win32+WSL already took the WSL
      // branch above; recursive fs.watch is fully supported on darwin (FSEvents)
      // and win32 (ReadDirectoryChangesW) in this Node runtime.
      const useNative =
        (process.platform === 'darwin' || process.platform === 'win32') &&
        !this.commandRunner?.wslContext;
      const gitignoredDirs = await this.getGitignoredDirs(watchPath);
      if (this.pendingStarts.get(sessionId) !== start) return;
      const gitWatcher = await this.createGitMetadataWatcher(sessionId, watchPath);
      metadataWatcher = gitWatcher;
      if (this.pendingStarts.get(sessionId) !== start) {
        return;
      }
      if (useNative) {
        let nativeWatcher: NodeFsWatcher;
        try {
          // default (utf8) encoding → Node types filename as string | null (never Buffer)
          nativeWatcher = fsWatch(
            watchPath,
            { recursive: true, persistent: true },
            (_eventType: WatchEventType, filename: string | null) => {
              void this.getGitignoredDirs(watchPath);
              // null filename → conservative: cannot filter, treat as a change.
              // Re-read the (cache-hit) gitignore set each event so the TTL
              // refresh takes effect on long-lived spotlight watchers.
              if (
                filename !== null &&
                this.isIgnoredEventPath(filename, gitignoredDirs)
              ) {
                return;
              }
              this.handleFileChange(sessionId, filename ?? '', 'change');
            },
          );
        } catch (err) {
          // ENOENT means the worktree was deleted out from under the session —
          // polling it would be a silent no-op loop, so log and give up (the
          // pre-native behavior). Everything else (EMFILE/ENOSPC-style handle
          // exhaustion) degrades to polling before any record exists.
          const normalizedError = err instanceof Error ? err : new Error(String(err));
          const code = decodeBoundary(err, boundary.object({ code: boundary.optional(boundary.string) })).code;
          if (code === 'ENOENT') {
            this.logger?.error(
              `[GitFileWatcher] Failed to start watching session ${sessionId} (worktree missing):`,
              normalizedError,
            );
            return;
          }
          await this.transitionToPolling(sessionId, worktreePath, normalizedError);
          return;
        }
        nativeWatcher.on('error', (err) => this.handleWatcherFailure(sessionId, err));
        this.watchedSessions.set(sessionId, {
          sessionId,
          worktreePath,
          mode: 'native',
          nativeWatcher,
          gitWatcher,
          selfHealTimer: this.startSelfHeal(sessionId),
          watcherErrorLogged: false,
          lastModified: Date.now(),
          pendingRefresh: false,
        });

        // Seed the self-heal snapshot baseline off the activation critical path.
        // Without a baseline, the first 60s tick after a MISSED event would only
        // record the already-dirty snapshot without emitting, leaving status
        // stale until the next real change. (pollStatusSnapshot no-ops if the
        // session was torn down before this runs.)
        setImmediate(() => { void this.pollStatusSnapshot(sessionId); });

        // Validation signal — keep in production: confirms watcher count is bounded
        this.logger?.info(
          `[GitFileWatcher] startWatching(${sessionId}) watchedSessions.size=${this.watchedSessions.size}`
        );
        return;
      }

      // Linux: chokidar per-directory watcher. Union ignore (hardcoded ∪
      // gitignore-derived) is threaded into the registration-time `ignored` fn
      // so it both prunes descent (handle budget) AND matches the native
      // event-time filter, keeping behavior uniform across platforms.
      // Function-form ignored: short-circuits descent into heavy directories.
      // stats may be undefined on initial calls — return false (don't ignore)
      // if unknown. Unlike event-time callers, stats IS available here, so
      // dir-vs-file is passed through and IGNORED_FILE_PATTERNS never prunes
      // a directory whose name merely looks like a temp file (e.g. `backup~`).
      const ignored = (targetPath: string, stats?: Stats): boolean => {
        if (!stats) return false;
        const rel = path.relative(watchPath, targetPath);
        if (!rel) return false; // never ignore the watch root itself
        return this.isIgnoredEventPath(rel, gitignoredDirs, stats.isDirectory());
      };

      const worktreeWatcher = chokidarWatch(watchPath, {
        ignored,
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        awaitWriteFinish: false,
        usePolling: false,
        atomic: false,
      });

      worktreeWatcher.on('all', (_eventName, changedPath) => {
        const rel = path.relative(watchPath, changedPath) || changedPath;
        this.handleFileChange(sessionId, rel, 'change');
      });
      worktreeWatcher.on('error', (err) => {
        // Storm guard FIRST: during handle exhaustion chokidar emits one error
        // per failed directory registration and keeps emitting until the
        // fire-and-forget close() lands — once degraded (or torn down), drop
        // the remaining events silently instead of re-amplifying #309's log storm.
        const session = this.watchedSessions.get(sessionId);
        if (!session || session.mode === 'polling') return;
        // chokidar 5 types the error handler arg as `unknown`; extract the code
        // via ErrnoException cast (the no-any-compliant route). Only the
        // handle-exhaustion errors degrade to polling — other chokidar errors
        // stay log-only to avoid over-eager fallback on transient stat blips.
        const code = decodeBoundary(err, boundary.object({ code: boundary.optional(boundary.string) })).code;
        const normalizedError = err instanceof Error ? err : new Error(String(err));
        if (code === 'EMFILE' || code === 'ENOSPC') {
          this.logger?.error(`[GitFileWatcher] worktree watcher error`, normalizedError);
          this.handleWatcherFailure(sessionId, normalizedError);
          return;
        }
        // log-only errors are rate-limited to the first per session — repeated
        // transient blips must not turn into a sustained logger/IPC storm
        if (!session.nonFatalErrorLogged) {
          session.nonFatalErrorLogged = true;
          this.logger?.error(`[GitFileWatcher] worktree watcher error`, normalizedError);
        }
      });

      this.watchedSessions.set(sessionId, {
        sessionId,
        worktreePath,
        mode: 'chokidar',
        worktreeWatcher,
        gitWatcher,
        selfHealTimer: this.startSelfHeal(sessionId),
        watcherErrorLogged: false,
        lastModified: Date.now(),
        pendingRefresh: false,
      });

      // Seed the self-heal snapshot baseline off the activation critical path
      // (same rationale as the native branch above).
      setImmediate(() => { void this.pollStatusSnapshot(sessionId); });

      // Validation signal — keep in production: confirms watcher count is bounded
      this.logger?.info(
        `[GitFileWatcher] startWatching(${sessionId}) watchedSessions.size=${this.watchedSessions.size}`
      );
    } catch (error) {
      this.logger?.error(
        `[GitFileWatcher] Failed to start watching session ${sessionId}:`,
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      if (metadataWatcher && this.watchedSessions.get(sessionId)?.gitWatcher !== metadataWatcher) {
        await metadataWatcher.close().catch(() => {});
      }
      if (this.pendingStarts.get(sessionId) === start) this.pendingStarts.delete(sessionId);
    }
  }

  private startWSLNativeWatcher(sessionId: string, worktreePath: string): boolean {
    const distro = this.commandRunner?.wslContext?.distribution;
    if (!distro || process.platform !== 'win32') return false;

    const script = `
      set -e
      cd "$1"
      if ! command -v inotifywait >/dev/null 2>&1; then
        echo "__PANE_WSL_POLLING_FALLBACK__" >&2
        last="$(git status --porcelain=v1 --branch --untracked-files=normal 2>/dev/null || true)"
        while sleep 5; do
          current="$(git status --porcelain=v1 --branch --untracked-files=normal 2>/dev/null || true)"
          if [ "$current" != "$last" ]; then
            printf '%s\n' "__PANE_WSL_POLL__"
            last="$current"
          fi
        done
      fi
      gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null || true)"
      watch_args=(.)
      if [ -n "$gitdir" ]; then
        [ -e "$gitdir/index" ] && watch_args+=("$gitdir/index")
        [ -e "$gitdir/HEAD" ] && watch_args+=("$gitdir/HEAD")
      fi
      exec inotifywait -m -r -q \
        -e modify,create,delete,move,attrib \
        --format '%w%f' \
        --exclude '(^|/)(node_modules|\\.git|\\.next|\\.nuxt|\\.turbo|\\.cache|\\.parcel-cache|\\.venv|venv|__pycache__|\\.svelte-kit)(/|$)' \
        "\${watch_args[@]}"
    `;

    const child = spawn('wsl.exe', ['-d', distro, '--', 'bash', '-lc', script, 'pane-wsl-watch', worktreePath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          this.handleFileChange(sessionId, line.trim(), 'change');
        }
      }
    });

    let pollingFallback = false;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (chunk.includes('__PANE_WSL_POLLING_FALLBACK__')) {
        pollingFallback = true;
        this.logger?.warn(
          `[GitFileWatcher] WSL native inotify unavailable for ${sessionId}; ` +
          `using WSL-native 5s git polling fallback. Install inotify-tools for lower battery use.`
        );
        return;
      }
      const message = chunk.trim();
      if (message) {
        this.logger?.warn(`[GitFileWatcher] WSL native watcher stderr for ${sessionId}: ${message}`);
      }
    });

    child.on('exit', (code, signal) => {
      const session = this.watchedSessions.get(sessionId);
      if (session?.wslWatcher === child) {
        this.watchedSessions.delete(sessionId);
      }
      if (code !== 0 && signal !== 'SIGTERM') {
        this.logger?.warn(`[GitFileWatcher] WSL native watcher exited for ${sessionId} with code=${code} signal=${signal ?? 'none'}`);
      }
    });

    child.on('error', (error) => {
      this.logger?.error(`[GitFileWatcher] Failed to start WSL native watcher for ${sessionId}:`, error);
    });

    this.watchedSessions.set(sessionId, {
      sessionId,
      worktreePath,
      mode: 'wsl',
      wslWatcher: child,
      watcherErrorLogged: false,
      lastModified: Date.now(),
      pendingRefresh: false,
    });

    this.logger?.info(
      `[GitFileWatcher] startWatching(${sessionId}) using WSL native watcher; watchedSessions.size=${this.watchedSessions.size}` +
      (pollingFallback ? ' mode=polling' : '')
    );
    return true;
  }

  /**
   * Stop watching a session's worktree
   */
  stopWatching(sessionId: string): void {
    this.pendingStarts.delete(sessionId);
    const session = this.watchedSessions.get(sessionId);
    if (!session) return;

    // fire-and-forget async close — keeps stopWatching synchronous from callers' perspective
    session.worktreeWatcher?.close().catch(() => {});
    session.gitWatcher?.close().catch(() => {});
    session.nativeWatcher?.close(); // node:fs FSWatcher.close() is synchronous
    session.wslWatcher?.kill();
    if (session.pollTimer) clearInterval(session.pollTimer);
    if (session.selfHealTimer) clearInterval(session.selfHealTimer);
    this.watchedSessions.delete(sessionId);

    // Clear any pending refresh timer
    const timer = this.refreshDebounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.refreshDebounceTimers.delete(sessionId);
    }

    this.logger?.info(`[GitFileWatcher] Stopped watching session ${sessionId}`);
  }

  /**
   * Stop all watchers
   */
  stopAll(): void {
    this.pendingStarts.clear();
    for (const sessionId of this.watchedSessions.keys()) {
      this.stopWatching(sessionId);
    }
    // Clear the instance-level gitignore cache only here — per-session
    // stopWatching must NOT clear it (the cache exists to survive
    // pane-switch/focus teardown-rebuild churn).
    this.gitignoreDirCache.clear();
  }

  /**
   * Handle a file change event
   */
  private handleFileChange(sessionId: string, _filename: string, _eventType: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session) return;

    // Update last modified time
    session.lastModified = Date.now();
    session.pendingRefresh = true;

    // Debounce the refresh to batch rapid changes
    this.scheduleRefreshCheck(sessionId);
  }

  /**
   * Schedule a refresh check for a session
   */
  private scheduleRefreshCheck(sessionId: string): void {
    // Clear existing timer
    const existingTimer = this.refreshDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.refreshDebounceTimers.delete(sessionId);
      this.emitPendingRefresh(sessionId);
    }, this.DEBOUNCE_MS);

    this.refreshDebounceTimers.set(sessionId, timer);
  }

  /** Refresh after every relevant event, including transitions back to a clean tree. */
  private emitPendingRefresh(sessionId: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session?.pendingRefresh) return;
    session.pendingRefresh = false;
    this.emit('needs-refresh', sessionId);
  }

  /** Run a git command, using CommandRunner when available for WSL support */
  private async execGit(command: string, cwd: string): Promise<string> {
    if (this.commandRunner) {
      return (await this.commandRunner.execAsync(command, cwd, { silent: true })).stdout;
    }
    return (await commandExecutor.execAsync(command, { cwd, silent: true })).stdout;
  }

  /**
   * Repo-truth ignored directories, derived from git and cached per watchPath
   * on the instance with a TTL. This is the gitignore half of the union ignore
   * set (the other half is the hardcoded IGNORED_DIRS). `git ls-files -o -i
   * --directory --exclude-standard` emits RELATIVE dir paths (slash-normalized
   * by git) with a TRAILING SLASH for on-disk ignored directories — we keep
   * only those lines, stripped of the slash. If the path is not yet a repo the
   * scan fails and we cache an empty set (the hardcoded list still applies).
   */
  private async getGitignoredDirs(watchPath: string): Promise<Set<string>> {
    const cached = this.gitignoreDirCache.get(watchPath);
    if (cached && Date.now() - cached.fetchedAt < GitFileWatcher.GITIGNORE_CACHE_TTL_MS) {
      return cached.dirs;
    }
    const pending = this.gitignoreRequests.get(watchPath);
    if (pending) return pending;
    const request = this.refreshGitignoredDirs(watchPath, cached?.dirs ?? new Set<string>());
    this.gitignoreRequests.set(watchPath, request);
    try {
      return await request;
    } finally {
      this.gitignoreRequests.delete(watchPath);
    }
  }

  private async refreshGitignoredDirs(watchPath: string, dirs: Set<string>): Promise<Set<string>> {
    try {
      const out = await this.execGit('git ls-files -o -i --directory --exclude-standard', watchPath);
      // Keep the same set so existing native and chokidar callbacks see TTL refreshes.
      dirs.clear();
      for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.endsWith('/')) dirs.add(trimmed.slice(0, -1));
      }
    } catch {
      // Not a repo yet: hardcoded ignores still apply.
    }
    this.gitignoreDirCache.set(watchPath, { dirs, fetchedAt: Date.now() });
    return dirs;
  }

  /**
   * Event-time ignore check for a root-relative path (native path uses this
   * instead of chokidar's registration-time descent pruning). O(path depth)
   * set lookups. `.git` internals are owned by the narrow metadata watcher, so
   * anything under `.git` is dropped here to keep index.lock churn from
   * resetting the debounce. EVERY segment (incl. the leaf) is checked against
   * IGNORED_DIRS — a file literally named `node_modules` isn't worth a refresh
   * and this avoids dir-vs-file guessing on event-time paths.
   *
   * `isLeafDirectory` is for callers that DO know (chokidar's registration-time
   * `ignored` fn gets stats): when true, IGNORED_FILE_PATTERNS is skipped so a
   * directory named like a temp file (e.g. `backup~`) is not silently pruned
   * from watching. Event-time callers leave it false (unknowable) and accept
   * the pattern check on the leaf.
   */
  private isIgnoredEventPath(
    relPath: string,
    gitignoredDirs: Set<string>,
    isLeafDirectory = false,
  ): boolean {
    const segments = relPath.split(/[\\/]/).filter(Boolean);
    if (segments.length === 0) return false;
    if (segments[0] === '.git') return true; // narrow watcher owns .git signals
    let prefix = '';
    for (const seg of segments) {
      if (IGNORED_DIRS.has(seg)) return true;
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (gitignoredDirs.has(prefix)) return true; // relative prefixes, e.g. "worktrees", "main/dist"
    }
    if (isLeafDirectory) return false;
    return IGNORED_FILE_PATTERNS.some((p) => p.test(segments[segments.length - 1]));
  }

  /**
   * Snapshot-diff poll shared by polling mode (5s) and self-heal (60s). Mirrors
   * the WSL bash fallback: snapshot `git status --porcelain` and emit
   * `needs-refresh` only when the snapshot DIFFERS from the previous poll. The
   * first poll seeds the baseline without emitting (lastStatusSnapshot
   * undefined), so a legitimately-dirty tree does not spam a refresh every tick.
   *
   * Known, intentional redundancy in watch modes: the baseline only updates on
   * these ticks, so the tick after a real (already watcher-emitted) change
   * emits one extra needs-refresh. That single bounded refresh doubles as the
   * safety net for coalesced/dropped events, and refresh is idempotent.
   */
  private async pollStatusSnapshot(sessionId: string): Promise<void> {
    const session = this.watchedSessions.get(sessionId);
    if (!session || session.pollInFlight) return;
    session.pollInFlight = true;
    try {
      // execGit/commandRunner expect the runner-domain path, not the
      // toFileSystem-converted one used by native filesystem watchers.
      const snapshot = await this.execGit(
        'git status --porcelain=v1 --branch --untracked-files=normal',
        session.worktreePath,
      );
      if (this.watchedSessions.get(sessionId) !== session) return;
      if (session.lastStatusSnapshot !== undefined && snapshot !== session.lastStatusSnapshot) {
        this.emit('needs-refresh', sessionId);
      }
      session.lastStatusSnapshot = snapshot;
    } catch {
      /* transient git failure — try again next tick */
    } finally {
      session.pollInFlight = false;
    }
  }

  /** 60s self-heal tick covering FSEvents coalescing / trailing-debounce starvation */
  private startSelfHeal(sessionId: string): NodeJS.Timeout {
    return setInterval(
      () => { void this.pollStatusSnapshot(sessionId); },
      GitFileWatcher.SELF_HEAL_INTERVAL_MS,
    );
  }

  /**
   * Watcher-failure entrypoint. No-ops when the session is missing or already
   * in polling mode — this is the storm-swallower: thousands of per-directory
   * EMFILE error events collapse to a single degrade. Reads worktreePath from
   * the session record and normalizes non-Error values.
   */
  private handleWatcherFailure(sessionId: string, err: Error): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session || session.mode === 'polling') return; // already degraded (or torn down); swallow the storm
    void this.transitionToPolling(
      sessionId,
      session.worktreePath,
      err,
    );
  }

  /**
   * Degrade a session to the 5s snapshot-diff polling loop. May run BEFORE any
   * session record exists (the native creation-throw path throws before
   * watchedSessions.set), so it builds a COMPLETE WatchedSession record from
   * its own parameters instead of assuming a prior one. Emits exactly one warn
   * per session lifetime (guarded by watcherErrorLogged), starts the snapshot
   * baseline immediately (a change landing in the 0-5s window before the
   * first tick must not be absorbed into a late-seeded baseline and go
   * un-emitted), then emits one immediate needs-refresh so consumers reconcile
   * promptly with the exact state the baseline captured.
   */
  private async transitionToPolling(sessionId: string, worktreePath: string, err: Error): Promise<void> {
    const session = this.watchedSessions.get(sessionId);
    // close everything watcher-shaped; keep the debounce map intact
    session?.nativeWatcher?.close(); // sync
    session?.worktreeWatcher?.close().catch(() => {});
    session?.gitWatcher?.close().catch(() => {});
    if (session?.selfHealTimer) clearInterval(session.selfHealTimer);
    if (session?.pollTimer) clearInterval(session.pollTimer);
    if (!session?.watcherErrorLogged) {
      this.logger?.warn(
        `[GitFileWatcher] Watcher failed for ${sessionId} (${err.message}); ` +
          `falling back to 5s git status polling.`,
      );
    }
    const pollTimer = setInterval(
      () => { void this.pollStatusSnapshot(sessionId); },
      GitFileWatcher.POLL_INTERVAL_MS,
    );
    this.watchedSessions.set(sessionId, {
      sessionId,
      worktreePath,
      mode: 'polling',
      pollTimer,
      watcherErrorLogged: true,
      lastStatusSnapshot: undefined,
      lastModified: session?.lastModified ?? Date.now(),
      pendingRefresh: false,
    });
    // Seed the baseline NOW (pollStatusSnapshot only records, never emits, when
    // the baseline is undefined) — deferring it to the first 5s tick would
    // silently absorb any change made in that window. Then emit one immediate
    // refresh so consumers reconcile with the state the baseline captured.
    const polling = this.watchedSessions.get(sessionId);
    await this.pollStatusSnapshot(sessionId);
    if (this.watchedSessions.get(sessionId) === polling) this.emit('needs-refresh', sessionId);
  }

  /**
   * Narrow `.git`-metadata chokidar watcher, used by BOTH the native and
   * chokidar branches. Covers the status-relevant metadata that the worktree
   * watcher would otherwise miss or (on native) is deliberately filtered out:
   * `index` (staging/commits), `HEAD` (branch switch), and — via the git COMMON
   * dir — `packed-refs` and `refs/heads` (branch create/delete).
   *
   * Pane sessions usually run in git worktrees, where `.git` inside the
   * worktree is a FILE pointing at `.git/worktrees/<name>`; the real `index`
   * and `HEAD` live under the resolved `--absolute-git-dir`, while `refs/heads`
   * and `packed-refs` live under the `--git-common-dir` (the MAIN repo's `.git`
   * for a linked worktree). `--git-common-dir` may be relative (e.g. `.git`),
   * unlike `--absolute-git-dir`, so it is resolved against `watchPath`. If
   * resolution fails (not yet a valid repo) we skip the narrow watcher and rely
   * on the worktree/native watcher alone, exactly as before.
   */
  private async createGitMetadataWatcher(sessionId: string, watchPath: string): Promise<FSWatcher | undefined> {
    try {
      // rev-parse emits one line per flag, in flag order — but guard the shape
      const lines = (await this.execGit('git rev-parse --absolute-git-dir --git-common-dir', watchPath))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const gitDir = lines[0];
      if (!gitDir) return undefined;
      const commonDirRaw = lines[1]; // may be missing or relative, e.g. ".git"
      const commonDir = commonDirRaw
        ? path.isAbsolute(commonDirRaw)
          ? commonDirRaw
          : path.resolve(watchPath, commonDirRaw)
        : undefined;
      const targets = new Set<string>([
        path.join(gitDir, 'index'),
        path.join(gitDir, 'HEAD'),
        // small dir + single file; chokidar handle cost is trivial here
        ...(commonDir
          ? [path.join(commonDir, 'packed-refs'), path.join(commonDir, 'refs', 'heads')]
          : []), // degrade to index/HEAD-only, as today
      ]);
      const gitWatcher = chokidarWatch([...targets], {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        usePolling: false,
      });
      gitWatcher.on('all', () => {
        // intentional: bypass any ignore checks, always trigger on
        // git index/HEAD/refs changes
        this.handleFileChange(sessionId, '.git/index', 'change');
      });
      // narrow watcher (~4 paths) cannot EMFILE — keep errors log-only, as
      // today; do NOT route to handleWatcherFailure or a stat blip on
      // refs/heads would needlessly degrade a healthy session to polling
      gitWatcher.on('error', (err) => {
        this.logger?.error(`[GitFileWatcher] .git watcher error`, err instanceof Error ? err : new Error(String(err)));
      });
      return gitWatcher;
    } catch (gitDirErr) {
      this.logger?.error(
        `[GitFileWatcher] Failed to resolve gitdir for ${sessionId}, ` +
          `narrow .git watcher disabled (metadata-only operations will ` +
          `not trigger refresh until worktree watcher fires):`,
        gitDirErr instanceof Error ? gitDirErr : new Error(String(gitDirErr)),
      );
      return undefined;
    }
  }

  /**
   * Get statistics about watched sessions
   */
  getStats(): GitFileWatcherStats {
    let sessionsNeedingRefresh = 0;
    for (const session of this.watchedSessions.values()) {
      if (session.pendingRefresh) {
        sessionsNeedingRefresh++;
      }
    }

    return {
      totalWatched: this.watchedSessions.size,
      sessionsNeedingRefresh,
    };
  }
}
