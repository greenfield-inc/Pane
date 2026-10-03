import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PullRequestManager } from '../services/pullRequestManager';
import type { CreatePullRequestRequest } from '../../../shared/types/pullRequest';

export const DAEMON_PULL_REQUEST_CHANNELS = [
  'pr:get-draft',
  'pr:create',
  'pr:get-checks',
  'pr:list-base-branches',
  'pr:get-changes',
  'pr:get-diff',
  'pr:get-status',
] as const;

/**
 * Opening pull requests from a session.
 *
 * Daemon-owned: the branch, its remote and the `gh` binary all live on the
 * machine that runs the agents, so a remote runtime must answer these itself
 * rather than have the laptop push a branch it does not have.
 */
export function registerPullRequestHandlers(
  ipcMain: IpcMain,
  { sessionManager, worktreeManager, gitStatusManager }: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const pullRequestManager = new PullRequestManager();

  /**
   * Resolve the pieces a session needs for any pull request operation.
   *
   * The comparison branch is the one the session was branched from, which is
   * what a pull request should target — not the project's main branch, which
   * may be something else entirely for a stacked session.
   */
  const resolveContext = async (sessionId: string) => {
    const session = await sessionManager.getSession(sessionId);
    if (!session?.worktreePath) throw new Error('Session or worktree path not found');
    if (session.archived) throw new Error('This session is archived');

    const ctx = sessionManager.getProjectContext(sessionId);
    if (!ctx?.project?.path) throw new Error('Project context not found for session');

    const baseBranch = await worktreeManager.getSessionComparisonBranch(session, ctx);

    return { session, ctx, baseBranch };
  };

  commandRegistry.register('pr:get-draft', async (sessionId: string) => {
    try {
      const { session, ctx, baseBranch } = await resolveContext(sessionId);
      const data = await pullRequestManager.getDraft(
        session.worktreePath,
        ctx.project.path,
        baseBranch,
        ctx.commandRunner,
      );
      return { success: true, data };
    } catch (error) {
      console.error('[PullRequest] Failed to build draft:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to prepare the pull request',
      };
    }
  });

  commandRegistry.register('pr:create', async (request: CreatePullRequestRequest) => {
    try {
      if (!request?.title?.trim()) return { success: false, error: 'A title is required' };
      if (!request?.targetRepo) return { success: false, error: 'A target repository is required' };

      const { session, ctx } = await resolveContext(request.sessionId);
      const data = await pullRequestManager.create(
        request,
        session.worktreePath,
        ctx.project.path,
        ctx.commandRunner,
      );

      // The session list shows pull request state from a cache with a 20s miss
      // TTL. Drop it so the new pull request appears now, not eventually.
      gitStatusManager.invalidatePrCache(ctx.project.path);
      void gitStatusManager.refreshSessionGitStatus(request.sessionId, false).catch(() => {});

      return { success: true, data };
    } catch (error) {
      console.error('[PullRequest] Failed to create pull request:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create the pull request',
      };
    }
  });

  commandRegistry.register('pr:get-status', async (sessionId: string, repo: string, number: number) => {
    try {
      const { ctx } = await resolveContext(sessionId);
      const data = await pullRequestManager.getStatus(repo, Number(number), ctx.project.path, ctx.commandRunner);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read the pull request',
      };
    }
  });

  commandRegistry.register('pr:get-checks', async (sessionId: string, repo: string, number: number) => {
    try {
      const { ctx } = await resolveContext(sessionId);
      const data = await pullRequestManager.getChecks(repo, Number(number), ctx.project.path, ctx.commandRunner);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read pull request checks',
      };
    }
  });

  /** Base candidates for a repository — reloaded when the target changes. */
  commandRegistry.register('pr:list-base-branches', async (sessionId: string, repo: string) => {
    try {
      const { ctx } = await resolveContext(sessionId);
      const data = await pullRequestManager.listBaseBranches(repo, ctx.project.path, ctx.commandRunner);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list branches',
      };
    }
  });

  /** Which files the pull request would carry — counts only, no patch. */
  commandRegistry.register('pr:get-changes', async (sessionId: string, baseBranch?: string) => {
    try {
      const { session, ctx, baseBranch: fallback } = await resolveContext(sessionId);
      const data = await pullRequestManager.getChanges(
        session.worktreePath,
        baseBranch?.trim() || fallback,
        ctx.commandRunner,
      );
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list the changed files',
      };
    }
  });

  /** The patch itself, loaded only when the user opens the diff. */
  commandRegistry.register('pr:get-diff', async (sessionId: string, baseBranch?: string) => {
    try {
      const { session, ctx, baseBranch: fallback } = await resolveContext(sessionId);
      const data = await pullRequestManager.getDiff(
        session.worktreePath,
        baseBranch?.trim() || fallback,
        ctx.commandRunner,
      );
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read the diff',
      };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_PULL_REQUEST_CHANNELS);
}
