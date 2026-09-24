import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Download, GitCommitHorizontal, RefreshCw, Undo2, Upload } from 'lucide-react';
import { API } from '../utils/api';
import type { GitCommands, Session } from '../types/session';
import { useConfigStore } from '../stores/configStore';
import { useErrorStore } from '../stores/errorStore';

interface GitOperationResponse {
  success: boolean;
  error?: string;
}

export function useMainRepoGitActions(sessionId: string | null, session: Session | null) {
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gitCommands, setGitCommands] = useState<GitCommands | null>(null);
  const [hasStash, setHasStash] = useState(false);
  const [currentUpstream, setCurrentUpstream] = useState<string | null>(null);
  const [isUpstreamLoaded, setIsUpstreamLoaded] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [showSetTrackingDialog, setShowSetTrackingDialog] = useState(false);
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const isRemoteMode = useConfigStore((state) => state.config?.remoteDaemon?.client.mode === 'remote');

  const refreshStashState = useCallback(async () => {
    if (!sessionId) return;
    const response = await API.sessions.hasStash(sessionId);
    if (response.success) setHasStash(response.data);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setGitCommands(null);
      setHasStash(false);
      setCurrentUpstream(null);
      setIsUpstreamLoaded(false);
      return;
    }

    setIsUpstreamLoaded(false);
    let cancelled = false;
    Promise.all([
      API.sessions.getGitCommands(sessionId),
      API.sessions.hasStash(sessionId),
      API.sessions.getUpstream(sessionId),
    ]).then(([commandsResponse, stashResponse, upstreamResponse]) => {
      if (cancelled) return;
      if (commandsResponse.success) setGitCommands(commandsResponse.data);
      if (stashResponse.success) setHasStash(stashResponse.data);
      if (upstreamResponse.success) {
        setCurrentUpstream(upstreamResponse.data);
        setIsUpstreamLoaded(true);
      }
    }).catch((loadError) => {
      if (!cancelled) console.error('Failed to load main checkout Git data:', loadError);
    });

    return () => { cancelled = true; };
  }, [sessionId]);

  const runOperation = useCallback(async (
    operation: (activeSessionId: string) => Promise<GitOperationResponse>,
    failureMessage: string,
  ): Promise<boolean> => {
    if (!sessionId) return false;
    setIsRunning(true);
    setError(null);
    try {
      const response = await operation(sessionId);
      if (!response.success) {
        setError(response.error || failureMessage);
        return false;
      }
      return true;
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : failureMessage);
      return false;
    } finally {
      setIsRunning(false);
    }
  }, [sessionId]);

  const handleFetch = useCallback(() => {
    void runOperation(API.sessions.gitFetch, 'Failed to fetch from remote');
  }, [runOperation]);
  const handlePull = useCallback(() => {
    void runOperation(API.sessions.gitPull, 'Failed to pull from remote');
  }, [runOperation]);
  const handlePush = useCallback(() => {
    void runOperation(API.sessions.gitPush, 'Failed to push to remote');
  }, [runOperation]);
  const handleStash = useCallback(() => {
    void runOperation(API.sessions.gitStash, 'Failed to stash changes').then((success) => {
      if (success) void refreshStashState();
    });
  }, [refreshStashState, runOperation]);
  const handleStashPop = useCallback(() => {
    void runOperation(API.sessions.gitStashPop, 'Failed to pop stash').then((success) => {
      if (success) void refreshStashState();
    });
  }, [refreshStashState, runOperation]);
  const handleSoftReset = useCallback(() => {
    void runOperation(API.sessions.gitSoftReset, 'Failed to undo commit');
  }, [runOperation]);
  const handleCommit = useCallback((message: string) => {
    setShowCommitDialog(false);
    void runOperation(
      (activeSessionId) => API.sessions.gitStageAndCommit(activeSessionId, message),
      'Failed to commit changes',
    );
  }, [runOperation]);

  const handleOpenSetTracking = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [branchesResponse, upstreamResponse] = await Promise.all([
        API.sessions.getRemoteBranches(sessionId),
        API.sessions.getUpstream(sessionId),
      ]);
      if (branchesResponse.success) setRemoteBranches(branchesResponse.data || []);
      if (upstreamResponse.success) setCurrentUpstream(upstreamResponse.data);
      setShowSetTrackingDialog(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load remote branches');
    }
  }, [sessionId]);

  const handleSelectUpstream = useCallback((branch: string) => {
    setShowSetTrackingDialog(false);
    void runOperation(
      (activeSessionId) => API.sessions.setUpstream(activeSessionId, branch),
      'Failed to set tracking branch',
    ).then((success) => {
      if (success) setCurrentUpstream(branch);
    });
  }, [runOperation]);

  const handleOpenIDE = useCallback(async (ideKey?: string) => {
    if (!sessionId || isRemoteMode) return;
    try {
      const response = await API.sessions.openIDE(sessionId, ideKey);
      if (!response.success) {
        useErrorStore.getState().showError({
          title: 'Failed to open IDE',
          error: response.error || 'Unknown error occurred',
        });
      }
    } catch (openError) {
      useErrorStore.getState().showError({
        title: 'Failed to open IDE',
        error: openError instanceof Error ? openError.message : 'Unknown error occurred',
      });
    }
  }, [isRemoteMode, sessionId]);

  const sessionBusy = session?.status === 'running' || session?.status === 'initializing';
  const actionsBusy = isRunning || sessionBusy;
  const busyReason = isRunning
    ? 'Git operation already in progress'
    : sessionBusy
      ? 'Session is currently running'
      : undefined;
  const gitStatus = session?.gitStatus;
  const actions = useMemo(() => [
    {
      id: 'fetch', label: 'Fetch', icon: RefreshCw, onClick: handleFetch,
      disabled: actionsBusy, variant: 'default' as const,
      description: `Fetch remote updates for ${gitCommands?.currentBranch || 'the current branch'} without merging`,
      disabledReason: busyReason,
    },
    {
      id: 'stash', label: 'Stash', icon: Archive, onClick: handleStash,
      disabled: actionsBusy || !gitStatus?.hasUncommittedChanges, variant: 'default' as const,
      description: gitStatus?.hasUncommittedChanges
        ? 'Stash changes from the main checkout in the repository-wide stash stack'
        : 'No changes to stash',
      disabledReason: busyReason ?? (gitStatus?.hasUncommittedChanges ? undefined : 'No changes to stash'),
    },
    {
      id: 'stash-pop', label: 'Pop', icon: ArchiveRestore, onClick: handleStashPop,
      disabled: actionsBusy || !hasStash, variant: 'default' as const,
      description: hasStash
        ? 'Apply and remove the newest repository stash (shared by all worktrees)'
        : 'No stash to pop',
      disabledReason: busyReason ?? (hasStash ? undefined : 'No stash to pop'),
    },
    {
      id: 'commit', label: 'Commit', icon: GitCommitHorizontal,
      onClick: () => setShowCommitDialog(true),
      disabled: actionsBusy || (!gitStatus?.hasUncommittedChanges && !gitStatus?.hasUntrackedFiles),
      variant: 'default' as const,
      description: (gitStatus?.hasUncommittedChanges || gitStatus?.hasUntrackedFiles)
        ? `Stage all changes and commit on ${gitCommands?.currentBranch || 'the current branch'}`
        : 'No changes to commit',
      disabledReason: busyReason ?? ((gitStatus?.hasUncommittedChanges || gitStatus?.hasUntrackedFiles) ? undefined : 'No changes to commit'),
    },
    {
      id: 'undo-commit', label: 'Undo Commit', icon: Undo2, onClick: handleSoftReset,
      disabled: actionsBusy || !gitStatus?.ahead, variant: 'default' as const,
      description: gitStatus?.ahead
        ? 'Undo the latest unpushed commit on the main checkout, keeping changes staged'
        : 'No unpushed commits to undo',
      disabledReason: busyReason ?? (gitStatus?.ahead ? undefined : 'No unpushed commits to undo'),
    },
    {
      id: 'pull', label: 'Pull', icon: Download, onClick: handlePull,
      disabled: actionsBusy, variant: 'default' as const,
      description: `Pull remote changes into ${gitCommands?.currentBranch || 'the current branch'}`,
      disabledReason: busyReason,
    },
    {
      id: 'push', label: 'Push', icon: Upload, onClick: handlePush,
      disabled: actionsBusy || !isUpstreamLoaded || (!!currentUpstream && !gitStatus?.ahead), variant: 'default' as const,
      description: !isUpstreamLoaded
        ? 'Checking remote tracking branch'
        : !currentUpstream
          ? `Publish ${gitCommands?.currentBranch || 'the current branch'} to origin and set its upstream`
          : gitStatus?.ahead
            ? `Push ${gitStatus.ahead} commit(s) from ${gitCommands?.currentBranch || 'the current branch'}`
            : 'No commits to push',
      disabledReason: busyReason ?? (!isUpstreamLoaded
        ? 'Checking remote tracking branch'
        : currentUpstream && !gitStatus?.ahead ? 'No commits to push' : undefined),
    },
  ], [actionsBusy, busyReason, currentUpstream, gitCommands?.currentBranch, gitStatus, handleFetch, handlePull, handlePush, handleSoftReset, handleStash, handleStashPop, hasStash, isUpstreamLoaded]);

  return {
    actions,
    actionsBusy,
    currentUpstream,
    error,
    gitCommands,
    handleCommit,
    handleOpenIDE,
    handleOpenSetTracking,
    handleSelectUpstream,
    isRemoteMode,
    isRunning,
    remoteBranches,
    setShowCommitDialog,
    setShowSetTrackingDialog,
    showCommitDialog,
    showSetTrackingDialog,
  };
}
