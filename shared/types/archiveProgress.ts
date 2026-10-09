/** One archive job, as `ArchiveProgressManager` reports it. */
export interface ArchiveProgressTask {
  sessionId: string;
  sessionName: string;
  worktreeName: string;
  projectName: string;
  status: 'pending' | 'queued' | 'running-archive-script' | 'removing-worktree' | 'cleaning-artifacts' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  error?: string;
  /** Once the worktree is removed: whether its files are deleted, or still being deleted in the background. */
  trashDeletion?: 'pending' | 'done';
  cleanupId?: string;
  attempts?: number;
  nextAttempt?: number;
  remainingPath?: string;
  interruptedScript?: boolean;
}

/** Returned by `archive:get-progress` and sent on `archive:progress`. */
export interface ArchiveProgressSnapshot {
  tasks: ArchiveProgressTask[];
  activeCount: number;
  totalCount: number;
}
