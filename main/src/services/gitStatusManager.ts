import { HOME_GIT_SCAN_WARNING, isHomeDirectory } from '../utils/gitScanSafety';
import { EventEmitter } from 'events';
import type { Logger } from '../utils/logger';
import type { GitStatus } from '../types/session';
import type { SessionManager } from './sessionManager';
import type { WorktreeManager } from './worktreeManager';
import type { GitDiffManager } from './gitDiffManager';
import type { CommandRunner } from '../utils/commandRunner';
import type { DatabaseService } from '../database/database';
import { GitStatusLogger } from './gitStatusLogger';
import { GitFileWatcher } from './gitFileWatcher';
import { fastCheckWorkingDirectory, fastGetAheadBehind, fastGetDiffStats } from './gitPlumbingCommands';
import { escapeShellArg } from '../utils/shellEscape';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const githubPrListSchema = boundary.array(boundary.object({
  number: boundary.optional(boundary.number),
  url: boundary.optional(boundary.string),
  title: boundary.optional(boundary.string),
  state: boundary.optional(boundary.string),
  isDraft: boundary.optional(boundary.boolean),
  body: boundary.optional(boundary.string),
}));

interface GitStatusCache {
  [sessionId: string]: {
    status: GitStatus;
    lastChecked: number;
  };
}

interface PendingRefresh {
  timer?: NodeJS.Timeout;
  isUserInitiated: boolean;
  waiters: Array<{
    resolve: (status: GitStatus | null) => void;
    reject: (error: Error) => void;
  }>;
}

type PrData = {
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prState?: string;
  prIsDraft?: boolean;
  prBody?: string;
};

type PrLookupResult =
  | { ok: true; pr?: PrData }
  | { ok: false };

const PR_FIELDS = ['prNumber', 'prUrl', 'prTitle', 'prState', 'prIsDraft', 'prBody'] as const;

interface GitStatusManagerDependencies {
  fastCheckWorkingDirectory: typeof fastCheckWorkingDirectory;
  fastGetAheadBehind: typeof fastGetAheadBehind;
  fastGetDiffStats: typeof fastGetDiffStats;
}

const defaultGitStatusManagerDependencies: GitStatusManagerDependencies = {
  fastCheckWorkingDirectory,
  fastGetAheadBehind,
  fastGetDiffStats,
};

export class GitStatusManager extends EventEmitter {
  private cache: GitStatusCache = {};
  // Smart visibility-aware polling for active sessions only
  private readonly CACHE_TTL_MS = 5000; // 5 seconds cache
  private pendingRefreshes = new Map<string, PendingRefresh>();
  private readonly DEBOUNCE_MS = 2000; // 2 seconds debounce to batch rapid changes
  private gitLogger: GitStatusLogger;
  private fileWatcher: GitFileWatcher;

  // Throttling for UI events
  private eventThrottleTimer: NodeJS.Timeout | null = null;
  private pendingEvents: Map<string, { type: 'loading' | 'updated', data?: GitStatus }> = new Map();
  private readonly EVENT_THROTTLE_MS = 100; // Throttle UI events to prevent flooding

  // Concurrent operation limiting
  private activeOperations = 0;
  private readonly MAX_CONCURRENT_OPERATIONS = 3; // Reduced to limit CPU usage
  private operationQueue: Array<() => Promise<void>> = [];

  // Cancellation support
  private abortControllers: Map<string, AbortController> = new Map();

  // Initial load management
  private isInitialLoadInProgress = false;
  private initialLoadQueue: string[] = [];
  private readonly INITIAL_LOAD_DELAY_MS = 200; // Increased to 200ms for better staggering
  private readonly INITIAL_LOAD_JITTER_MS = 2500;

  // Track active session and window visibility for optimized refreshes
  private activeSessionId: string | null = null;
  private isWindowVisible = true;

  // PR data cache
  private prCache = new Map<string, { prNumber?: number; prUrl?: string; prTitle?: string; prState?: string; prIsDraft?: boolean; prBody?: string; fetchedAt: number }>();
  private readonly PR_HIT_CACHE_TTL = 2.5 * 60 * 1000;
  private readonly PR_MISS_CACHE_TTL = 20 * 1000;
  private readonly PR_ENRICHMENT_JITTER_MS = 10_000;
  private readonly MAX_CONCURRENT_PR_ENRICHMENT = 1;
  private activePrEnrichmentOperations = 0;
  private prEnrichmentTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private sessionManager: SessionManager,
    private worktreeManager: WorktreeManager,
    private gitDiffManager: GitDiffManager,
    private logger?: Logger,
    private databaseService?: DatabaseService,
    private readonly dependencies: GitStatusManagerDependencies = defaultGitStatusManagerDependencies,
  ) {
    super();
    // Increase max listeners to prevent warnings when many components listen to git status events
    // This is expected since each SessionListItem listens for git status updates
    this.setMaxListeners(100);
    this.gitLogger = new GitStatusLogger(logger);
    
    // Initialize file watcher for smart refresh detection
    this.fileWatcher = new GitFileWatcher(logger);
    this.fileWatcher.on('needs-refresh', (sessionId: string) => {
      // File watcher detected changes, refresh git status
      this.logger?.info(`[GitStatus] File watcher triggered refresh for session ${sessionId}`);
      this.refreshSessionGitStatus(sessionId, false).catch(error => {
        this.logger?.error(`[GitStatus] Failed to refresh after file change for session ${sessionId}:`, error);
      });
    });

    this.hydratePersistentCache();
  }

  private hydratePersistentCache(): void {
    if (!this.databaseService) return;

    try {
      const cachedStatuses = this.databaseService.getAllSessionGitStatusCache();
      for (const cached of cachedStatuses) {
        this.cache[cached.sessionId] = {
          status: cached.gitStatus,
          lastChecked: cached.lastChecked,
        };
      }
      if (cachedStatuses.length > 0) {
        this.logger?.info(`[GitStatus] Hydrated ${cachedStatuses.length} cached git statuses`);
      }
    } catch (error) {
      this.logger?.error('[GitStatus] Failed to hydrate persisted git status cache:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private persistCachedStatus(sessionId: string, status: GitStatus, lastChecked: number): void {
    try {
      this.databaseService?.saveSessionGitStatusCache(sessionId, status, lastChecked);
    } catch (error) {
      this.logger?.error(`[GitStatus] Failed to persist status cache for ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
    }
  }


  /**
   * Set the currently active session for smart polling
   */
  setActiveSession(sessionId: string | null): void {
    const previousActive = this.activeSessionId;
    this.activeSessionId = sessionId;
    
    if (previousActive !== sessionId) {
      console.log(`[GitStatus] Active session changed from ${previousActive} to ${sessionId}`);
      
      // Start watching only while the window is visible. When Pane is
      // blurred/minimized, focus refresh is cheaper than keeping recursive
      // watchers hot, especially for WSL UNC paths.
      if (sessionId && this.isWindowVisible) {
        this.startWatchingSession(sessionId);

        this.refreshSessionGitStatus(sessionId, false).catch(error => {
          console.warn(`[GitStatus] Failed to refresh active session ${sessionId}:`, error);
        });
      }
      
      // Stop watching the previous active session if it exists
      if (previousActive) {
        this.stopWatchingSession(previousActive);
      }
    }
  }
  
  /**
   * Start file watching for a session
   */
  private async startWatchingSession(sessionId: string): Promise<void> {
    try {
      const session = await this.sessionManager.getSession(sessionId);
      if (session?.worktreePath) {
        const ctx = this.sessionManager.getProjectContext(sessionId);
        this.fileWatcher.setExecutionContext(ctx?.commandRunner, ctx?.pathResolver);
        await this.fileWatcher.startWatching(sessionId, session.worktreePath);
        this.logger?.info(`[GitStatus] Started file watching for session ${sessionId}`);
      }
    } catch (error) {
      this.logger?.error(`[GitStatus] Failed to start file watching for session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
    }
  }
  
  /**
   * Stop file watching for a session
   */
  private stopWatchingSession(sessionId: string): void {
    this.fileWatcher.stopWatching(sessionId);
    this.logger?.info(`[GitStatus] Stopped file watching for session ${sessionId}`);
  }
  
  /**
   * Start git status manager (initializes file watching)
   */
  startPolling(): void {
    // File watching is started per-session in setActiveSession
    // This method is kept for backward compatibility
    this.gitLogger.logPollStart(1);
  }

  /**
   * Stop git status manager
   */
  stopPolling(): void {
    // Stop all file watchers
    this.fileWatcher.stopAll();
    
    this.gitLogger.logSummary();

    // Clear any pending debounce timers
    for (const sessionId of this.pendingRefreshes.keys()) this.cancelPendingRefresh(sessionId);

    // Clear event throttle timer
    if (this.eventThrottleTimer) {
      clearTimeout(this.eventThrottleTimer);
      this.eventThrottleTimer = null;
    }
    this.pendingEvents.clear();

    this.prEnrichmentTimers.forEach(timer => clearTimeout(timer));
    this.prEnrichmentTimers.clear();
    
    // Cancel all active operations
    this.abortControllers.forEach(controller => controller.abort());
    this.abortControllers.clear();
  }

  // Called when window focus changes
  handleVisibilityChange(isHidden: boolean): void {
    this.isWindowVisible = !isHidden;
    this.gitLogger.logFocusChange(!isHidden);

    if (isHidden) {
      if (this.activeSessionId) {
        this.stopWatchingSession(this.activeSessionId);
      }
      return;
    }

    // If window becomes visible and we have an active session, restart the
    // watcher and do one authoritative refresh for any changes missed while hidden.
    if (this.activeSessionId) {
      void this.refreshActiveSessionAfterFocus(this.activeSessionId);
    }
  }

  private async refreshActiveSessionAfterFocus(sessionId: string): Promise<void> {
    try {
      await this.startWatchingSession(sessionId);
      await this.invalidatePrMissCacheForSession(sessionId);
      await this.refreshSessionGitStatus(sessionId, false);
    } catch (error) {
      console.warn(`[GitStatus] Failed to refresh active session on focus:`, error);
    }
  }

  /**
   * Get cached status without fetching
   */
  getCachedStatus(sessionId: string): { status: GitStatus; lastChecked: number } | null {
    return this.cache[sessionId] || null;
  }

  /**
   * Get git status for a specific session (with caching)
   */
  async getGitStatus(sessionId: string): Promise<GitStatus | null> {
    // Check cache first
    const cached = this.cache[sessionId];
    if (cached && Date.now() - cached.lastChecked < this.CACHE_TTL_MS) {
      this.gitLogger.logSessionFetch(sessionId, true);
      return cached.status;
    }

    // Fetch fresh status
    const status = await this.fetchGitStatus(sessionId);
    if (status) {
      return this.updateCache(sessionId, status);
    }
    return status;
  }

  /**
   * Refresh git status for all sessions in a project
   * @param projectId - The project ID to refresh sessions for
   */
  private async refreshGitStatusForProject(projectId: number): Promise<void> {
    try {
      const sessions = await this.sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived && s.status !== 'error');
      
      // Refresh all sessions in parallel
      await Promise.all(projectSessions.map(session => 
        this.refreshSessionGitStatus(session.id, false).catch(() => {
          // Individual failures are logged by GitStatusManager
        })
      ));
    } catch (error) {
      this.logger?.error(`[GitStatus] Failed to refresh git status for project ${projectId}:`, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Update git status for all sessions in a project after main branch was updated
   * @param projectId - The project ID to update sessions for
   * @param updatedBySessionId - The session ID that caused the update (e.g. rebased to main)
   */
  async updateProjectGitStatusAfterMainUpdate(projectId: number, updatedBySessionId?: string): Promise<void> {
    try {
      const sessions = await this.sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived && s.status !== 'error');
      
      // Update all sessions in parallel
      await Promise.all(projectSessions.map(async (session) => {
        if (session.id === updatedBySessionId) {
          // The session that rebased to main is now in sync with main
          await this.updateGitStatusAfterRebase(session.id, 'to_main');
        } else {
          // Other sessions may now be behind main
          const cached = this.cache[session.id];
          if (cached && session.worktreePath && !isHomeDirectory(session.worktreePath)) {
            try {
              // Quick check for new ahead/behind status
              const ctx = this.sessionManager.getProjectContext(session.id);
              if (ctx) {
                const comparisonBranch = await this.worktreeManager.getSessionComparisonBranch(session, ctx);
                const { ahead, behind } = await this.dependencies.fastGetAheadBehind(session.worktreePath, comparisonBranch, ctx.commandRunner.wslContext);
                
                const updatedStatus = { ...cached.status };
                updatedStatus.ahead = ahead;
                updatedStatus.behind = behind;
                
                // Update cache and emit
                this.updateCache(session.id, updatedStatus);
                this.emitThrottled(session.id, 'updated', updatedStatus);
              }
            } catch {
              // Fall back to full refresh on error
              await this.refreshSessionGitStatus(session.id, false);
            }
          } else {
            // No cache, do a full refresh
            await this.refreshSessionGitStatus(session.id, false);
          }
        }
      }));
      
      this.logger?.info(`[GitStatus] Updated all sessions in project ${projectId} after main branch update`);
    } catch (error) {
      this.logger?.error(`[GitStatus] Error updating project statuses after main update:`, error instanceof Error ? error : new Error(String(error)));
      // Fall back to refreshing all
      await this.refreshGitStatusForProject(projectId);
    }
  }

  /**
   * Update git status after a rebase operation without running git commands
   * @param sessionId - The session ID to update
   * @param rebaseType - 'from_main' or 'to_main' 
   */
  async updateGitStatusAfterRebase(sessionId: string, rebaseType: 'from_main' | 'to_main'): Promise<void> {
    try {
      const cached = this.cache[sessionId];
      if (!cached) {
        // No cached status, fall back to refresh
        await this.refreshSessionGitStatus(sessionId, false);
        return;
      }

      const session = await this.sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath || isHomeDirectory(session.worktreePath)) {
        return;
      }

      const ctx = this.sessionManager.getProjectContext(sessionId);
      if (!ctx) {
        return;
      }

      // Create updated status based on rebase type
      const updatedStatus = { ...cached.status };
      
      if (rebaseType === 'from_main') {
        // After rebasing from main, we're no longer behind
        updatedStatus.behind = 0;
        // ahead count stays the same or might change if there were conflicts resolved
        // hasUncommittedChanges might be true if there were conflicts
        // We'll do a quick check for uncommitted changes
        try {
          const quickStatus = await this.dependencies.fastCheckWorkingDirectory(session.worktreePath, ctx.commandRunner.wslContext);
          updatedStatus.hasUncommittedChanges = quickStatus.hasModified || quickStatus.hasStaged;
          updatedStatus.hasUntrackedFiles = quickStatus.hasUntracked;
          // Update state based on conflicts
          if (quickStatus.hasConflicts) {
            updatedStatus.state = 'conflict';
          }

          if (updatedStatus.hasUncommittedChanges) {
            // Get updated diff stats
            const quickStats = await this.dependencies.fastGetDiffStats(session.worktreePath, ctx.commandRunner.wslContext);
            updatedStatus.additions = quickStats.additions;
            updatedStatus.deletions = quickStats.deletions;
            updatedStatus.filesChanged = quickStats.filesChanged;
          } else {
            updatedStatus.additions = 0;
            updatedStatus.deletions = 0;
            updatedStatus.filesChanged = 0;
          }
        } catch {
          // If quick check fails, fall back to full refresh
          await this.refreshSessionGitStatus(sessionId, false);
          return;
        }
      } else if (rebaseType === 'to_main') {
        // After rebasing to main, we're ahead of main with our changes
        // and no longer behind (since we just rebased onto it)
        updatedStatus.behind = 0;
        // ahead count would be the number of commits we have
        // hasUncommittedChanges should be false (we just rebased cleanly)
        updatedStatus.hasUncommittedChanges = false;
        updatedStatus.hasUntrackedFiles = false;
        updatedStatus.state = 'ahead'; // We're ahead after rebasing to main
        updatedStatus.additions = 0;
        updatedStatus.deletions = 0;
        updatedStatus.filesChanged = 0;
      }

      // Update cache and emit
      const cachedStatus = this.updateCache(sessionId, updatedStatus);
      this.emitThrottled(sessionId, 'updated', cachedStatus);
      
      this.logger?.info(`[GitStatus] Updated status after ${rebaseType} rebase for session ${sessionId}`);
    } catch (error) {
      this.logger?.error(`[GitStatus] Error updating status after rebase for session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
      // Fall back to full refresh on error
      await this.refreshSessionGitStatus(sessionId, false);
    }
  }

  /**
   * Force refresh git status for a specific session (with debouncing)
   * @param sessionId - The session ID to refresh
   * @param isUserInitiated - Whether this refresh was triggered by user action (shows loading spinner)
   */
  async refreshSessionGitStatus(sessionId: string, isUserInitiated = false): Promise<GitStatus | null> {
    // Immediately emit loading state so user sees refresh is happening
    // This provides immediate visual feedback
    this.emitThrottled(sessionId, 'loading');
    
    const pending = this.pendingRefreshes.get(sessionId) ?? { isUserInitiated, waiters: [] };
    if (pending.timer) {
      clearTimeout(pending.timer);
      this.gitLogger.logDebounce(sessionId, 'cancelled');
    }
    pending.isUserInitiated ||= isUserInitiated;
    this.gitLogger.logDebounce(sessionId, 'start');
    const result = new Promise<GitStatus | null>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
    pending.timer = setTimeout(() => {
      this.pendingRefreshes.delete(sessionId);
      this.gitLogger.logDebounce(sessionId, 'complete');
      void this.runPendingRefresh(sessionId, pending).then(
        status => pending.waiters.forEach(waiter => waiter.resolve(status)),
        error => {
          const failure = error instanceof Error ? error : new Error(String(error));
          pending.waiters.forEach(waiter => waiter.reject(failure));
        },
      );
    }, this.DEBOUNCE_MS);
    this.pendingRefreshes.set(sessionId, pending);
    return result;
  }

  private async runPendingRefresh(sessionId: string, pending: PendingRefresh): Promise<GitStatus | null> {
    const status = await this.fetchGitStatus(sessionId);
    if (status) {
      const cachedStatus = this.updateCache(sessionId, status);
      this.emitThrottled(sessionId, 'updated', cachedStatus);
      if (this.shouldSchedulePrEnrichment(cachedStatus)) {
        this.schedulePrEnrichment(sessionId, pending.isUserInitiated);
      }
    }
    return status ? this.cache[sessionId]?.status || status : status;
  }

  private cancelPendingRefresh(sessionId: string): void {
    const pending = this.pendingRefreshes.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRefreshes.delete(sessionId);
    pending.waiters.forEach(waiter => waiter.resolve(null));
  }

  /**
   * Queue a session for initial git status loading with staggered execution
   * This prevents UI lock when many sessions load at once
   */
  async queueInitialLoad(sessionId: string): Promise<GitStatus | null> {
    // Check cache first
    const cached = this.getCachedStatus(sessionId);
    if (cached && Date.now() - cached.lastChecked < this.CACHE_TTL_MS) {
      return cached.status;
    }

    // Add to initial load queue if not already there. Return stale status
    // immediately so startup can render from the persisted cache while the
    // authoritative refresh happens in the background.
    if (!this.initialLoadQueue.includes(sessionId)) {
      this.initialLoadQueue.push(sessionId);
      if (!cached) {
        this.emitThrottled(sessionId, 'loading');
      }
    }

    // Start processing queue if not already running
    if (!this.isInitialLoadInProgress) {
      this.processInitialLoadQueue();
    }

    // Return cached status immediately (UI will update when fresh data arrives via events)
    return cached?.status || null;
  }

  /**
   * Process the initial load queue with staggering to prevent UI lock
   */
  private async processInitialLoadQueue(): Promise<void> {
    if (this.isInitialLoadInProgress || this.initialLoadQueue.length === 0) {
      return;
    }

    this.isInitialLoadInProgress = true;
    
    while (this.initialLoadQueue.length > 0) {
      // Take a batch of sessions to process
      const batchSize = Math.min(this.MAX_CONCURRENT_OPERATIONS, this.initialLoadQueue.length);
      const batch = this.initialLoadQueue.splice(0, batchSize);
      
      // Process batch concurrently
      const promises = batch.map(sessionId => 
        this.executeWithLimit(async () => {
          try {
            if (sessionId !== this.activeSessionId) {
              await new Promise(resolve => setTimeout(
                resolve,
                Math.floor(Math.random() * this.INITIAL_LOAD_JITTER_MS),
              ));
            }
            const status = await this.fetchGitStatus(sessionId);
            if (status) {
              const cachedStatus = this.updateCache(sessionId, status);
              this.emitThrottled(sessionId, 'updated', cachedStatus);
              if (this.shouldSchedulePrEnrichment(cachedStatus)) {
                this.schedulePrEnrichment(sessionId, sessionId === this.activeSessionId);
              }
            }
          } catch (error) {
            this.logger?.error(`[GitStatus] Error fetching status for session ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
          }
        })
      );
      
      await Promise.allSettled(promises);
      
      // Small delay between batches to keep UI responsive
      if (this.initialLoadQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.INITIAL_LOAD_DELAY_MS));
      }
    }
    
    this.isInitialLoadInProgress = false;
  }

  async fetchPrForSession(
    branchName: string,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<{ prNumber?: number; prUrl?: string; prTitle?: string; prState?: string; prIsDraft?: boolean; prBody?: string }> {
    const result = await this.fetchPrForSessionResult(branchName, projectPath, commandRunner);
    return result.ok && result.pr ? result.pr : {};
  }

  private async fetchPrForSessionResult(
    branchName: string,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<PrLookupResult> {
    const cacheKey = `${projectPath}:${branchName}`;
    const cached = this.prCache.get(cacheKey);
    const cacheTtl = cached?.prNumber !== undefined ? this.PR_HIT_CACHE_TTL : this.PR_MISS_CACHE_TTL;
    if (cached && Date.now() - cached.fetchedAt < cacheTtl) {
      return {
        ok: true,
        pr: cached.prNumber !== undefined
          ? { prNumber: cached.prNumber, prUrl: cached.prUrl, prTitle: cached.prTitle, prState: cached.prState, prIsDraft: cached.prIsDraft, prBody: cached.prBody }
          : undefined,
      };
    }

    try {
      const result = await commandRunner.execAsync(
        `gh pr list --head ${escapeShellArg(branchName)} --state all --json number,url,title,state,isDraft,body --limit 1`,
        projectPath,
        { timeout: 5000 }
      );
      const prs = decodeBoundary(JSON.parse(result.stdout.trim() || '[]'), githubPrListSchema);
      const pr = prs[0];
      const entry = {
        prNumber: pr?.number,
        prUrl: pr?.url,
        prTitle: pr?.title,
        prState: pr?.state,
        prIsDraft: pr?.isDraft,
        prBody: pr?.body,
        fetchedAt: Date.now()
      };
      this.prCache.set(cacheKey, entry);
      return {
        ok: true,
        pr: entry.prNumber !== undefined
          ? { prNumber: entry.prNumber, prUrl: entry.prUrl, prTitle: entry.prTitle, prState: entry.prState, prIsDraft: entry.prIsDraft, prBody: entry.prBody }
          : undefined,
      };
    } catch {
      return { ok: false };
    }
  }

  invalidatePrCache(projectPath?: string): void {
    if (projectPath) {
      for (const key of this.prCache.keys()) {
        if (key.startsWith(`${projectPath}:`)) {
          this.prCache.delete(key);
        }
      }
    } else {
      this.prCache.clear();
    }
  }

  private async invalidatePrMissCacheForSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session?.worktreePath) return;

    const project = this.sessionManager.getProjectForSession(sessionId);
    if (!project?.path) return;

    const ctx = this.sessionManager.getProjectContext(sessionId);
    if (!ctx) return;

    const branchName = await this.getCurrentBranchName(session.worktreePath, ctx.commandRunner);
    if (!branchName) return;

    const cacheKey = `${project.path}:${branchName}`;
    const cached = this.prCache.get(cacheKey);
    if (cached && cached.prNumber === undefined) {
      this.prCache.delete(cacheKey);
    }
  }

  private async getCurrentBranchName(worktreePath: string, commandRunner: CommandRunner): Promise<string | null> {
    try {
      const branchName = (await commandRunner.execAsync('git branch --show-current', worktreePath, { silent: true })).stdout.trim();
      if (branchName) return branchName;
    } catch {
      // Fall back to the worktree folder name below.
    }

    return worktreePath.replace(/\\/g, '/').split('/').pop() || null;
  }

  private schedulePrEnrichment(sessionId: string, immediate = false): void {
    if (this.prEnrichmentTimers.has(sessionId)) return;

    const jitter = immediate || sessionId === this.activeSessionId
      ? 0
      : Math.floor(Math.random() * this.PR_ENRICHMENT_JITTER_MS);

    const timer = setTimeout(() => {
      this.prEnrichmentTimers.delete(sessionId);
      this.executePrEnrichmentWithLimit(() => this.enrichWithPrData(sessionId)).catch(() => {
        // PR enrichment is best-effort; fetchPrForSession records misses in cache.
      });
    }, jitter);

    this.prEnrichmentTimers.set(sessionId, timer);
  }

  private async enrichWithPrData(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session?.worktreePath) return;

    const project = this.sessionManager.getProjectForSession(sessionId);
    if (!project?.path) return;

    const ctx = this.sessionManager.getProjectContext(sessionId);
    if (!ctx) return;

    const branchName = await this.getCurrentBranchName(session.worktreePath, ctx.commandRunner);
    if (!branchName) return;

    const prResult = await this.fetchPrForSessionResult(branchName, project.path, ctx.commandRunner);
    if (!prResult.ok) return;

    const currentStatus = this.cache[sessionId]?.status;
    if (!currentStatus) return;

    const prData = prResult.pr;
    if (prData?.prNumber !== undefined) {
      if (currentStatus && (
        currentStatus.prNumber !== prData.prNumber ||
        currentStatus.prState !== prData.prState ||
        currentStatus.prIsDraft !== prData.prIsDraft ||
        currentStatus.prTitle !== prData.prTitle ||
        currentStatus.prBody !== prData.prBody
      )) {
        const enrichedStatus = {
          ...currentStatus,
          prNumber: prData.prNumber,
          prUrl: prData.prUrl,
          prTitle: prData.prTitle,
          prState: prData.prState,
          prIsDraft: prData.prIsDraft,
          prBody: prData.prBody
        };
        const lastChecked = this.cache[sessionId].lastChecked;
        this.cache[sessionId] = {
          status: enrichedStatus,
          lastChecked
        };
        this.persistCachedStatus(sessionId, enrichedStatus, lastChecked);
        this.emit('git-status-updated', sessionId, enrichedStatus);
      }
      return;
    }

    if (currentStatus.prNumber !== undefined) {
      const clearedStatus = this.clearPrFields(currentStatus);
      const lastChecked = this.cache[sessionId].lastChecked;
      this.cache[sessionId] = {
        status: clearedStatus,
        lastChecked
      };
      this.persistCachedStatus(sessionId, clearedStatus, lastChecked);
      this.emit('git-status-updated', sessionId, clearedStatus);
    }
  }

  /**
   * Refresh git status for all active sessions (called manually, not on a timer)
   */
  async refreshAllSessions(): Promise<void> {
    try {
      const sessions = await this.sessionManager.getAllSessions();
      const activeSessions = sessions.filter(s => 
        !s.archived && s.status !== 'error' && s.worktreePath
      );

      this.gitLogger.logPollStart(activeSessions.length);
      
      // Immediately show loading for all sessions so user sees refresh happening
      activeSessions.forEach(session => {
        this.emitThrottled(session.id, 'loading');
      });

      // Process sessions with concurrent limiting
      let successCount = 0;
      let errorCount = 0;
      
      const results = await Promise.allSettled(
        activeSessions.map(session => 
          this.executeWithLimit(() => this.refreshSessionGitStatus(session.id, false)) // false = not user initiated
        )
      );
      
      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
        } else {
          errorCount++;
        }
      });
      
      this.gitLogger.logPollComplete(successCount, errorCount);
    } catch (error) {
      this.logger?.error('[GitStatus] Critical error during refresh:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Cancel git status operations for a session
   */
  cancelSessionGitStatus(sessionId: string): void {
    // Cancel any active fetch for this session
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    
    // Clear from loading state by emitting loading false
    this.setGitStatusLoading(sessionId, false);
    
    // Clear any pending debounce timer
    this.cancelPendingRefresh(sessionId);
  }
  
  /**
   * Helper to set git status loading state
   */
  private setGitStatusLoading(sessionId: string, loading: boolean): void {
    if (!loading) {
      // Emit that loading has stopped
      this.emit('git-status-loading', sessionId);
    }
  }

  /**
   * Cancel git status operations for multiple sessions
   */
  cancelMultipleGitStatus(sessionIds: string[]): void {
    sessionIds.forEach(id => this.cancelSessionGitStatus(id));
  }

  /**
   * Fetch git status for a session
   */
  private async fetchGitStatus(sessionId: string): Promise<GitStatus | null> {
    // Create abort controller for this operation
    const abortController = new AbortController();
    this.abortControllers.get(sessionId)?.abort();
    this.abortControllers.set(sessionId, abortController);
    
    try {
      const session = await this.sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return null;
      }
      
      if (isHomeDirectory(session.worktreePath)) {
        this.logger?.warn(`[GitStatus] ${HOME_GIT_SCAN_WARNING}`);
        return { state: 'unknown', lastChecked: new Date().toISOString() };
      }

      // Check if operation was cancelled
      if (abortController.signal.aborted) {
        return null;
      }
      
      this.gitLogger.logSessionFetch(sessionId, false);

      const ctx = this.sessionManager.getProjectContext(sessionId);
      if (!ctx) {
        return null;
      }

      // Use fast plumbing commands for initial checks
      const quickStatus = await this.dependencies.fastCheckWorkingDirectory(session.worktreePath, ctx.commandRunner.wslContext);
      const hasUncommittedChanges = quickStatus.hasModified || quickStatus.hasStaged;
      const hasUntrackedFiles = quickStatus.hasUntracked;
      const hasMergeConflicts = quickStatus.hasConflicts;

      // Get uncommitted changes details only if needed
      let uncommittedDiff = { stats: { filesChanged: 0, additions: 0, deletions: 0 } };
      if (hasUncommittedChanges) {
        // Use fast diff stats instead of full diff capture when possible
        const quickStats = await this.dependencies.fastGetDiffStats(session.worktreePath, ctx.commandRunner.wslContext);
        uncommittedDiff = {
          stats: {
            filesChanged: quickStats.filesChanged,
            additions: quickStats.additions,
            deletions: quickStats.deletions
          }
        };
      }

      // Get ahead/behind status using fast plumbing command
      const comparisonBranch = await this.worktreeManager.getSessionComparisonBranch(session, ctx);
      const { ahead, behind } = await this.dependencies.fastGetAheadBehind(session.worktreePath, comparisonBranch, ctx.commandRunner.wslContext);

      // Get total additions/deletions for all commits in the branch (compared to comparison branch)
      let totalCommitAdditions = 0;
      let totalCommitDeletions = 0;
      let totalCommitFilesChanged = 0;
      if (ahead > 0) {
        // Use git diff --shortstat for commit statistics
        try {
          const statLine = (await ctx.commandRunner.execAsync(`git diff --shortstat ${comparisonBranch}...HEAD`, session.worktreePath, { silent: true })).stdout.trim();
          if (statLine) {
            const filesMatch = statLine.match(/(\d+) files? changed/);
            const additionsMatch = statLine.match(/(\d+) insertions?\(\+\)/);
            const deletionsMatch = statLine.match(/(\d+) deletions?\(-\)/);
            
            totalCommitFilesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
            totalCommitAdditions = additionsMatch ? parseInt(additionsMatch[1], 10) : 0;
            totalCommitDeletions = deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0;
          }
        } catch {
          // Keep defaults of 0 if command fails
        }
      }

      // Determine the overall state and secondary states
      let state: GitStatus['state'] = 'clean';
      const secondaryStates: GitStatus['secondaryStates'] = [];
      
      // Priority order for primary state: conflict > diverged > modified > ahead > behind > untracked > clean
      if (hasMergeConflicts) {
        state = 'conflict';
      } else if (ahead > 0 && behind > 0) {
        state = 'diverged';
      } else if (hasUncommittedChanges) {
        state = 'modified';
        if (ahead > 0) secondaryStates.push('ahead');
        if (behind > 0) secondaryStates.push('behind');
      } else if (ahead > 0) {
        state = 'ahead';
        if (hasUntrackedFiles) secondaryStates.push('untracked');
      } else if (behind > 0) {
        state = 'behind';
        if (hasUncommittedChanges) secondaryStates.push('modified');
        if (hasUntrackedFiles) secondaryStates.push('untracked');
      } else if (hasUntrackedFiles) {
        state = 'untracked';
      }
      
      // IMPORTANT: Even if state is 'clean', we still want to show commit count
      // A 'clean' branch can still have commits not in main!

      // Determine if ready to merge (ahead with no uncommitted changes or untracked files)
      const isReadyToMerge = ahead > 0 && !hasUncommittedChanges && !hasUntrackedFiles && behind === 0;

      // Get total number of commits in the branch
      let totalCommits = ahead;
      try {
        const countStr = (await ctx.commandRunner.execAsync(`git rev-list --count ${comparisonBranch}..HEAD`, session.worktreePath, { silent: true })).stdout.trim();
        totalCommits = parseInt(countStr, 10) || ahead;
      } catch {
        // Keep default of ahead if command fails
      }

      const result = {
        state,
        ahead: ahead > 0 ? ahead : undefined,
        behind: behind > 0 ? behind : undefined,
        additions: uncommittedDiff.stats.additions > 0 ? uncommittedDiff.stats.additions : undefined,
        deletions: uncommittedDiff.stats.deletions > 0 ? uncommittedDiff.stats.deletions : undefined,
        filesChanged: uncommittedDiff.stats.filesChanged > 0 ? uncommittedDiff.stats.filesChanged : undefined,
        lastChecked: new Date().toISOString(),
        isReadyToMerge,
        hasUncommittedChanges,
        hasUntrackedFiles,
        secondaryStates: secondaryStates.length > 0 ? secondaryStates : undefined,
        // Include commit statistics if ahead of main
        commitAdditions: totalCommitAdditions > 0 ? totalCommitAdditions : undefined,
        commitDeletions: totalCommitDeletions > 0 ? totalCommitDeletions : undefined,
        commitFilesChanged: totalCommitFilesChanged > 0 ? totalCommitFilesChanged : undefined,
        // Total commits in branch
        totalCommits: totalCommits > 0 ? totalCommits : undefined
      };
      
      if (abortController.signal.aborted) return null;
      this.gitLogger.logSessionSuccess(sessionId);
      return result;
    } catch (error) {
      
      // Check if this was a cancellation
      if (abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        this.gitLogger.logSessionFetch(sessionId, true); // cancelled
        return null;
      }
      
      this.gitLogger.logSessionError(sessionId, error instanceof Error ? error : new Error(String(error)));
      return {
        state: 'unknown',
        lastChecked: new Date().toISOString()
      };
    } finally {
      if (this.abortControllers.get(sessionId) === abortController) {
        this.abortControllers.delete(sessionId);
      }
    }
  }

  /**
   * Update cache with new status
   */
  private updateCache(sessionId: string, status: GitStatus): GitStatus {
    const statusToStore = this.mergePreservedPrFields(sessionId, status);
    const previousStatus = this.cache[sessionId]?.status;
    const hasChanged = !previousStatus || JSON.stringify(previousStatus) !== JSON.stringify(statusToStore);
    const lastChecked = Date.now();
    
    this.cache[sessionId] = {
      status: statusToStore,
      lastChecked
    };
    this.persistCachedStatus(sessionId, statusToStore, lastChecked);

    // Only emit event if status actually changed
    if (hasChanged) {
      this.emitThrottled(sessionId, 'updated', statusToStore);
    }
    return statusToStore;
  }

  private mergePreservedPrFields(sessionId: string, nextStatus: GitStatus): GitStatus {
    if (nextStatus.prNumber !== undefined) return nextStatus;

    const previousStatus = this.cache[sessionId]?.status;
    if (previousStatus?.prNumber === undefined) return nextStatus;

    return {
      ...nextStatus,
      prNumber: previousStatus.prNumber,
      prUrl: previousStatus.prUrl,
      prTitle: previousStatus.prTitle,
      prState: previousStatus.prState,
      prIsDraft: previousStatus.prIsDraft,
      prBody: previousStatus.prBody,
    };
  }

  private clearPrFields(status: GitStatus): GitStatus {
    const cleared = { ...status };
    for (const field of PR_FIELDS) {
      delete cleared[field];
    }
    return cleared;
  }

  private shouldSchedulePrEnrichment(status: GitStatus): boolean {
    return Boolean(
      status.prNumber ||
      status.ahead ||
      status.isReadyToMerge ||
      status.commitFilesChanged ||
      status.commitAdditions ||
      status.commitDeletions ||
      status.filesChanged ||
      status.additions ||
      status.deletions
    );
  }

  /**
   * Clear cache for a session
   */
  clearSessionCache(sessionId: string): void {
    delete this.cache[sessionId];

    // L5: drain pendingEvents. Key is plain sessionId
    // (verified at line 906 where it is set).
    this.pendingEvents.delete(sessionId);

    // Settle callers waiting for a debounced refresh
    this.cancelPendingRefresh(sessionId);

    // L5: drain abortControllers
    const ac = this.abortControllers.get(sessionId);
    if (ac) {
      ac.abort();
      this.abortControllers.delete(sessionId);
    }

    const prTimer = this.prEnrichmentTimers.get(sessionId);
    if (prTimer) {
      clearTimeout(prTimer);
      this.prEnrichmentTimers.delete(sessionId);
    }

    try {
      this.databaseService?.deleteSessionGitStatusCache(sessionId);
    } catch (error) {
      this.logger?.error(`[GitStatus] Failed to delete persisted status cache for ${sessionId}:`, error instanceof Error ? error : new Error(String(error)));
    }

    // L3: stop the file watcher for this session. No-op for
    // non-active sessions (they never had a watcher started).
    this.fileWatcher.stopWatching(sessionId);
  }

  /**
   * Clear all cached status
   */
  clearAllCache(): void {
    this.cache = {};
    this.prEnrichmentTimers.forEach(timer => clearTimeout(timer));
    this.prEnrichmentTimers.clear();
    try {
      this.databaseService?.clearSessionGitStatusCache();
    } catch (error) {
      this.logger?.error('[GitStatus] Failed to clear persisted status cache:', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Emit a throttled event to prevent UI flooding
   * @param sessionId The session ID
   * @param type The event type (loading or updated)
   * @param data Optional data for updated events
   */
  private emitThrottled(sessionId: string, type: 'loading' | 'updated', data?: GitStatus): void {
    // Store the pending event
    this.pendingEvents.set(sessionId, { type, data });
    
    // If we don't have a throttle timer, start one
    if (!this.eventThrottleTimer) {
      this.eventThrottleTimer = setTimeout(() => {
        // Batch emit all pending events
        const eventsToEmit = new Map(this.pendingEvents);
        this.pendingEvents.clear();
        this.eventThrottleTimer = null;
        
        // Group events by type for batch emission
        const loadingEvents: string[] = [];
        const updatedEvents: Array<{ sessionId: string; status: GitStatus }> = [];
        
        eventsToEmit.forEach((event, id) => {
          if (event.type === 'loading') {
            loadingEvents.push(id);
          } else if (event.type === 'updated' && event.data) {
            updatedEvents.push({ sessionId: id, status: event.data });
          }
        });
        
        // Emit batch events
        if (loadingEvents.length > 0) {
          this.emit('git-status-loading-batch', loadingEvents);
        }
        if (updatedEvents.length > 0) {
          this.emit('git-status-updated-batch', updatedEvents);
        }
        
        // Also emit individual events for backward compatibility
        eventsToEmit.forEach((event, id) => {
          if (event.type === 'loading') {
            this.emit('git-status-loading', id);
          } else if (event.type === 'updated' && event.data) {
            this.emit('git-status-updated', id, event.data);
          }
        });
      }, this.EVENT_THROTTLE_MS);
    }
  }

  /**
   * Execute an operation with concurrency limiting
   * @param operation The operation to execute
   */
  private async executeWithLimit<T>(operation: () => Promise<T>): Promise<T> {
    // Wait if we're at the limit
    while (this.activeOperations >= this.MAX_CONCURRENT_OPERATIONS) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    this.activeOperations++;
    try {
      return await operation();
    } finally {
      this.activeOperations--;
      
      // Process queued operations
      if (this.operationQueue.length > 0) {
        const nextOp = this.operationQueue.shift();
        if (nextOp) {
          nextOp().catch(error => {
            this.logger?.error('[GitStatus] Queued operation failed:', error instanceof Error ? error : new Error(String(error)));
          });
        }
      }
    }
  }

  private async executePrEnrichmentWithLimit<T>(operation: () => Promise<T>): Promise<T> {
    while (this.activePrEnrichmentOperations >= this.MAX_CONCURRENT_PR_ENRICHMENT) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    this.activePrEnrichmentOperations++;
    try {
      return await operation();
    } finally {
      this.activePrEnrichmentOperations--;
    }
  }
}
