import type { IpcMain } from 'electron';
import { hasCommitMessageTitle } from '../../../shared/utils/commitMessage';
import { existsSync } from 'fs';
import { join } from 'path';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { commitGitMessage } from '../utils/gitCommit';
import { getPaneEventSink } from '../core/runtime';
import { panelEventBus } from '../services/panelEventBus';
import { PanelEventType, PanelEvent } from '../../../shared/types/panels';
import type { Session } from '../types/session';
import type { GitCommit, GitGraphCommit } from '../services/gitDiffManager';
import { CommandRunner } from '../utils/commandRunner';
import { getShellPath } from '../utils/shellPath';
import { parseWSLPath, validateWSLAvailable } from '../utils/wslUtils';
import { boundary, decodeBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';
import { registerGitDiffRequestHandlers } from './gitDiffRequests';

// Interface for generic error objects with git-related properties
interface ErrorWithGitContext {
  gitCommand?: string;
  gitCommands?: string[];
  gitOutput?: string;
  workingDirectory?: string;
  projectPath?: string;
  originalError?: { message?: string };
}

function decodeGitError(cause: unknown): ErrorWithGitContext {
  try {
    return decodeBoundary(cause, boundary.object({
      gitCommand: boundary.optional(boundary.string),
      gitCommands: boundary.optional(boundary.array(boundary.string)),
      gitOutput: boundary.optional(boundary.string),
      workingDirectory: boundary.optional(boundary.string),
      projectPath: boundary.optional(boundary.string),
      originalError: boundary.optional(boundary.object({
        message: boundary.optional(boundary.string),
      })),
    }));
  } catch {
    return {};
  }
}

// Interface for raw commit data from worktreeManager
interface RawCommitData {
  hash: string;
  message: string;
  date: string | Date;
  author?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
}


function isValidGitUrl(url: string): boolean {
  // Accept https://, ssh://, and scp-style git@host:path formats
  return /^(https?:\/\/[\w./:@-]+|ssh:\/\/[\w./:@-]+|git@[\w.-]+:[\w./-]+)(\.git)?$/.test(url);
}

function extractRepoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/, '');
  const lastSegment = cleaned.split('/').pop() || cleaned.split(':').pop() || 'repo';
  return lastSegment;
}

const DAEMON_GIT_STATUS_CHANNELS = [
  'sessions:get-executions',
  'sessions:get-execution-diff',
  'sessions:get-git-graph',
  'git:file-status',
  'sessions:git-diff',
  'sessions:get-diff-manifest',
  'sessions:get-file-diff',
  'sessions:check-rebase-conflicts',
  'sessions:has-stash',
  'sessions:get-upstream',
  'sessions:get-remote-branches',
  'sessions:get-last-commits',
  'sessions:has-changes-to-rebase',
  'sessions:get-git-commands',
  'sessions:get-git-status',
  'git:cancel-status-for-project',
  'git:get-github-remote',
] as const;

const DAEMON_GIT_MUTATION_CHANNELS = [
  'sessions:git-commit',
  'sessions:rebase-main-into-worktree',
  'sessions:abort-rebase-and-use-claude',
  'sessions:squash-and-rebase-to-main',
  'sessions:rebase-to-main',
  'sessions:git-pull',
  'sessions:git-push',
  'sessions:git-soft-reset',
  'sessions:git-fetch',
  'sessions:git-stash',
  'sessions:git-stash-pop',
  'sessions:set-upstream',
  'sessions:git-stage-and-commit',
  'git:clone-repo',
] as const;

const DAEMON_GIT_CHANNELS = [
  ...DAEMON_GIT_STATUS_CHANNELS,
  ...DAEMON_GIT_MUTATION_CHANNELS,
] as const;

export function registerGitHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const { sessionManager, gitDiffManager, worktreeManager, claudeCodeManager, gitStatusManager } = services;
  registerGitDiffRequestHandlers(commandRegistry, services);

  // Helper function to emit git operation events to all sessions in a project
  const emitGitOperationToProject = (sessionId: string, eventType: PanelEventType, message: string, details?: JsonObject) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) return;
      
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) return;
      
      // Create a virtual event as if it came from the git system
      const event: PanelEvent = {
        type: eventType,
        source: {
          panelId: 'git-system', // Special panel ID for git operations
          panelType: 'git', // Virtual panel type
          sessionId: sessionId // The session that triggered the operation
        },
        data: {
          message,
          triggeringSessionId: sessionId,
          triggeringSessionName: session.name,
          projectId: project.id,
          ...details
        },
        timestamp: new Date().toISOString()
      };
      
      // Emit the event once to the panel event bus
      // All Claude panels that have subscribed will receive it
      panelEventBus.emitPanelEvent(event);

      // Also forward to renderer so UI components listening for window 'panel:event' receive it
      try {
        getPaneEventSink().send('panel:event', event);
      } catch (ipcError) {
        console.error('[Git] Failed to forward git operation event to renderer:', ipcError);
      }
    } catch (emitError) {
      console.error('[Git] Failed to emit git operation event:', emitError);
    }
  };

  // Helper function to refresh git status after operations that only affect one session
  const refreshGitStatusForSession = async (sessionId: string, isUserInitiated = false) => {
    try {
      await gitStatusManager.refreshSessionGitStatus(sessionId, isUserInitiated);
    } catch {
      // Git status refresh failures are logged by GitStatusManager
    }
  };

  // Helper function to refresh git status for all sessions in a project (e.g. after updating main)
  const refreshGitStatusForProject = async (projectId: number) => {
    try {
      const sessions = await sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived && s.status !== 'error');
      
      // Refresh all sessions in parallel
      await Promise.all(projectSessions.map(session =>
        gitStatusManager.refreshSessionGitStatus(session.id, false).catch(() => {
          // Individual failures are logged by GitStatusManager
        })
      ));
    } catch {
      // Project-level refresh failures are rare and will be logged by GitStatusManager
    }
  };

  const getSessionCommitHistory = async (
    session: Session,
    limit: number = 50
  ): Promise<{
    commits: GitCommit[];
    comparisonBranch: string;
    historySource: 'remote' | 'local' | 'branch';
    limitReached: boolean;
  }> => {
    if (!session.worktreePath) {
      throw new Error('Session has no worktree path');
    }

    const ctx = sessionManager.getProjectContext(session.id);
    if (!ctx) throw new Error('Project context not found for session');

    // Single source of truth for comparison base — respects session.baseBranch when set,
    // falls back to project root current branch for legacy sessions.
    const comparisonBranch = await worktreeManager.getSessionComparisonBranch(session, ctx);

    let commits: GitCommit[] = [];
    let useFallback = false;

    try {
      commits = await gitDiffManager.getCommitHistory(session.worktreePath, limit, comparisonBranch, ctx.commandRunner);
    } catch (error) {
      // Only isMainRepo sessions have a fallback path (raw last-N commits);
      // worktree sessions should propagate the error.
      if (session.isMainRepo) {
        console.warn(`[IPC:git] Falling back to local commit history for session ${session.id}:`, error);
        useFallback = true;
      } else {
        throw error;
      }
    }

    if (useFallback) {
      const fallbackCommits = await worktreeManager.getLastCommits(session.worktreePath, limit, ctx.commandRunner);
      commits = fallbackCommits.map((commit: RawCommitData) => ({
        hash: commit.hash,
        message: commit.message,
        date: new Date(commit.date),
        author: commit.author || 'Unknown',
        stats: {
          additions: commit.additions || 0,
          deletions: commit.deletions || 0,
          filesChanged: commit.filesChanged || 0
        }
      }));
    }

    // historySource: 'branch' when baseBranch was set (the new stable path),
    // 'local' for the isMainRepo fallback path, 'branch' otherwise.
    const historySource: 'remote' | 'local' | 'branch' =
      session.baseBranch ? 'branch' : (useFallback ? 'local' : 'branch');

    const limitReached = commits.length === limit;

    return {
      commits,
      comparisonBranch,
      historySource,
      limitReached
    };
  };

  commandRegistry.register('sessions:get-executions', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const { commits, comparisonBranch, historySource, limitReached } = await getSessionCommitHistory(session, 50);

      // Transform git commits to execution format expected by frontend
      const executions = commits.map((commit, index) => ({
        id: index + 1, // 1-based index for commits
        session_id: sessionId,
        execution_sequence: index + 1,
        after_commit_hash: commit.hash,
        commit_message: commit.message,
        timestamp: commit.date.toISOString(),
        stats_additions: commit.stats.additions,
        stats_deletions: commit.stats.deletions,
        stats_files_changed: commit.stats.filesChanged,
        author: commit.author,
        comparison_branch: comparisonBranch,
        history_source: historySource,
        history_limit_reached: limitReached
      }));

      // Check for uncommitted changes
      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const hasUncommittedChanges = await gitDiffManager.hasChanges(session.worktreePath, ctx.commandRunner);
      if (hasUncommittedChanges) {
        // Get stats for uncommitted changes
        const uncommittedDiff = await gitDiffManager.getDiffManifest(session.worktreePath, { kind: 'working-tree' }, ctx.commandRunner, {
          comparisonBase: () => worktreeManager.getSessionComparisonBranch(session, ctx),
        });
        
        // Add uncommitted changes as execution with id 0
        executions.unshift({
          id: 0,
          session_id: sessionId,
          execution_sequence: 0,
          after_commit_hash: 'UNCOMMITTED',
          commit_message: 'Uncommitted changes',
          timestamp: new Date().toISOString(),
          stats_additions: uncommittedDiff.stats.additions,
          stats_deletions: uncommittedDiff.stats.deletions,
          stats_files_changed: uncommittedDiff.stats.filesChanged,
          author: 'You',
          comparison_branch: comparisonBranch,
          history_source: historySource,
          history_limit_reached: limitReached
        });
      }

      return { success: true, data: executions };
    } catch (error) {
      console.error('Failed to get executions:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get executions';
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('sessions:get-execution-diff', async (sessionId: string, executionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const { commits } = await getSessionCommitHistory(session, 50);
      const executionIndex = parseInt(executionId) - 1;

      if (executionIndex < 0 || executionIndex >= commits.length) {
        return { success: false, error: 'Invalid execution ID' };
      }

      // Get diff for the specific commit
      const commit = commits[executionIndex];
      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const diff = await gitDiffManager.getCommitDiff(session.worktreePath, commit.hash, ctx.commandRunner);
      return { success: true, data: diff };
    } catch (error) {
      console.error('Failed to get execution diff:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get execution diff';
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('sessions:get-git-graph', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project?.path) {
        return { success: false, error: 'Project path not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const comparisonBranch = await worktreeManager.getSessionComparisonBranch(session, ctx);
      let branch: string;
      try {
        branch = (await ctx.commandRunner.execAsync('git rev-parse --abbrev-ref HEAD', session.worktreePath)).stdout.trim() || session.baseBranch || 'unknown';
      } catch {
        branch = session.baseBranch || 'unknown';
      }

      let entries: GitGraphCommit[] = [];
      let useFallback = false;

      try {
        entries = await gitDiffManager.getGraphCommitHistory(session.worktreePath, branch, 50, comparisonBranch, ctx.commandRunner);
        if (entries.length === 0 && session.isMainRepo) {
          useFallback = true;
        }
      } catch (error) {
        if (session.isMainRepo) {
          useFallback = true;
        } else {
          throw error;
        }
      }

      if (useFallback) {
        const fallbackCommits = await worktreeManager.getLastCommits(session.worktreePath, 50, ctx.commandRunner);
        entries = fallbackCommits.map((commit: RawCommitData, index: number, arr: RawCommitData[]) => ({
          hash: commit.hash.substring(0, 7),
          parents: index < arr.length - 1 ? [arr[index + 1].hash.substring(0, 7)] : [],
          branch,
          message: commit.message,
          committerDate: new Date(commit.date).toISOString(),
          author: commit.author || 'Unknown',
        }));
      }

      // Prepend uncommitted changes if any
      const hasUncommittedChanges = await gitDiffManager.hasChanges(session.worktreePath, ctx.commandRunner);
      if (hasUncommittedChanges) {
        // Get diff stats for uncommitted changes
        let filesChanged = 0;
        let additions = 0;
        let deletions = 0;
        try {
          const combinedStat = (await ctx.commandRunner.execAsync('git diff HEAD --shortstat', session.worktreePath)).stdout.trim();
          if (combinedStat) {
            const fileMatch = combinedStat.match(/(\d+) files? changed/);
            const addMatch = combinedStat.match(/(\d+) insertions?\(\+\)/);
            const delMatch = combinedStat.match(/(\d+) deletions?\(-\)/);
            filesChanged = fileMatch ? parseInt(fileMatch[1]) : 0;
            additions = addMatch ? parseInt(addMatch[1]) : 0;
            deletions = delMatch ? parseInt(delMatch[1]) : 0;
          }
        } catch {
          // Ignore stat errors — still show the entry without stats
        }

        entries.unshift({
          hash: 'index',
          parents: entries.length > 0 ? [entries[0].hash] : [],
          branch,
          message: 'Uncommitted changes',
          committerDate: new Date().toISOString(),
          author: 'You',
          filesChanged,
          additions,
          deletions,
        });
      }

      return { success: true, data: { entries, currentBranch: branch } };
    } catch (error) {
      console.error('Failed to get git graph:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git graph';
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('sessions:git-commit', async (sessionId: string, message: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Check if there are any changes to commit
      const status = (await ctx.commandRunner.execAsync('git status --porcelain', session.worktreePath)).stdout.trim();

      if (!status) {
        return { success: false, error: 'No changes to commit' };
      }

      // Stage all changes
      await ctx.commandRunner.execAsync('git add -A', session.worktreePath);

      try {
        await commitGitMessage(ctx.commandRunner, session.worktreePath, message, services.configManager.getConfig());

        // Refresh git status for this session after commit
        await refreshGitStatusForSession(sessionId);

        return { success: true };
      } catch (commitError: unknown) {
        // Check if it's a pre-commit hook failure
        const processError = decodeBoundary(commitError, boundary.object({
          stdout: boundary.optional(boundary.string),
          stderr: boundary.optional(boundary.string),
        }));
        if (processError.stdout?.includes('pre-commit') || processError.stderr?.includes('pre-commit')) {
          return { success: false, error: 'Pre-commit hooks failed. Please fix the issues and try again.' };
        }
        throw commitError;
      }
    } catch (error: unknown) {
      console.error('Failed to commit changes:', error);
      let stderr = '';
      try {
        stderr = decodeBoundary(error, boundary.object({ stderr: boundary.optional(boundary.string) })).stderr ?? '';
      } catch {
        // Preserve the standard error fallback below.
      }
      const errorMessage = (error instanceof Error ? error.message : '') || stderr || 'Failed to commit changes';
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('git:file-status', async (sessionId: string, filePath: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session not found' };
      }
      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) return { success: false, error: 'No project context' };

      // Check working tree + staged changes for this specific file
      const modified = (await ctx.commandRunner.execAsync(
        `git diff --name-only HEAD -- "${filePath}"`,
        session.worktreePath
      )).stdout.trim();

      // Check if file is untracked
      const untracked = (await ctx.commandRunner.execAsync(
        `git ls-files --others --exclude-standard -- "${filePath}"`,
        session.worktreePath
      )).stdout.trim();

      const status = untracked.length > 0 ? 'untracked' : modified.length > 0 ? 'modified' : 'clean';
      return { success: true, data: { status } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check file status' };
    }
  });

  commandRegistry.register('sessions:git-diff', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      // Check if session is archived - worktree won't exist
      if (session.archived) {
        return { success: false, error: 'Cannot access git diff for archived session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const diff = await gitDiffManager.getGitDiff(session.worktreePath, ctx.commandRunner);
      return { success: true, data: diff };
    } catch (error) {
      // Don't log errors for expected failures
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git diff';
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to get git diff:', error);
      }
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('sessions:check-rebase-conflicts', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const comparisonBranch = await worktreeManager.getSessionComparisonBranch(session, ctx);

      // Check for conflicts
      const conflictInfo = await worktreeManager.checkForRebaseConflicts(session.worktreePath, comparisonBranch, ctx.commandRunner);

      return {
        success: true,
        data: conflictInfo
      };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to check for rebase conflicts:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check for rebase conflicts'
      };
    }
  });

  commandRegistry.register('sessions:rebase-main-into-worktree', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const comparisonBranch = await Promise.race([
        worktreeManager.getSessionComparisonBranch(session, ctx),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('getSessionComparisonBranch timeout')), 30000))
      ]);

      // Check for conflicts before attempting rebase
      const conflictCheck = await worktreeManager.checkForRebaseConflicts(session.worktreePath, comparisonBranch, ctx.commandRunner);

      if (conflictCheck.hasConflicts) {

        // Build detailed error message
        let errorMessage = `Rebase would result in conflicts. Cannot proceed automatically.\n\n`;

        if (conflictCheck.conflictingFiles && conflictCheck.conflictingFiles.length > 0) {
          errorMessage += `Conflicting files:\n`;
          conflictCheck.conflictingFiles.forEach(file => {
            errorMessage += `  • ${file}\n`;
          });
          errorMessage += '\n';
        }

        if (conflictCheck.conflictingCommits) {
          if (conflictCheck.conflictingCommits.ours.length > 0) {
            errorMessage += `Your commits:\n`;
            conflictCheck.conflictingCommits.ours.slice(0, 5).forEach(commit => {
              errorMessage += `  ${commit}\n`;
            });
            if (conflictCheck.conflictingCommits.ours.length > 5) {
              errorMessage += `  ... and ${conflictCheck.conflictingCommits.ours.length - 5} more\n`;
            }
            errorMessage += '\n';
          }

          if (conflictCheck.conflictingCommits.theirs.length > 0) {
            errorMessage += `Incoming commits from ${comparisonBranch}:\n`;
            conflictCheck.conflictingCommits.theirs.slice(0, 5).forEach(commit => {
              errorMessage += `  ${commit}\n`;
            });
            if (conflictCheck.conflictingCommits.theirs.length > 5) {
              errorMessage += `  ... and ${conflictCheck.conflictingCommits.theirs.length - 5} more\n`;
            }
          }
        }

        // Emit git operation failed event for conflict detection
        const conflictMessage = `✗ Rebase aborted: Conflicts detected\n\n${errorMessage}`;
        emitGitOperationToProject(sessionId, 'git:operation_failed', conflictMessage, {
          operation: 'rebase_from_main',
          comparisonBranch,
          hasConflicts: true,
          conflictingFiles: conflictCheck.conflictingFiles ?? null
        });

        // Return detailed conflict information
        return {
          success: false,
          error: 'Rebase would result in conflicts',
          gitError: {
            command: `git rebase ${comparisonBranch}`,
            output: errorMessage,
            workingDirectory: session.worktreePath,
            hasConflicts: true,
            conflictingFiles: conflictCheck.conflictingFiles,
            conflictingCommits: conflictCheck.conflictingCommits
          }
        };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nRebasing from ${comparisonBranch}...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'rebase_from_main',
        comparisonBranch
      });

      await Promise.race([
        worktreeManager.rebaseMainIntoWorktree(session.worktreePath, comparisonBranch, ctx.commandRunner),
        new Promise((_, reject) => setTimeout(() => reject(new Error('rebaseMainIntoWorktree timeout')), 120000))
      ]);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully rebased ${comparisonBranch} into worktree`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'rebase_from_main',
        comparisonBranch
      });

      // Update git status directly after rebasing from main (more efficient than refresh)
      // Don't let this block the response - run it in background
      gitStatusManager.updateGitStatusAfterRebase(sessionId, 'from_main').catch(error => {
        console.error(`[IPC:git] Failed to update git status for session ${sessionId}:`, error);
      });

      return { success: true, data: { message: `Successfully rebased ${comparisonBranch} into worktree` } };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to rebase main into worktree for session ${sessionId}:`, error);
      const gitError = decodeGitError(error);

      // Emit git operation failed event
      const errorMessage = `✗ Rebase failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      
      // Don't let this block the error response either
      try {
        emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
          operation: 'rebase_from_main',
          error: error instanceof Error ? error.message : String(error),
          gitOutput: gitError.gitOutput ?? null
        });
      } catch (outputError) {
        console.error(`[IPC:git] Failed to emit git error event for session ${sessionId}:`, outputError);
      }

      // Pass detailed git error information to frontend
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rebase main into worktree',
        gitError: {
          command: gitError.gitCommand,
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory,
          originalError: gitError.originalError?.message
        }
      };
    }
  });

  commandRegistry.register('sessions:abort-rebase-and-use-claude', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const comparisonBranch = await worktreeManager.getSessionComparisonBranch(session, ctx);

      // Check if we're actually in a rebase state (could have been pre-detected conflicts)
      // Try to abort any existing rebase, but don't fail if there isn't one
      try {
        const statusOutput = (await ctx.commandRunner.execAsync('git status --porcelain=v1', session.worktreePath)).stdout;
        if (statusOutput.includes('rebase')) {
          await worktreeManager.abortRebase(session.worktreePath, ctx.commandRunner);

          // Emit git operation event about aborting the rebase
          const abortMessage = `🔄 GIT OPERATION\nAborted rebase successfully`;
          emitGitOperationToProject(sessionId, 'git:operation_completed', abortMessage, {
            operation: 'abort_rebase'
          });
        }
      } catch {
        // Not in a rebase state or already clean - that's fine
      }

      // Use session-based Claude to handle the rebase and conflicts
      const prompt = `Please rebase ${comparisonBranch} into this branch and resolve all conflicts`;

      try {
        // Start Claude session to handle rebase
        await claudeCodeManager.startSession(
          sessionId,
          session.worktreePath,
          prompt,
          session.permissionMode,
          session.model
        );

        // Add message to session output
        const message = `🤖 CLAUDE CODE\nStarted Claude session to handle rebase and resolve conflicts\nPrompt: ${prompt}`;
        sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: message,
          timestamp: new Date()
        });

        return {
          success: true,
          data: {
            message: 'Claude Code session started to handle rebase and resolve conflicts'
          }
        };
      } catch (error: unknown) {
        console.error('[IPC:git] Failed to start Claude session:', error);

        let errorMessage = 'Failed to start Claude session';
        if (error instanceof Error && error.message) {
          errorMessage = `Failed to start Claude session: ${error.message}`;
        }

        return { success: false, error: errorMessage };
      }
    } catch (error: unknown) {
      console.error('[IPC:git] Failed to abort rebase and use Claude:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to abort rebase and use Claude'
      };
    }
  });

  commandRegistry.register('sessions:squash-and-rebase-to-main', async (sessionId: string, commitMessage: string) => {
    try {
      if (!hasCommitMessageTitle(commitMessage)) {
        return { success: false, error: 'Commit title is required' };
      }

      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch and project path
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Use the LOCAL base branch (not the comparison ref) — this is a write
      // operation that runs `git checkout <branch>` in the project repo, and
      // checking out a remote ref like `origin/main` produces detached HEAD
      // and silently fast-forwards detached HEAD instead of the local target.
      const localBaseBranch = await Promise.race([
        worktreeManager.getSessionLocalBaseBranch(session, ctx),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('getSessionLocalBaseBranch timeout')), 30000))
      ]);

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nSquashing commits and merging to ${localBaseBranch}...\nCommit message: ${commitMessage.split('\n')[0]}${commitMessage.includes('\n') ? '...' : ''}`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'squash_and_merge',
        comparisonBranch: localBaseBranch,
        commitMessage: commitMessage.split('\n')[0]
      });

      await Promise.race([
        worktreeManager.squashAndMergeWorktreeToMain(project.path, session.worktreePath, localBaseBranch, commitMessage, ctx.commandRunner),
        new Promise((_, reject) => setTimeout(() => reject(new Error('squashAndMergeWorktreeToMain timeout')), 180000))
      ]);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully squashed and merged worktree to ${localBaseBranch}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'squash_and_merge',
        comparisonBranch: localBaseBranch
      });

      // Update git status for ALL sessions in the project since main was updated
      // Wait for this to complete before returning so UI sees the updated status immediately
      if (session.projectId !== undefined) {
        try {
          await gitStatusManager.updateProjectGitStatusAfterMainUpdate(session.projectId, sessionId);
        } catch (error) {
          console.error(`[IPC:git] Failed to update git status for project ${session.projectId}:`, error);
          // Continue even if status update fails - the merge succeeded
        }
      }

      return { success: true, data: { message: `Successfully squashed and merged worktree to ${localBaseBranch}` } };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to squash and merge worktree to main for session ${sessionId}:`, error);
      const gitError = decodeGitError(error);

      // Emit git operation failed event
      const errorMessage = `✗ Merge failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');

      // Don't let this block the error response either
      try {
        emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
          operation: 'squash_and_merge',
          error: error instanceof Error ? error.message : String(error),
          gitOutput: gitError.gitOutput ?? null
        });
      } catch (outputError) {
        console.error(`[IPC:git] Failed to emit git error event for session ${sessionId}:`, outputError);
      }

      // Pass detailed git error information to frontend
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to squash and merge worktree to main',
        gitError: {
          commands: gitError.gitCommands,
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory,
          projectPath: gitError.projectPath,
          originalError: gitError.originalError?.message
        }
      };
    }
  });

  commandRegistry.register('sessions:rebase-to-main', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch and project path
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Use the LOCAL base branch (not the comparison ref) — this is a write
      // operation that runs `git checkout <branch>` in the project repo, and
      // checking out a remote ref like `origin/main` produces detached HEAD.
      const localBaseBranch = await worktreeManager.getSessionLocalBaseBranch(session, ctx);

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nMerging to ${localBaseBranch} (preserving all commits)...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'merge_to_main',
        comparisonBranch: localBaseBranch
      });

      await worktreeManager.mergeWorktreeToMain(project.path, session.worktreePath, localBaseBranch, ctx.commandRunner);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully merged worktree to ${localBaseBranch}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'merge_to_main',
        comparisonBranch: localBaseBranch
      });
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: successMessage,
        timestamp: new Date()
      });

      // Update git status for ALL sessions in the project since main was updated
      // Wait for this to complete before returning so UI sees the updated status immediately
      if (session.projectId !== undefined) {
        try {
          await gitStatusManager.updateProjectGitStatusAfterMainUpdate(session.projectId, sessionId);
        } catch (error) {
          console.error(`[IPC:git] Failed to update git status for project ${session.projectId}:`, error);
          // Continue even if status update fails - the merge succeeded
        }
      }

      return { success: true, data: { message: `Successfully merged worktree to ${localBaseBranch}` } };
    } catch (error: unknown) {
      console.error('Failed to merge worktree to main:', error);

      const gitError = decodeGitError(error);

      // Add error message to session output
      const errorMessage = `✗ Merge failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      sessionManager.addSessionOutput(sessionId, {
        type: 'stderr',
        data: errorMessage,
        timestamp: new Date()
      });
      // Pass detailed git error information to frontend
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to merge worktree to main',
        gitError: {
          commands: gitError.gitCommands,
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory,
          projectPath: gitError.projectPath,
          originalError: gitError.originalError?.message
        }
      };
    }
  });

  // Git pull/push operations for main repo sessions
  commandRegistry.register('sessions:git-pull', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nPulling latest changes from remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'pull'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git pull
      const result = await worktreeManager.gitPull(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully pulled latest changes` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'pull',
        output: result.output
      });

      // Check if this is a main repo session pulling main branch updates
      if (session.isMainRepo && session.projectId !== undefined) {
        // If pulling to main repo, all worktrees might be affected
        await refreshGitStatusForProject(session.projectId);
      } else {
        // If pulling to a worktree, only this session is affected
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to pull from remote:', error);

      // Emit git operation failed event
      const gitError = decodeGitError(error);
      
      const errorMessage = `✗ Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'pull',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput ?? null
      });

      // Check if it's a merge conflict
      if ((error instanceof Error && error.message?.includes('CONFLICT')) || (gitError.gitOutput?.includes('CONFLICT'))) {
        return {
          success: false,
          error: 'Merge conflicts detected. Please resolve conflicts manually or ask Claude to help.',
          isMergeConflict: true,
          gitError: {
            output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
            workingDirectory: gitError.workingDirectory || ''
          }
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pull from remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:git-push', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nPushing changes to remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'push'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git push
      const result = await worktreeManager.gitPush(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully pushed changes to remote` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'push',
        output: result.output
      });
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: successMessage,
        timestamp: new Date()
      });

      // Invalidate PR cache after push since PRs may have been created or updated
      const pushProject = sessionManager.getProjectForSession(sessionId);
      if (pushProject?.path) {
        gitStatusManager.invalidatePrCache(pushProject.path);
      }

      // Check if this is a main repo session pushing to main branch
      if (session.isMainRepo && session.projectId !== undefined) {
        // If pushing from main repo, all worktrees might be affected
        await refreshGitStatusForProject(session.projectId);
      } else {
        // If pushing from a worktree, only this session is affected
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to push to remote:', error);

      const gitError = decodeGitError(error);
      
      // Emit git operation failed event
      const errorMessage = `✗ Push failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'push',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput ?? null
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to push to remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:git-soft-reset', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nUndoing last commit (keeping changes staged)...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'soft-reset'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Use session's base commit as the undo boundary — this ensures only commits
      // created within this session can be undone, not pre-existing branch commits.
      // Falls back to comparison branch if base_commit isn't recorded.
      let undoBoundary = session.baseCommit;
      if (!undoBoundary) {
        undoBoundary = await worktreeManager.getSessionComparisonBranch(session, ctx);
      }

      // Run git soft reset with live safety check against the undo boundary
      const result = await worktreeManager.gitSoftReset(session.worktreePath, undoBoundary, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully undid last commit (changes are now staged)\n\nPrevious commit message:\n${result.previousCommitMessage}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'soft-reset',
        previousCommitMessage: result.previousCommitMessage
      });

      // Refresh git status
      if (session.isMainRepo && session.projectId !== undefined) {
        await refreshGitStatusForProject(session.projectId);
      } else {
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to soft reset:', error);

      const gitError = decodeGitError(error);

      const errorMessage = `✗ Undo commit failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'soft-reset',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput ?? null
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to undo commit',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:git-fetch', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nFetching from remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'fetch'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git fetch
      const result = await worktreeManager.gitFetch(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully fetched from remote` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'fetch',
        output: result.output
      });

      // Refresh git status after fetch (may show new commits behind)
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to fetch from remote:', error);

      const gitError = decodeGitError(error);

      // Emit git operation failed event
      const errorMessage = `✗ Fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'fetch',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput ?? null
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch from remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:git-stash', async (sessionId: string, message?: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nStashing changes...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'stash'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git stash
      const result = await worktreeManager.gitStash(session.worktreePath, message, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully stashed changes` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'stash',
        output: result.output
      });

      // Refresh git status after stash
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to stash changes:', error);

      const gitError = decodeGitError(error);

      // Emit git operation failed event
      const errorMessage = `✗ Stash failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'stash',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput ?? null
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stash changes',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:git-stash-pop', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nPopping stash...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'stash_pop'
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git stash pop
      const result = await worktreeManager.gitStashPop(session.worktreePath, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully applied stash` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'stash_pop',
        output: result.output
      });

      // Refresh git status after stash pop
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to pop stash:', error);

      const gitError = decodeGitError(error);

      // Emit git operation failed event
      const errorMessage = `✗ Stash pop failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'stash_pop',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput ?? null
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pop stash',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:has-stash', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const hasStash = await worktreeManager.hasStash(session.worktreePath, ctx.commandRunner);
      return { success: true, data: hasStash };
    } catch (error: unknown) {
      console.error('Failed to check stash:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check stash'
      };
    }
  });

  commandRegistry.register('sessions:set-upstream', async (sessionId: string, remoteBranch: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const result = await worktreeManager.setUpstream(session.worktreePath, remoteBranch, ctx.commandRunner);

      // Refresh git status after setting upstream
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to set upstream:', error);
      const gitError = decodeGitError(error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set upstream',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:get-upstream', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const upstream = await worktreeManager.getUpstream(session.worktreePath, ctx.commandRunner);
      return { success: true, data: upstream };
    } catch (error: unknown) {
      console.error('Failed to get upstream:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get upstream'
      };
    }
  });

  commandRegistry.register('sessions:get-remote-branches', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const branches = await worktreeManager.getRemoteBranches(session.worktreePath, ctx.commandRunner);
      return { success: true, data: branches };
    } catch (error: unknown) {
      console.error('Failed to get remote branches:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get remote branches'
      };
    }
  });

  commandRegistry.register('sessions:git-stage-and-commit', async (sessionId: string, message: string) => {
    try {
      if (!hasCommitMessageTitle(message)) {
        return { success: false, error: 'Commit title is required' };
      }

      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event
      const startMessage = `🔄 GIT OPERATION\nCommitting changes...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'commit',
        message: message.split('\n')[0]
      });

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Run git add -A && git commit
      const result = await worktreeManager.gitStageAllAndCommit(session.worktreePath, message, ctx.commandRunner);

      // Emit git operation completed event
      const successMessage = `✓ Successfully committed changes` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'commit',
        output: result.output
      });

      // Refresh git status after commit
      await refreshGitStatusForSession(sessionId);

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to commit changes:', error);

      const gitError = decodeGitError(error);

      // Emit git operation failed event
      const errorMessage = `✗ Commit failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'commit',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput ?? null
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to commit changes',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  });

  commandRegistry.register('sessions:get-last-commits', async (sessionId: string, count: number = 50) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      // Get the last N commits from the repository
      const commits = await worktreeManager.getLastCommits(session.worktreePath, count, ctx.commandRunner);
      const limitReached = commits.length === count;

      // Transform commits to match ExecutionDiff format
      const executionDiffs = commits.map((commit, index) => ({
        id: index + 1,
        session_id: sessionId,
        commit_message: commit.message,
        execution_sequence: index + 1,
        stats_additions: commit.additions || 0,
        stats_deletions: commit.deletions || 0,
        stats_files_changed: commit.filesChanged || 0,
        commit_hash: commit.hash,
        timestamp: commit.date,
        author: commit.author || 'Unknown',
        history_limit_reached: limitReached
      }));

      return { success: true, data: executionDiffs };
    } catch (error: unknown) {
      console.error('Failed to get last commits:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get last commits'
      };
    }
  });

  // Git operation helpers
  commandRegistry.register('sessions:has-changes-to-rebase', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const comparisonBranch = await worktreeManager.getSessionComparisonBranch(session, ctx);
      const hasChanges = await worktreeManager.hasChangesToRebase(session.worktreePath, comparisonBranch, ctx.commandRunner);

      return { success: true, data: hasChanges };
    } catch (error) {
      console.error('Failed to check for changes to rebase:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check for changes to rebase' };
    }
  });

  commandRegistry.register('sessions:get-git-commands', async (sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      // Check if session is archived - worktree won't exist
      if (session.archived) {
        return { success: false, error: 'Cannot access git commands for archived session' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) throw new Error('Project context not found for session');

      const comparisonBranch = await worktreeManager.getSessionComparisonBranch(session, ctx);

      // Get current branch name
      const currentBranch = (await ctx.commandRunner.execAsync('git branch --show-current', session.worktreePath)).stdout.trim();

      // Only call getOriginBranch for legacy isMainRepo sessions where baseBranch is not set.
      // When baseBranch is set it already includes the origin/ prefix if applicable — calling
      // getOriginBranch with it would produce a double-origin/ probe.
      const originBranch = (session.isMainRepo && !session.baseBranch)
        ? await worktreeManager.getOriginBranch(session.worktreePath, comparisonBranch, ctx.commandRunner)
        : null;

      const rebaseCommands = worktreeManager.generateRebaseCommands(comparisonBranch);
      const squashCommands = worktreeManager.generateSquashCommands(comparisonBranch, currentBranch);
      const mergeCommands = worktreeManager.generateMergeCommands(comparisonBranch, currentBranch);

      return {
        success: true,
        data: {
          rebaseCommands,
          squashCommands,
          mergeCommands,
          comparisonBaseBranch: comparisonBranch,
          originBranch: originBranch || undefined,
          currentBranch
        }
      };
    } catch (error) {
      // Don't log errors for expected failures
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git commands';
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to get git commands:', error);
      }
      return { success: false, error: errorMessage };
    }
  });

  commandRegistry.register('sessions:get-git-status', async (sessionId: string, nonBlocking?: boolean, isInitialLoad?: boolean) => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      if (session.archived) {
        return { success: false, error: 'Cannot get git status for archived session' };
      }

      // For initial loads, use the queued approach to prevent UI lock
      if (isInitialLoad) {
        const cachedStatus = await gitStatusManager.queueInitialLoad(sessionId);
        return {
          success: true,
          gitStatus: cachedStatus,
          backgroundRefresh: true
        };
      }

      // If nonBlocking is true, start refresh in background and return immediately
      if (nonBlocking) {
        // Start the refresh in background
        setImmediate(() => {
          gitStatusManager.refreshSessionGitStatus(sessionId, true).catch(error => {
            console.error(`[Git] Background git status refresh failed for session ${sessionId}:`, error);
          });
        });

        // Return the cached status if available, or indicate background refresh started
        const cachedStatus = await gitStatusManager.getGitStatus(sessionId);
        return {
          success: true,
          gitStatus: cachedStatus,
          backgroundRefresh: true
        };
      } else {
        // Use refreshSessionGitStatus with user-initiated flag
        // This is called when user clicks on a session, so show loading state
        const gitStatus = await gitStatusManager.refreshSessionGitStatus(sessionId, true);
        return { success: true, gitStatus };
      }
    } catch (error) {
      console.error('Error getting git status:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  commandRegistry.register('git:cancel-status-for-project', async (projectId: number) => {
    try {
      // Get all sessions for the project
      const sessions = await sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived);

      // Cancel git status operations for all project sessions
      const sessionIds = projectSessions.map(s => s.id);
      gitStatusManager.cancelMultipleGitStatus(sessionIds);

      return { success: true };
    } catch (error) {
      console.error('Error cancelling git status:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  commandRegistry.register('git:get-github-remote', async (sessionId: string) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session?.worktreePath) {
        return { success: true, data: null };
      }

      const ctx = sessionManager.getProjectContext(sessionId);
      if (!ctx) return { success: true, data: null };

      const stdout = (await ctx.commandRunner.execAsync('git remote -v', session.worktreePath)).stdout;

      // Parse remote output for github.com
      const lines = stdout.split('\n');
      for (const line of lines) {
        // Match SSH format: git@github.com:org/repo.git (repo can contain dots like repo.name)
        const sshMatch = line.match(/git@github\.com:([^/]+\/[^\s]+?)(?:\.git)?(?:\s|$)/);
        if (sshMatch) {
          // Remove .git suffix if present
          const repo = sshMatch[1].replace(/\.git$/, '');
          return { success: true, data: `https://github.com/${repo}` };
        }

        // Match HTTPS format: https://github.com/org/repo.git or https://github.com/org/repo
        const httpsMatch = line.match(/https:\/\/github\.com\/([^/]+\/[^\s]+?)(?:\.git)?(?:\s|$)/);
        if (httpsMatch) {
          // Remove .git suffix if present
          const repo = httpsMatch[1].replace(/\.git$/, '');
          return { success: true, data: `https://github.com/${repo}` };
        }
      }

      return { success: true, data: null };
    } catch (error) {
      console.error('Failed to get GitHub remote:', error);
      return { success: true, data: null }; // Silent fail, just no git links
    }
  });

  commandRegistry.register('git:clone-repo', async (url: string, destDir: string) => {
    if (!isValidGitUrl(url)) {
      return { success: false, error: 'Invalid repository URL. Use https:// or git@ format.' };
    }

    const repoName = extractRepoName(url);

    // Detect WSL path (e.g. \\wsl$\Ubuntu\home\user) and configure accordingly
    const wslInfo = parseWSLPath(destDir);
    let actualDestDir = destDir;
    let wslEnabled = false;
    let wslDistribution: string | null = null;

    if (wslInfo) {
      const wslError = validateWSLAvailable(wslInfo.distro);
      if (wslError) {
        return { success: false, error: wslError };
      }
      wslEnabled = true;
      wslDistribution = wslInfo.distro;
      actualDestDir = wslInfo.linuxPath;
    }

    const clonePath = wslEnabled ? `${actualDestDir}/${repoName}` : join(destDir, repoName);
    const fsCheckPath = wslEnabled ? join(destDir, repoName) : clonePath;

    if (existsSync(fsCheckPath)) {
      return { success: false, error: `Directory "${repoName}" already exists in the destination folder` };
    }

    try {
      // Use double quotes for cross-platform compatibility (single quotes break on Windows cmd.exe)
      const escapedUrl = url.replace(/"/g, '\\"');
      const escapedPath = clonePath.replace(/"/g, '\\"');
      const commandRunner = new CommandRunner({ path: actualDestDir, wsl_enabled: wslEnabled, wsl_distribution: wslDistribution });
      await commandRunner.execAsync(
        `git clone "${escapedUrl}" "${escapedPath}"`,
        actualDestDir,
        { timeout: 300000, env: { ...process.env, PATH: getShellPath() } }
      );

      // Return the original (non-WSL-translated) path so the frontend can use it directly
      const returnPath = wslEnabled ? join(destDir, repoName) : clonePath;
      return { success: true, data: { clonedPath: returnPath, repoName } };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes('Could not resolve host') || errorMsg.includes('Connection timed out')) {
        return { success: false, error: 'Network error — check your internet connection and try again.' };
      }
      if (errorMsg.includes('Authentication failed') || errorMsg.includes('could not read Username')) {
        return { success: false, error: 'Authentication failed — check your credentials or use an SSH URL.' };
      }
      if (errorMsg.includes('not found') || errorMsg.includes('does not exist')) {
        return { success: false, error: 'Repository not found — check the URL and try again.' };
      }

      return { success: false, error: errorMsg };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_GIT_CHANNELS);
}
