import { useState, useEffect, useId, useCallback, useRef } from 'react';
import { Loader2, Archive, CheckCircle, AlertCircle } from 'lucide-react';
import { LiveRegion } from './ui/LiveRegion';
import type { ArchiveProgressSnapshot, ArchiveProgressTask } from '../../../shared/types/archiveProgress';

function getStatusIcon(status: ArchiveProgressTask['status']) {
  switch (status) {
    case 'completed':
      return <CheckCircle className="w-3 h-3 text-status-success" />;
    case 'failed':
      return <AlertCircle className="w-3 h-3 text-status-error" />;
    case 'queued':
      return <Archive className="w-3 h-3 text-status-waiting" />;
    default:
      return <Loader2 className="w-3 h-3 text-status-info animate-spin" />;
  }
}

function getStatusText(status: ArchiveProgressTask['status']) {
  switch (status) {
    case 'queued':
      return 'Queued (waiting for other archives to complete)...';
    case 'pending':
      return 'Preparing...';
    case 'running-archive-script':
      return 'Running archive script...';
    case 'removing-worktree':
      return 'Removing worktree (this may take a while)...';
    case 'cleaning-artifacts':
      return 'Cleaning artifacts...';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

export function ArchiveProgress() {
  const taskListId = useId();
  const [progress, setProgress] = useState<ArchiveProgressSnapshot | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const failedIds = useRef<Set<string> | null>(null);
  const hasActiveTasks = (progress?.activeCount ?? 0) > 0;

  // The panel stays as the user left it; only a failure that appears after a host's first snapshot opens it.
  const applyProgress = useCallback((data: ArchiveProgressSnapshot | null) => {
    const failed = new Set(data?.tasks.filter(task => task.status === 'failed').map(task => task.sessionId));
    const seen = failedIds.current;
    if (seen && [...failed].some(id => !seen.has(id))) setIsExpanded(true);
    failedIds.current = failed;
    setProgress(data);
  }, []);

  // Archive jobs run on the active host, so read them through the daemon and reload on a host switch.
  const loadProgress = useCallback(async () => {
    try {
      const response = await window.electronAPI.invoke('archive:get-progress');
      if (response.success) {
        applyProgress(response.data);
      }
    } catch (error) {
      console.error('Failed to load archive progress:', error);
    }
  }, [applyProgress]);

  const retryCleanup = async (task: ArchiveProgressTask) => {
    setRetrying(task.sessionId);
    setRetryError(null);
    try {
      const response = await window.electronAPI.invoke('archive:retry-cleanup', task.sessionId, task.interruptedScript === true);
      if (!response.success) setRetryError(response.error || 'Could not retry cleanup');
      await loadProgress();
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : 'Could not retry cleanup');
    } finally {
      setRetrying(null);
    }
  };

  useEffect(() => {
    void loadProgress();
    const unsubscribeProgress = window.electronAPI.events.onArchiveProgress(applyProgress);
    const unsubscribeResync = window.electronAPI.events.onRemoteDaemonResyncRequested?.(() => {
      failedIds.current = null;
      void loadProgress();
    });
    return () => {
      unsubscribeProgress();
      unsubscribeResync?.();
    };
  }, [applyProgress, loadProgress]);

  // Refresh elapsed times while a job runs.
  useEffect(() => {
    if (!hasActiveTasks) return;
    const interval = setInterval(() => void loadProgress(), 2000);
    return () => clearInterval(interval);
  }, [hasActiveTasks, loadProgress]);

  const completedCount = progress?.tasks.filter(task => task.status === 'completed').length ?? 0;
  const failedTask = progress?.tasks.find(task => task.status === 'failed');
  const archiveAnnouncement = progress && progress.totalCount > 0
    ? progress.activeCount > 0
      ? `Archiving ${progress.activeCount} ${progress.activeCount === 1 ? 'pane' : 'panes'}`
      : completedCount === progress.totalCount
        ? `Archive complete for ${completedCount} ${completedCount === 1 ? 'pane' : 'panes'}`
        : ''
    : '';

  if (!progress || progress.totalCount === 0) {
    return <LiveRegion>{archiveAnnouncement}</LiveRegion>;
  }

  const formatElapsedTime = (startTime: string, endTime?: string) => {
    const start = new Date(startTime).getTime();
    const end = endTime ? new Date(endTime).getTime() : Date.now();
    const elapsed = Math.floor((end - start) / 1000);
    
    if (elapsed < 60) {
      return `${elapsed}s`;
    }
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return `${minutes}m ${seconds}s`;
  };

  return (
    <div className="border-t border-border-primary flex-shrink-0">
      <LiveRegion>{archiveAnnouncement}</LiveRegion>
      {retryError && <div role="alert" className="px-4 py-2 text-xs text-status-error">{retryError}</div>}
      <LiveRegion mode="assertive">{failedTask ? `Archive failed for ${failedTask.sessionName}: ${failedTask.error ?? 'Unknown error'}` : ''}</LiveRegion>
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls={taskListId}
        className="w-full px-4 py-2 flex items-center justify-between hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <Archive className={`w-3.5 h-3.5 ${hasActiveTasks ? 'text-status-info animate-pulse' : 'text-text-tertiary'}`} />
          <span className="text-xs text-text-tertiary">
            Archive Tasks
          </span>
          {progress.activeCount > 0 && (
            <span className="px-1.5 py-0.5 bg-status-info/20 text-status-info text-xs rounded-full animate-pulse">
              {progress.activeCount} active
            </span>
          )}
          {progress.tasks.filter(t => t.status === 'queued').length > 0 && (
            <span className="px-1.5 py-0.5 bg-status-waiting/20 text-status-waiting text-xs rounded-full">
              {progress.tasks.filter(t => t.status === 'queued').length} queued
            </span>
          )}
        </div>
        <svg
          className={`w-3.5 h-3.5 text-text-tertiary transition-transform ${
            isExpanded ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isExpanded && (
        <div id={taskListId} className="border-t border-border-primary max-h-48 overflow-y-auto bg-surface-secondary">
          {progress.tasks.length === 0 ? (
            <div className="px-4 py-2 text-xs text-text-tertiary">
              No archive tasks
            </div>
          ) : (
            <div className="divide-y divide-border-primary">
              {progress.tasks.map((task) => (
                <div key={task.sessionId} className="px-4 py-2 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 flex-1 min-w-0">
                      {getStatusIcon(task.status)}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-text-secondary truncate" title={task.sessionName}>
                          {task.sessionName}
                        </div>
                        <div className="text-xs text-text-tertiary truncate">
                          {task.projectName} / {task.worktreeName}
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-text-tertiary whitespace-nowrap">
                      {formatElapsedTime(task.startTime, task.endTime)}
                    </span>
                  </div>
                  <div className="text-xs text-text-tertiary pl-5">
                    {getStatusText(task.status)}
                  </div>
                  {task.error && (
                    <div className="select-text text-xs text-status-error pl-5 mt-1">
                      {task.error}
                    </div>
                  )}
                  {task.cleanupId && (
                    <div className="text-xs text-text-tertiary pl-5 space-y-1">
                      {task.status !== 'completed' && <div>Archived; cleanup {task.status === 'failed' ? 'needs attention' : 'pending'}</div>}
                      {task.remainingPath && task.status === 'failed' && <div className="break-all select-text">{task.remainingPath}</div>}
                      {(task.attempts ?? 0) > 0 && <div>Failed attempts: {task.attempts}</div>}
                      {task.nextAttempt && task.status === 'queued' && <div>Retry scheduled for {new Date(task.nextAttempt).toLocaleTimeString()}</div>}
                      {task.status === 'failed' && (
                        <button type="button" disabled={retrying === task.sessionId}
                          className="text-text-primary underline disabled:opacity-50"
                          onClick={() => void retryCleanup(task)}>
                          {task.interruptedScript ? 'Retry cleanup (skip interrupted script)' : 'Retry cleanup'}
                        </button>
                      )}
                    </div>
                  )}
                  {task.status === 'removing-worktree' && (
                    <div className="text-xs text-status-warning/80 pl-5 mt-1 italic">
                      ⚠️ Worktree removal can take several minutes for large repositories
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
