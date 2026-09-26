import os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { GitStatusManager } from '../gitStatusManager';
import type { fastCheckWorkingDirectory as fastCheckWorkingDirectoryImpl, fastGetAheadBehind as fastGetAheadBehindImpl, fastGetDiffStats as fastGetDiffStatsImpl } from '../gitPlumbingCommands';
import type { SessionManager } from '../sessionManager';
import type { WorktreeManager } from '../worktreeManager';
import type { GitDiffManager } from '../gitDiffManager';
import type { Logger } from '../../utils/logger';
import type { GitStatus, Session } from '../../types/session';
import type { GitIndexStatus } from '../gitPlumbingCommands';
import type { CommandRunner } from '../../utils/commandRunner';
import type { DatabaseService } from '../../database/database';

// Type for accessing private members in tests
interface GitStatusManagerPrivates {
  fetchGitStatus(sessionId: string): Promise<GitStatus | null>;
  processInitialLoadQueue(): Promise<void>;
  fetchPrForSession(
    branchName: string,
    projectPath: string,
    commandRunner: CommandRunner
  ): Promise<{ prNumber?: number; prUrl?: string; prTitle?: string; prState?: string; prIsDraft?: boolean; prBody?: string }>;
  enrichWithPrData(sessionId: string): Promise<void>;
  updateCache(sessionId: string, status: GitStatus): GitStatus;
  schedulePrEnrichment(sessionId: string, immediate?: boolean): void;
  cache: Record<string, { status: GitStatus; lastChecked: number }>;
  initialLoadQueue: string[];
  prCache: Map<string, { prNumber?: number; prUrl?: string; prTitle?: string; prState?: string; prIsDraft?: boolean; prBody?: string; fetchedAt: number }>;
  activeSessionId: string | null;
}

function managerPrivates(manager: GitStatusManager): GitStatusManagerPrivates {
  // SAFETY: These tests intentionally exercise GitStatusManager's private state;
  // the interface above mirrors only the members used by this test suite.
  return manager as GitStatusManagerPrivates;
}

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: Tests supply the subset invoked by each scenario, and Vitest fails
  // immediately if the subject reaches an unstubbed contract member.
  return implementation as Contract;
}

function requireValue<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) {
    throw new Error('Expected test subject to return a value');
  }
  return value;
}

const fastCheckWorkingDirectory = vi.fn<typeof fastCheckWorkingDirectoryImpl>();
const fastGetAheadBehind = vi.fn<typeof fastGetAheadBehindImpl>();
const fastGetDiffStats = vi.fn<typeof fastGetDiffStatsImpl>();

const mockSession = {
  id: 'test-session',
  worktreePath: '/test/worktree',
  archived: false,
  projectId: 1,
};

const mockProject = {
  id: 1,
  path: '/test/project',
};

const projectGitOutput = vi.fn<(command: string, cwd: string) => string>();
const projectGithubCommand = vi.fn<CommandRunner['execAsync']>();

const mockProjectContext = {
  project: mockProject,
  pathResolver: {},
  commandRunner: { execAsync: vi.fn<CommandRunner['execAsync']>(), wslContext: null },
};

const cleanIndexStatus: GitIndexStatus = {
  hasModified: false,
  hasStaged: false,
  hasUntracked: false,
  hasConflicts: false,
};

describe('GitStatusManager', () => {
  let gitStatusManager: GitStatusManager;
  let mockSessionManager: SessionManager;
  let mockWorktreeManager: WorktreeManager;
  let mockGitDiffManager: GitDiffManager;
  let mockLogger: Logger;
  let mockDatabaseService: Partial<Pick<
    DatabaseService,
    'getAllSessionGitStatusCache' |
    'saveSessionGitStatusCache' |
    'deleteSessionGitStatusCache' |
    'clearSessionGitStatusCache'
  >> & {
    getAllSessionGitStatusCache: Mock;
    saveSessionGitStatusCache: Mock;
    deleteSessionGitStatusCache: Mock;
    clearSessionGitStatusCache: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionManager = partialMock<SessionManager>({
      getSession: vi.fn().mockResolvedValue(mockSession),
      getProjectContext: vi.fn().mockReturnValue(mockProjectContext),
      getProjectForSession: vi.fn().mockReturnValue(mockProject),
      getAllSessions: vi.fn().mockResolvedValue([]),
    });

    mockWorktreeManager = partialMock<WorktreeManager>({
      getProjectMainBranch: vi.fn().mockResolvedValue('main'),
      getSessionComparisonBranch: vi.fn().mockResolvedValue('main'),
    });

    mockGitDiffManager = partialMock<GitDiffManager>({});

    mockLogger = partialMock<Logger>({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
    });

    mockDatabaseService = {
      getAllSessionGitStatusCache: vi.fn().mockReturnValue([]),
      saveSessionGitStatusCache: vi.fn(),
      deleteSessionGitStatusCache: vi.fn(),
      clearSessionGitStatusCache: vi.fn(),
    };

    gitStatusManager = new GitStatusManager(
      mockSessionManager,
      mockWorktreeManager,
      mockGitDiffManager,
      mockLogger,
      partialMock<DatabaseService>(mockDatabaseService),
      { fastCheckWorkingDirectory, fastGetAheadBehind, fastGetDiffStats },
    );

    // Default: no uncommitted changes, no ahead/behind
    vi.mocked(fastCheckWorkingDirectory).mockResolvedValue(cleanIndexStatus);
    vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 0 });
    vi.mocked(fastGetDiffStats).mockResolvedValue({ additions: 0, deletions: 0, filesChanged: 0 });

    mockProjectContext.commandRunner.execAsync.mockImplementation(async (command, cwd, options) => {
      if (command.startsWith('git ')) return { stdout: projectGitOutput(command, cwd), stderr: '' };
      return projectGithubCommand(command, cwd, options);
    });
    // Git and GitHub CLI outputs have independent fixtures.
    vi.mocked(projectGitOutput).mockReturnValue('');
  });

  describe('debounced refresh callers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      gitStatusManager.stopPolling();
      vi.useRealTimers();
    });

    it('settles every caller when rapid refresh requests share one batch', async () => {
      const results: Array<GitStatus | null> = [];
      void gitStatusManager.refreshSessionGitStatus('test-session').then(status => results.push(status));
      await vi.advanceTimersByTimeAsync(1000);
      void gitStatusManager.refreshSessionGitStatus('test-session').then(status => results.push(status));
      await vi.advanceTimersByTimeAsync(2000);
      expect(results).toHaveLength(2);
      expect(results).toEqual([expect.objectContaining({ state: 'clean' }), expect.objectContaining({ state: 'clean' })]);
    });
  });

  describe('refresh lifecycle and changing dirty status', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      gitStatusManager.stopPolling();
      vi.useRealTimers();
    });

    it.each(['cancel', 'clear', 'stop'] as const)('settles pending callers on %s', async action => {
      const results: Array<GitStatus | null> = [];
      void gitStatusManager.refreshSessionGitStatus('test-session').then(status => results.push(status));
      void gitStatusManager.refreshSessionGitStatus('test-session').then(status => results.push(status));
      if (action === 'cancel') gitStatusManager.cancelSessionGitStatus('test-session');
      if (action === 'clear') gitStatusManager.clearSessionCache('test-session');
      if (action === 'stop') gitStatusManager.stopPolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(results).toEqual([null, null]);
    });

    it('updates counts and conflicts while the worktree remains dirty', async () => {
      fastCheckWorkingDirectory.mockResolvedValue({ ...cleanIndexStatus, hasModified: true });
      fastGetDiffStats.mockResolvedValue({ additions: 2, deletions: 1, filesChanged: 1 });
      const initial = gitStatusManager.refreshSessionGitStatus('test-session');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await initial).toMatchObject({ state: 'modified', additions: 2 });

      fastCheckWorkingDirectory.mockResolvedValue({ ...cleanIndexStatus, hasModified: true, hasConflicts: true });
      fastGetDiffStats.mockResolvedValue({ additions: 9, deletions: 3, filesChanged: 2 });
      fastGetAheadBehind.mockResolvedValue({ ahead: 2, behind: 0 });
      const updated = gitStatusManager.refreshSessionGitStatus('test-session');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await updated).toMatchObject({ state: 'conflict', additions: 9, deletions: 3, filesChanged: 2, ahead: 2 });
    });
  });

  describe('fetchGitStatus via getGitStatus (cache miss scenarios)', () => {
    it('discards a status read cancelled while Git is running', async () => {
      let finish = (_status: GitIndexStatus): void => { throw new Error('Git not started'); };
      fastCheckWorkingDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = managerPrivates(gitStatusManager).fetchGitStatus('test-session');
      await new Promise(resolve => setImmediate(resolve));
      gitStatusManager.cancelSessionGitStatus('test-session');
      finish(cleanIndexStatus);

      expect(await pending).toBeNull();
      expect(mockDatabaseService.saveSessionGitStatusCache).not.toHaveBeenCalled();
    });

    it('skips home-directory scans on initial load and focus refresh', async () => {
      vi.mocked(mockSessionManager.getSession).mockResolvedValue(partialMock<Session>({
        ...mockSession, worktreePath: os.homedir(),
      }));
      const initial = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');
      expect(initial?.state).toBe('unknown');
      managerPrivates(gitStatusManager).updateCache('test-session', { state: 'clean' });
      const refreshed = await gitStatusManager.refreshSessionGitStatus('test-session');
      expect(refreshed?.state).toBe('unknown');
      expect(fastCheckWorkingDirectory).not.toHaveBeenCalled();
      expect(projectGitOutput).not.toHaveBeenCalled();
      gitStatusManager.stopPolling();
    });

    it('returns clean state when no changes, no ahead/behind, no untracked', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue(cleanIndexStatus);
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 0 });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(status).not.toBeNull();
      expect(requireValue(status).state).toBe('clean');
      expect(requireValue(status).ahead).toBeUndefined();
      expect(requireValue(status).behind).toBeUndefined();
      expect(requireValue(status).hasUncommittedChanges).toBe(false);
      expect(requireValue(status).hasUntrackedFiles).toBe(false);
    });

    it('returns modified state when uncommitted changes exist', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue({
        hasModified: true,
        hasStaged: false,
        hasUntracked: false,
        hasConflicts: false,
      });
      vi.mocked(fastGetDiffStats).mockResolvedValue({ additions: 15, deletions: 5, filesChanged: 3 });
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 0 });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(requireValue(status).state).toBe('modified');
      expect(requireValue(status).hasUncommittedChanges).toBe(true);
      expect(requireValue(status).filesChanged).toBe(3);
      expect(requireValue(status).additions).toBe(15);
      expect(requireValue(status).deletions).toBe(5);
    });

    it('returns ahead state when commits ahead of main', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue(cleanIndexStatus);
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 3, behind: 0 });
      vi.mocked(projectGitOutput).mockImplementation((cmd: string) => {
        if (cmd.includes('diff --shortstat')) {
          return ' 5 files changed, 20 insertions(+), 10 deletions(-)';
        }
        if (cmd.includes('rev-list --count')) {
          return '3';
        }
        return '';
      });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(requireValue(status).state).toBe('ahead');
      expect(requireValue(status).ahead).toBe(3);
      expect(requireValue(status).totalCommits).toBe(3);
      expect(requireValue(status).isReadyToMerge).toBe(true);
      expect(requireValue(status).commitFilesChanged).toBe(5);
      expect(requireValue(status).commitAdditions).toBe(20);
      expect(requireValue(status).commitDeletions).toBe(10);
    });

    it('returns behind state when commits behind main', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue(cleanIndexStatus);
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 5 });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(requireValue(status).state).toBe('behind');
      expect(requireValue(status).behind).toBe(5);
      expect(requireValue(status).ahead).toBeUndefined();
    });

    it('returns diverged state when both ahead and behind', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue(cleanIndexStatus);
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 2, behind: 3 });
      vi.mocked(projectGitOutput).mockImplementation((cmd: string) => {
        if (cmd.includes('diff --shortstat')) {
          return ' 4 files changed, 15 insertions(+), 8 deletions(-)';
        }
        if (cmd.includes('rev-list --count')) {
          return '2';
        }
        return '';
      });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(requireValue(status).state).toBe('diverged');
      expect(requireValue(status).ahead).toBe(2);
      expect(requireValue(status).behind).toBe(3);
    });

    it('returns conflict state when merge conflicts exist', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue({
        hasModified: false,
        hasStaged: false,
        hasUntracked: false,
        hasConflicts: true,
      });
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 0 });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(requireValue(status).state).toBe('conflict');
    });

    it('returns untracked state when only untracked files exist', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue({
        hasModified: false,
        hasStaged: false,
        hasUntracked: true,
        hasConflicts: false,
      });
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 0 });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(requireValue(status).state).toBe('untracked');
      expect(requireValue(status).hasUntrackedFiles).toBe(true);
    });

    it('returns null when session is not found', async () => {
      vi.mocked(mockSessionManager.getSession).mockResolvedValue(null);

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(status).toBeNull();
    });

    it('sets modified as primary state and ahead as secondary when uncommitted changes and ahead', async () => {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue({
        hasModified: true,
        hasStaged: false,
        hasUntracked: false,
        hasConflicts: false,
      });
      vi.mocked(fastGetDiffStats).mockResolvedValue({ additions: 5, deletions: 2, filesChanged: 2 });
      vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 2, behind: 0 });
      vi.mocked(projectGitOutput).mockImplementation((cmd: string) => {
        if (cmd.includes('diff --shortstat')) {
          return ' 3 files changed, 10 insertions(+), 5 deletions(-)';
        }
        if (cmd.includes('rev-list --count')) {
          return '2';
        }
        return '';
      });

      const status = await managerPrivates(gitStatusManager).fetchGitStatus('test-session');

      expect(requireValue(status).state).toBe('modified');
      expect(requireValue(status).secondaryStates).toContain('ahead');
    });
  });

  describe('caching', () => {
    it('returns cached status within TTL without re-fetching', async () => {
      const cachedStatus: GitStatus = { state: 'clean', lastChecked: new Date().toISOString() };
      managerPrivates(gitStatusManager).cache['test-session'] = {
        status: cachedStatus,
        lastChecked: Date.now(),
      };

      const fetchSpy = vi.spyOn(
        managerPrivates(gitStatusManager),
        'fetchGitStatus'
      );

      const result = await gitStatusManager.getGitStatus('test-session');

      expect(result).toEqual(cachedStatus);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches fresh status after TTL has expired', async () => {
      const expiredStatus: GitStatus = { state: 'clean', lastChecked: new Date().toISOString() };
      managerPrivates(gitStatusManager).cache['test-session'] = {
        status: expiredStatus,
        lastChecked: Date.now() - 10000, // 10s ago — beyond the 5s TTL
      };

      const freshStatus: GitStatus = { state: 'modified', lastChecked: new Date().toISOString() };
      vi.spyOn(
        managerPrivates(gitStatusManager),
        'fetchGitStatus'
      ).mockResolvedValue(freshStatus);

      const result = await gitStatusManager.getGitStatus('test-session');

      expect(result).toEqual(freshStatus);
    });
  });

  describe('persistent cache', () => {
    it('hydrates cached statuses from the database on construction', () => {
      const cachedStatus: GitStatus = { state: 'ahead', ahead: 1, lastChecked: '2026-01-01T00:00:00.000Z' };
      mockDatabaseService.getAllSessionGitStatusCache.mockReturnValue([
        { sessionId: 'cached-session', gitStatus: cachedStatus, lastChecked: 1234 },
      ]);

      const manager = new GitStatusManager(
        mockSessionManager,
        mockWorktreeManager,
        mockGitDiffManager,
        mockLogger,
        partialMock<DatabaseService>(mockDatabaseService),
      );
      const privates = managerPrivates(manager);

      expect(privates.cache['cached-session']).toEqual({
        status: cachedStatus,
        lastChecked: 1234,
      });
    });

    it('persists successful cache updates', () => {
      const privates = managerPrivates(gitStatusManager);
      const status: GitStatus = { state: 'modified', hasUncommittedChanges: true };

      privates.updateCache('test-session', status);

      expect(mockDatabaseService.saveSessionGitStatusCache).toHaveBeenCalledWith(
        'test-session',
        status,
        expect.any(Number),
      );
    });

    it('preserves cached PR fields when local status refresh has no PR fields', () => {
      const privates = managerPrivates(gitStatusManager);
      privates.cache['test-session'] = {
        status: {
          state: 'ahead',
          ahead: 1,
          prNumber: 12,
          prUrl: 'https://github.com/example/repo/pull/12',
          prTitle: 'Ready review',
          prState: 'OPEN',
          prIsDraft: true,
          prBody: 'Body',
        },
        lastChecked: Date.now(),
      };

      const updated = privates.updateCache('test-session', {
        state: 'ahead',
        ahead: 2,
        commitAdditions: 20,
      });

      expect(updated).toMatchObject({
        state: 'ahead',
        ahead: 2,
        commitAdditions: 20,
        prNumber: 12,
        prUrl: 'https://github.com/example/repo/pull/12',
        prTitle: 'Ready review',
        prState: 'OPEN',
        prIsDraft: true,
        prBody: 'Body',
      });
      expect(mockDatabaseService.saveSessionGitStatusCache).toHaveBeenLastCalledWith(
        'test-session',
        expect.objectContaining({ prNumber: 12, ahead: 2 }),
        expect.any(Number),
      );
    });
  });

  describe('PR enrichment', () => {
    it('caches PR misses for 20 seconds', async () => {
      const privates = managerPrivates(gitStatusManager);
      const commandRunner = mockProjectContext.commandRunner;
      vi.mocked(commandRunner.execAsync).mockResolvedValue({ stdout: '[]' });

      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);
      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);

      expect(commandRunner.execAsync).toHaveBeenCalledTimes(1);

      privates.prCache.set(`${mockProject.path}:feature-branch`, { fetchedAt: Date.now() - 20_001 });

      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);

      expect(commandRunner.execAsync).toHaveBeenCalledTimes(2);
    });

    it('keeps PR hits cached longer than misses', async () => {
      const privates = managerPrivates(gitStatusManager);
      const commandRunner = mockProjectContext.commandRunner;
      vi.mocked(commandRunner.execAsync).mockResolvedValue({
        stdout: JSON.stringify([{
          number: 12,
          url: 'https://github.com/example/repo/pull/12',
          title: 'Ready review',
          state: 'OPEN',
          isDraft: true,
          body: 'Body',
        }]),
      });

      await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);
      privates.prCache.set(`${mockProject.path}:feature-branch`, {
        prNumber: 12,
        prUrl: 'https://github.com/example/repo/pull/12',
        prTitle: 'Ready review',
        prState: 'OPEN',
        prIsDraft: true,
        prBody: 'Body',
        fetchedAt: Date.now() - 20_001,
      });

      const result = await privates.fetchPrForSession('feature-branch', mockProject.path, commandRunner);

      expect(commandRunner.execAsync).toHaveBeenCalledTimes(1);
      expect(commandRunner.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('isDraft'),
        mockProject.path,
        { timeout: 5000 }
      );
      expect(result.prNumber).toBe(12);
      expect(result.prIsDraft).toBe(true);
    });

    it('invalidates active-session PR misses when the app regains focus', async () => {
      const privates = managerPrivates(gitStatusManager);
      privates.activeSessionId = 'test-session';
      privates.prCache.set(`${mockProject.path}:feature-branch`, { fetchedAt: Date.now() });
      vi.mocked(projectGitOutput).mockReturnValue('feature-branch\n');
      const refreshSpy = vi
        .spyOn(gitStatusManager, 'refreshSessionGitStatus')
        .mockResolvedValue({ state: 'clean', lastChecked: new Date().toISOString() });

      gitStatusManager.handleVisibilityChange(false);
      await new Promise(resolve => setImmediate(resolve));

      expect(privates.prCache.has(`${mockProject.path}:feature-branch`)).toBe(false);
      expect(refreshSpy).toHaveBeenCalledWith('test-session', false);
    });

    it('uses the checked-out git branch when enriching PR data', async () => {
      const privates = managerPrivates(gitStatusManager);
      privates.cache['test-session'] = {
        status: { state: 'ahead', lastChecked: new Date().toISOString() },
        lastChecked: Date.now(),
      };
      vi.mocked(mockSessionManager.getSession).mockResolvedValue({
        ...mockSession,
        worktreePath: '/test/worktrees/not-the-branch',
      });
      vi.mocked(projectGitOutput).mockReturnValue('real-feature-branch\n');
      projectGithubCommand.mockResolvedValue({
        stderr: '',
        stdout: JSON.stringify([{
          number: 12,
          url: 'https://github.com/example/repo/pull/12',
          title: 'Ready review',
          state: 'OPEN',
          isDraft: true,
          body: 'Body',
        }]),
      });

      const updated = new Promise<GitStatus>((resolve) => {
        gitStatusManager.once('git-status-updated', (_sessionId, status) => resolve(status));
      });
      void privates.enrichWithPrData('test-session');
      const status = await updated;

      expect(projectGitOutput).toHaveBeenCalledWith(
        'git branch --show-current',
        '/test/worktrees/not-the-branch'
      );
      expect(mockProjectContext.commandRunner.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('real-feature-branch'),
        mockProject.path,
        { timeout: 5000 }
      );
      expect(projectGithubCommand.mock.calls[0][0]).not.toContain('not-the-branch');
      expect(status.prNumber).toBe(12);
      expect(status.prUrl).toBe('https://github.com/example/repo/pull/12');
      expect(status.prIsDraft).toBe(true);
    });

    it('clears cached PR fields on a confirmed PR miss', async () => {
      const privates = managerPrivates(gitStatusManager);
      privates.cache['test-session'] = {
        status: {
          state: 'ahead',
          ahead: 1,
          prNumber: 12,
          prUrl: 'https://github.com/example/repo/pull/12',
          prTitle: 'Ready review',
          prState: 'OPEN',
          prIsDraft: true,
          prBody: 'Body',
        },
        lastChecked: Date.now(),
      };
      vi.mocked(projectGitOutput).mockReturnValue('feature-branch\n');
      projectGithubCommand.mockResolvedValue({ stdout: '[]', stderr: '' });

      const updated = new Promise<GitStatus>((resolve) => {
        gitStatusManager.once('git-status-updated', (_sessionId, status) => resolve(status));
      });
      void privates.enrichWithPrData('test-session');
      const status = await updated;

      expect(status.prNumber).toBeUndefined();
      expect(status.prUrl).toBeUndefined();
      expect(status.prTitle).toBeUndefined();
      expect(status.prState).toBeUndefined();
      expect(status.prIsDraft).toBeUndefined();
      expect(status.prBody).toBeUndefined();
      expect(status.ahead).toBe(1);
      expect(mockDatabaseService.saveSessionGitStatusCache).toHaveBeenLastCalledWith(
        'test-session',
        expect.not.objectContaining({ prNumber: expect.any(Number) }),
        expect.any(Number),
      );
    });

    it('keeps cached PR fields when PR lookup fails', async () => {
      const privates = managerPrivates(gitStatusManager);
      const cachedStatus: GitStatus = {
        state: 'ahead',
        ahead: 1,
        prNumber: 12,
        prUrl: 'https://github.com/example/repo/pull/12',
        prTitle: 'Ready review',
        prState: 'OPEN',
        prIsDraft: true,
        prBody: 'Body',
      };
      privates.cache['test-session'] = {
        status: cachedStatus,
        lastChecked: Date.now(),
      };
      vi.mocked(projectGitOutput).mockReturnValue('feature-branch\n');
      projectGithubCommand.mockRejectedValue(new Error('gh unavailable'));

      await privates.enrichWithPrData('test-session');

      expect(privates.cache['test-session'].status).toEqual(cachedStatus);
      expect(mockDatabaseService.saveSessionGitStatusCache).not.toHaveBeenCalled();
    });

    it('schedules staggered PR enrichment for non-active relevant initial-load status', async () => {
      const privates = managerPrivates(gitStatusManager);
      privates.initialLoadQueue.push('test-session');
      privates.activeSessionId = null;
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const fetchSpy = vi
        .spyOn(privates, 'fetchGitStatus')
        .mockResolvedValue({ state: 'ahead', ahead: 1, isReadyToMerge: true });
      const scheduleSpy = vi
        .spyOn(privates, 'schedulePrEnrichment')
        .mockImplementation(() => {});

      await privates.processInitialLoadQueue();

      expect(fetchSpy).toHaveBeenCalledWith('test-session');
      expect(scheduleSpy).toHaveBeenCalledWith('test-session', false);
      randomSpy.mockRestore();
    });
  });

  describe('lifecycle methods', () => {
    it('startPolling does not throw', () => {
      expect(() => gitStatusManager.startPolling()).not.toThrow();
    });

    it('stopPolling does not throw', () => {
      expect(() => gitStatusManager.stopPolling()).not.toThrow();
    });
  });
});
