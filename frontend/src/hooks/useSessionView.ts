import { useState, useEffect, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { API, GitErrorResponse } from '../utils/api';
import type { Session, GitCommands, GitErrorDetails } from '../types/session';
import { useHotkey } from './useHotkey';

/** Git operations and archive dialogs for the active worktree pane. */
export const useSessionView = (activeSession: Session | undefined) => {
  const activeSessionId = activeSession?.id;

  const [isMerging, setIsMerging] = useState(false);
  const [isMergingAndArchiving, setIsMergingAndArchiving] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [gitCommands, setGitCommands] = useState<GitCommands | null>(null);
  const [hasChangesToRebase, setHasChangesToRebase] = useState<boolean>(false);
  const [hasStash, setHasStash] = useState<boolean>(false);
  const [showCommitMessageDialog, setShowCommitMessageDialog] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [dialogType, setDialogType] = useState<'rebase' | 'squash' | 'commit'>('rebase');
  const [showGitErrorDialog, setShowGitErrorDialog] = useState(false);
  const [gitErrorDetails, setGitErrorDetails] = useState<GitErrorDetails | null>(null);
  const [shouldSquash, setShouldSquash] = useState(true);

  // Archive confirm dialog state (triggered by Ctrl+Shift+W)
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);

  // Folder archive dialog state
  const [showFolderArchiveDialog, setShowFolderArchiveDialog] = useState(false);
  const [folderArchiveSessionId, setFolderArchiveSessionId] = useState<string | null>(null);
  const [folderArchiveFolderId, setFolderArchiveFolderId] = useState<string | null>(null);
  const [folderSessionCount, setFolderSessionCount] = useState(0);

  useEffect(() => {
    if (!activeSessionId) {
      setGitCommands(null);
      setHasChangesToRebase(false);
      setHasStash(false);
      return;
    }
    let cancelled = false;
    const loadGitData = async () => {
      try {
        const [commandsResponse, changesResponse, stashResponse] = await Promise.all([
          API.sessions.getGitCommands(activeSessionId),
          API.sessions.hasChangesToRebase(activeSessionId),
          API.sessions.hasStash(activeSessionId)
        ]);
        if (cancelled) return;
        if (commandsResponse.success) setGitCommands(commandsResponse.data);
        if (changesResponse.success) setHasChangesToRebase(changesResponse.data);
        if (stashResponse.success) setHasStash(stashResponse.data);
      } catch (error) { console.error('Error loading git data:', error); }
    };
    loadGitData();
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);


  const isSessionBusy = activeSession?.status === 'running' || activeSession?.status === 'initializing';
  const getGitCommandDisabledReason = (command: 'commit' | 'push' | 'undo' | 'pull' | 'rebase' | 'merge'): string | null => {
    if (!activeSession) return 'No active session';
    if (isMerging) return 'Git operation already in progress';
    if (isSessionBusy) return 'Session is currently running';
    if (activeSession.isMainRepo) return 'Only available in worktree panes';

    switch (command) {
      case 'commit':
        return (activeSession.gitStatus?.hasUncommittedChanges || activeSession.gitStatus?.hasUntrackedFiles)
          ? null
          : 'No changes to commit';
      case 'push':
        return (activeSession.gitStatus?.ahead ?? 0) > 0 ? null : 'No commits to push';
      case 'undo':
        return (activeSession.gitStatus?.ahead ?? 0) > 0 ? null : 'No local commits to undo';
      case 'pull':
        return null;
      case 'rebase':
        return hasChangesToRebase ? null : 'No changes to rebase from main';
      case 'merge':
        return !!activeSession.gitStatus?.totalCommits && activeSession.gitStatus.totalCommits > 0 && (activeSession.gitStatus?.ahead ?? 0) > 0
          ? null
          : 'No commits to merge';
    }
  };

  useHotkey({
    id: 'git-commit',
    label: 'Git: Commit',
    keys: 'mod+shift+k',
    category: 'session',
    action: () => {
      setDialogType('commit');
      setShowCommitMessageDialog(true);
    },
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo &&
      ((activeSession.gitStatus?.hasUncommittedChanges ?? false) || (activeSession.gitStatus?.hasUntrackedFiles ?? false)),
    disabledReason: () => getGitCommandDisabledReason('commit'),
  });

  useHotkey({
    id: 'git-push',
    label: 'Git: Push',
    keys: 'mod+shift+u',
    category: 'session',
    action: () => handleGitPush(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo && (activeSession.gitStatus?.ahead ?? 0) > 0,
    disabledReason: () => getGitCommandDisabledReason('push'),
  });

  useHotkey({
    id: 'git-soft-reset',
    label: 'Git: Undo Last Commit',
    keys: 'mod+alt+z',
    category: 'session',
    action: () => handleGitSoftReset(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo && (activeSession.gitStatus?.ahead ?? 0) > 0,
    disabledReason: () => getGitCommandDisabledReason('undo'),
  });

  useHotkey({
    id: 'git-pull',
    label: 'Git: Pull',
    keys: 'mod+shift+l',
    category: 'session',
    action: () => handleGitPull(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo,
    disabledReason: () => getGitCommandDisabledReason('pull'),
  });

  useHotkey({
    id: 'git-rebase-from-main',
    label: 'Git: Rebase from Main',
    keys: 'mod+shift+r',
    category: 'session',
    action: () => handleRebaseMainIntoWorktree(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo && hasChangesToRebase,
    disabledReason: () => getGitCommandDisabledReason('rebase'),
  });

  useHotkey({
    id: 'git-merge-to-main',
    label: 'Git: Merge to Main',
    keys: 'mod+shift+m',
    category: 'session',
    action: () => handleSquashAndRebaseToMain(),
    enabled: () => !!activeSession && !isMerging && !isSessionBusy && !activeSession.isMainRepo &&
      !!activeSession.gitStatus?.totalCommits && activeSession.gitStatus.totalCommits > 0 &&
      (activeSession.gitStatus?.ahead ?? 0) > 0,
    disabledReason: () => getGitCommandDisabledReason('merge'),
  });


  const handleGitPull = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitPull(activeSession.id);
      if (!response.success) {
        if (response.error?.includes('conflict') || response.error?.includes('merge')) {
          setGitErrorDetails({
            title: 'Pull Failed - Merge Conflicts',
            message: 'There are merge conflicts that need to be resolved manually.',
            command: 'git pull',
            output: response.details || response.error || 'No output available',
            workingDirectory: activeSession.worktreePath,
          });
          setShowGitErrorDialog(true);
          setMergeError('Merge conflicts detected. You\'ll need to resolve them manually or ask Claude to help.');
        } else {
          setMergeError(response.error || 'Failed to pull from remote');
        }
      // Removed viewMode check - panels handle their own refresh
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to pull from remote');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitPush = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
        const response = await API.sessions.gitPush(activeSession.id);
        if(!response.success) setMergeError(response.error || 'Failed to push to remote');
    } catch (error) {
        setMergeError(error instanceof Error ? error.message : 'Failed to push to remote');
    } finally {
        setIsMerging(false);
    }
  };

  const handleGitSoftReset = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitSoftReset(activeSession.id);
      if (!response.success) setMergeError(response.error || 'Failed to undo commit');
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to undo commit');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitFetch = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitFetch(activeSession.id);
      if (!response.success) {
        setMergeError(response.error || 'Failed to fetch from remote');
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to fetch from remote');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitStash = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitStash(activeSession.id);
      if (!response.success) {
        setMergeError(response.error || 'Failed to stash changes');
      } else {
        // Refresh stash status after successful stash
        API.sessions.hasStash(activeSession.id).then(stashResponse => {
          if (stashResponse.success) setHasStash(stashResponse.data);
        }).catch(() => {});
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to stash changes');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitStashPop = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitStashPop(activeSession.id);
      if (!response.success) {
        setMergeError(response.error || 'Failed to pop stash');
      } else {
        // Refresh stash status after successful pop
        API.sessions.hasStash(activeSession.id).then(stashResponse => {
          if (stashResponse.success) setHasStash(stashResponse.data);
        }).catch(() => {});
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to pop stash');
    } finally {
      setIsMerging(false);
    }
  };

  const handleGitStageAndCommit = async (message: string) => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.gitStageAndCommit(activeSession.id, message);
      if (!response.success) {
        setMergeError(response.error || 'Failed to commit changes');
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to commit changes');
    } finally {
      setIsMerging(false);
    }
  };

  const handleSetUpstream = async (remoteBranch: string): Promise<boolean> => {
    if (!activeSession) return false;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response = await API.sessions.setUpstream(activeSession.id, remoteBranch);
      if (!response.success) {
        setMergeError(response.error || 'Failed to set tracking branch');
        return false;
      }
      return true;
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to set tracking branch');
      return false;
    } finally {
      setIsMerging(false);
    }
  };

  const handleRebaseMainIntoWorktree = async () => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    try {
      const response: GitErrorResponse = await API.sessions.rebaseMainIntoWorktree(activeSession.id);
      
      if (!response.success) {
        if (response.gitError) {
          const gitError = response.gitError;
          setGitErrorDetails({
            title: gitError.hasConflicts ? 'Rebase Conflicts Detected' : 'Rebase Failed',
            message: response.error || 'Failed to rebase main into worktree',
            command: gitError.command,
            output: gitError.output || 'No output available',
            workingDirectory: gitError.workingDirectory,
            isRebaseConflict: gitError.output?.toLowerCase().includes('conflict') || gitError.hasConflicts || false,
            hasConflicts: gitError.hasConflicts,
            conflictingFiles: gitError.conflictingFiles,
            conflictingCommits: gitError.conflictingCommits,
          });
          setShowGitErrorDialog(true);
        } else {
          setMergeError(response.error || 'Failed to rebase main into worktree');
        }
      } else {
        // Run this in the background and don't let it block the finally block
        API.sessions.hasChangesToRebase(activeSession.id).then(changesResponse => {
          if (changesResponse.success) setHasChangesToRebase(changesResponse.data);
        }).catch(error => {
          console.error(`[handleRebaseMainIntoWorktree] hasChangesToRebase failed`, error);
        });
      }
    } catch (error) {
      console.error(`[handleRebaseMainIntoWorktree] Error in try block`, error);
      setMergeError(error instanceof Error ? error.message : 'Failed to rebase main into worktree');
    } finally {
      setIsMerging(false);
    }
  };

  const handleAbortRebaseAndUseClaude = async () => {
    if (!activeSession) return;
    setShowGitErrorDialog(false);
    try {
      const response = await API.sessions.abortRebaseAndUseClaude(activeSession.id);
      if (response.success) {
        setMergeError(null);
        setGitErrorDetails(null);
      } else {
        setMergeError(response.error || 'Failed to abort rebase and use Claude Code');
      }
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : 'Failed to abort rebase and use Claude Code');
    }
  };
  
  const generateDefaultCommitMessage = async () => {
    if (!activeSession) return '';
    try {
      const promptsResponse = await API.sessions.getPrompts(activeSession.id);
      if (promptsResponse.success && promptsResponse.data?.length > 0) {
        return promptsResponse.data.map((p: { prompt_text: string }) => p.prompt_text).filter(Boolean).join('\n\n');
      }
    } catch (error) {
      console.error('Error generating default commit message:', error);
    }
    const comparisonBaseBranch = gitCommands?.comparisonBaseBranch || 'main';
    return dialogType === 'squash'
      ? `Squashed commits from ${gitCommands?.currentBranch || 'feature branch'}`
      : `Rebase from ${comparisonBaseBranch}`;
  };

  const handleSquashAndRebaseToMain = async () => {
    if (!activeSession) return;

    // Check if worktree needs to be rebased onto main first
    try {
      const changesResponse = await API.sessions.hasChangesToRebase(activeSession.id);
      if (changesResponse.success && changesResponse.data === true) {
        // Show warning that rebase is needed first
        setGitErrorDetails({
          title: 'Rebase Required',
          message: `Your worktree has changes from ${gitCommands?.comparisonBaseBranch || 'main'} that need to be rebased first.\n\nYou must rebase your worktree before merging to prevent conflicts.`,
          output: `Your worktree branch is behind ${gitCommands?.comparisonBaseBranch || 'main'}.\n\nClick "Rebase from ${gitCommands?.comparisonBaseBranch || 'Main'}" first to update your worktree, then try merging again.`,
          workingDirectory: activeSession.worktreePath,
        });
        setShowGitErrorDialog(true);
        return;
      }
    } catch (error) {
      console.error('Error checking if rebase needed:', error);
      // Continue with merge dialog on error - let the merge fail with proper error handling
    }

    const defaultMessage = await generateDefaultCommitMessage();
    setCommitMessage(defaultMessage);
    setDialogType('squash');
    setShouldSquash(true); // Default to squashing for cleaner merge
    setShowCommitMessageDialog(true);
  };

  const performSquashWithCommitMessage = async (message: string) => {
    if (!activeSession) return;
    setIsMerging(true);
    setMergeError(null);
    setShowCommitMessageDialog(false);
    try {
      const response: GitErrorResponse = shouldSquash
        ? await API.sessions.squashAndRebaseToMain(activeSession.id, message)
        : await API.sessions.rebaseToMain(activeSession.id);

      if (!response.success) {
        if (response.gitError) {
          const gitError = response.gitError;
          setGitErrorDetails({
            title: 'Merge Failed',
            message: response.error || `Failed to merge to main`,
            commands: gitError.commands,
            output: gitError.output || 'No output available',
            workingDirectory: gitError.workingDirectory,
            projectPath: gitError.projectPath,
          });
          setShowGitErrorDialog(true);
        } else {
          setMergeError(response.error || `Failed to merge to main`);
        }
      } else {
        // Run this in the background and don't let it block the finally block
        API.sessions.hasChangesToRebase(activeSession.id).then(changesResponse => {
          if (changesResponse.success) setHasChangesToRebase(changesResponse.data);
        }).catch(error => {
          console.error(`[performSquashWithCommitMessage] hasChangesToRebase failed`, error);
        });
      }
    } catch (error) {
      console.error(`[performSquashWithCommitMessage] Error in try block`, error);
      setMergeError(error instanceof Error ? error.message : `Failed to merge to main`);
    } finally {
      setIsMerging(false);
    }
  };

  const performSquashWithCommitMessageAndArchive = async (message: string) => {
    if (!activeSession) return;
    setIsMergingAndArchiving(true);
    setMergeError(null);
    setShowCommitMessageDialog(false);
    try {
      const response: GitErrorResponse = shouldSquash
        ? await API.sessions.squashAndRebaseToMain(activeSession.id, message)
        : await API.sessions.rebaseToMain(activeSession.id);

      if (!response.success) {
        if (response.gitError) {
          const gitError = response.gitError;
          setGitErrorDetails({
            title: 'Merge Failed',
            message: response.error || `Failed to merge to main`,
            commands: gitError.commands,
            output: gitError.output || 'No output available',
            workingDirectory: gitError.workingDirectory,
            projectPath: gitError.projectPath,
          });
          setShowGitErrorDialog(true);
        } else {
          setMergeError(response.error || `Failed to merge to main`);
        }
        return;
      }

      // Merge succeeded - check if session is in a folder with other sessions
      const sessionId = activeSession.id;
      const folderId = activeSession.folderId;

      if (folderId) {
        // Check how many sessions are in this folder
        const allSessions = useSessionStore.getState().sessions;
        const sessionsInFolder = allSessions.filter(s => s.folderId === folderId && !s.archived);

        if (sessionsInFolder.length > 1) {
          // There are other sessions in the folder - show dialog
          setFolderArchiveSessionId(sessionId);
          setFolderArchiveFolderId(folderId);
          setFolderSessionCount(sessionsInFolder.length);
          setShowFolderArchiveDialog(true);
          return; // Don't archive yet - wait for user decision
        }
      }

      // No folder or only one session in folder - archive just this session
      await archiveSingleSession(sessionId);
    } catch (error) {
      console.error(`[performSquashWithCommitMessageAndArchive] Error in try block`, error);
      setMergeError(error instanceof Error ? error.message : `Failed to merge to main`);
    } finally {
      setIsMergingAndArchiving(false);
    }
  };

  const archiveSingleSession = async (sessionId: string) => {
    useSessionStore.getState().addDeletingSessionId(sessionId);
    try {
      const archiveResponse = await API.sessions.delete(sessionId);
      if (!archiveResponse.success) {
        console.error('[archiveSingleSession] Archive failed:', archiveResponse.error);
        setMergeError(`Merge succeeded but archive failed: ${archiveResponse.error}`);
      }
      await useSessionStore.getState().setActiveSession(null);
    } catch (archiveError) {
      console.error('[archiveSingleSession] Archive error:', archiveError);
      setMergeError(`Merge succeeded but archive failed: ${archiveError instanceof Error ? archiveError.message : 'Unknown error'}`);
    }
  };

  const handleConfirmArchive = useCallback(async () => {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    useSessionStore.getState().addDeletingSessionId(sessionId);
    try {
      const response = await API.sessions.delete(sessionId);
      if (!response.success) {
        console.error('[handleConfirmArchive] Archive failed:', response.error);
        useSessionStore.getState().removeDeletingSessionId(sessionId);
        return;
      }
      await useSessionStore.getState().setActiveSession(null);
    } catch (error) {
      console.error('[handleConfirmArchive] Archive error:', error);
      useSessionStore.getState().removeDeletingSessionId(sessionId);
    }
  }, [activeSession]);

  const handleArchiveSessionOnly = async () => {
    setShowFolderArchiveDialog(false);
    if (folderArchiveSessionId) {
      await archiveSingleSession(folderArchiveSessionId);
    }
    setFolderArchiveSessionId(null);
    setFolderArchiveFolderId(null);
    setFolderSessionCount(0);
    setIsMergingAndArchiving(false);
  };

  const handleArchiveEntireFolder = async () => {
    setShowFolderArchiveDialog(false);
    if (folderArchiveFolderId) {
      const allSessions = useSessionStore.getState().sessions;
      const sessionsInFolder = allSessions.filter(s => s.folderId === folderArchiveFolderId && !s.archived);

      // Add all sessions to deleting state
      for (const session of sessionsInFolder) {
        useSessionStore.getState().addDeletingSessionId(session.id);
      }

      // Archive all sessions in the folder
      for (const session of sessionsInFolder) {
        try {
          const archiveResponse = await API.sessions.delete(session.id);
          if (!archiveResponse.success) {
            console.error(`[handleArchiveEntireFolder] Archive failed for session ${session.id}:`, archiveResponse.error);
          }
        } catch (archiveError) {
          console.error(`[handleArchiveEntireFolder] Archive error for session ${session.id}:`, archiveError);
        }
      }

      // Delete the folder after archiving all sessions
      try {
        await API.folders.delete(folderArchiveFolderId);
      } catch (folderError) {
        console.error('[handleArchiveEntireFolder] Folder delete error:', folderError);
      }

      await useSessionStore.getState().setActiveSession(null);
    }
    setFolderArchiveSessionId(null);
    setFolderArchiveFolderId(null);
    setFolderSessionCount(0);
    setIsMergingAndArchiving(false);
  };

  const handleCancelFolderArchive = () => {
    setShowFolderArchiveDialog(false);
    setFolderArchiveSessionId(null);
    setFolderArchiveFolderId(null);
    setFolderSessionCount(0);
    setIsMergingAndArchiving(false);
  };


  const getGitErrorTips = (details: GitErrorDetails): string[] => {
    const tips: string[] = [];
    const output = details.output?.toLowerCase() || '';
    const message = details.message?.toLowerCase() || '';
    
    // Check if conflicts were detected before rebase (new pre-check)
    if (details.hasConflicts) {
      tips.push('• Conflicts were detected before starting the rebase');
      tips.push('• Click "Use Claude Code to Resolve" to let Claude handle the conflicts');
      tips.push('• Alternatively, you can manually resolve conflicts by:');
      tips.push('  1. Running the rebase manually: git rebase <branch>');
      tips.push('  2. Fixing conflicts in the listed files');
      tips.push('  3. Running: git add <fixed-files> && git rebase --continue');
      if (details.conflictingFiles && details.conflictingFiles.length > 0) {
        tips.push(`• ${details.conflictingFiles.length} file(s) have conflicts that need resolution`);
      }
    } else if (output.includes('conflict') || message.includes('conflict')) {
      tips.push('• You have merge conflicts that need to be resolved manually');
      tips.push('• Use "git status" to see conflicted files');
      tips.push('• Edit the conflicted files to resolve conflicts, then stage and commit');
      tips.push('• After resolving, run "git rebase --continue" or "git rebase --abort"');
    } else if (output.includes('uncommitted changes') || output.includes('unstaged changes')) {
      tips.push('• You have uncommitted changes that prevent the operation');
      tips.push('• Either commit your changes first or stash them with "git stash"');
      tips.push('• After the operation, you can apply stashed changes with "git stash pop"');
    } else {
      tips.push('• Check if you have uncommitted changes that need to be resolved');
      tips.push('• Verify that the main branch exists and is up to date');
    }
    return tips;
  };


  return {
    isMerging,
    isMergingAndArchiving,
    mergeError,
    gitCommands,
    hasChangesToRebase,
    hasStash,
    showCommitMessageDialog,
    setShowCommitMessageDialog,
    commitMessage,
    setCommitMessage,
    dialogType,
    setDialogType,
    showGitErrorDialog,
    setShowGitErrorDialog,
    gitErrorDetails,
    shouldSquash,
    setShouldSquash,
    handleGitPull,
    handleGitPush,
    handleGitSoftReset,
    handleGitFetch,
    handleGitStash,
    handleGitStashPop,
    handleGitStageAndCommit,
    handleSetUpstream,
    handleRebaseMainIntoWorktree,
    handleAbortRebaseAndUseClaude,
    handleSquashAndRebaseToMain,
    performSquashWithCommitMessage,
    performSquashWithCommitMessageAndArchive,
    getGitErrorTips,
    // Archive confirm dialog (Ctrl+Shift+W)
    showArchiveConfirm,
    setShowArchiveConfirm,
    handleConfirmArchive,
    // Folder archive dialog
    showFolderArchiveDialog,
    folderSessionCount,
    handleArchiveSessionOnly,
    handleArchiveEntireFolder,
    handleCancelFolderArchive,
  };
};
