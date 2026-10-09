import { EventEmitter } from 'events';
import type { ArchiveProgressSnapshot, ArchiveProgressTask } from '../../../shared/types/archiveProgress';

export interface ArchiveTask {
  sessionId: string;
  sessionName: string;
  worktreeName: string;
  projectName: string;
  /**
   * Lifecycle stage of this archive task.
   *
   * - `queued`                — Task is waiting in the serial queue.
   * - `pending`               — Task has been dequeued and its callback is about to run.
   * - `running-archive-script`— The project's archive script (from DB or pane.json) is
   *                             executing inside the worktree. Set by `ipc/session.ts`
   *                             `cleanupCallback` before calling `sessionManager.runArchiveScript`.
   * - `removing-worktree`     — `worktreeManager.removeWorktree` is in progress.
   * - `cleaning-artifacts`    — Session artefact files (screenshots etc.) are being deleted.
   * - `completed`             — All steps finished successfully.
   * - `failed`                — A step threw an unrecoverable error.
   */
  status: 'pending' | 'queued' | 'running-archive-script' | 'removing-worktree' | 'cleaning-artifacts' | 'completed' | 'failed';
  startTime: Date;
  endTime?: Date;
  error?: string;
  /** Once the worktree is removed: whether its files are deleted, or still being deleted in the background. */
  trashDeletion?: 'pending' | 'done';
  executeCallback?: () => Promise<void>;
}

export class ArchiveProgressManager extends EventEmitter {
  private activeTasks: Map<string, ArchiveTask> = new Map();
  private taskQueue: ArchiveTask[] = [];
  private isProcessing: boolean = false;
  private executingTasks = new Set<string>();
  private failures = new Map<string, string>();
  private durableTasks?: () => ArchiveProgressTask[];

  setDurableTasks(read: () => ArchiveProgressTask[]): void {
    this.durableTasks = read;
  }

  publishDurableTasks(): void {
    this.emitProgress();
  }

  addTask(
    sessionId: string, 
    sessionName: string, 
    worktreeName: string,
    projectName: string,
    executeCallback?: () => Promise<void>
  ): void {
    const task: ArchiveTask = {
      sessionId,
      sessionName,
      worktreeName,
      projectName,
      status: 'queued',
      startTime: new Date(),
      executeCallback
    };
    
    this.activeTasks.set(sessionId, task);
    this.taskQueue.push(task);
    console.log(`[ArchiveProgressManager] queued sessionId=${sessionId} sessionName=${JSON.stringify(sessionName)} worktreeName=${JSON.stringify(worktreeName)} projectName=${JSON.stringify(projectName)} queueLength=${this.taskQueue.length}`);
    this.emitProgress();
    
    // Start processing if not already processing
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.taskQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      if (!task) continue;

      // Update status to pending (actively processing)
      task.status = 'pending';
      console.log(`[ArchiveProgressManager] pending sessionId=${task.sessionId} worktreeName=${JSON.stringify(task.worktreeName)} remainingQueue=${this.taskQueue.length}`);
      this.emitProgress();

      if (task.executeCallback) {
        this.executingTasks.add(task.sessionId);
        try {
          console.log(`[ArchiveProgressManager] Starting archive for session ${task.sessionId}`);
          await task.executeCallback();
        } catch (error) {
          console.error(`[ArchiveProgressManager] Error processing archive for session ${task.sessionId}:`, error);
          this.updateTaskStatus(task.sessionId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        } finally {
          this.executingTasks.delete(task.sessionId);
          const failure = this.failures.get(task.sessionId);
          this.failures.delete(task.sessionId);
          this.updateTaskStatus(task.sessionId, failure === undefined ? 'completed' : 'failed', failure);
        }
      }
    }

    this.isProcessing = false;
    console.log('[ArchiveProgressManager] Queue processing completed');
  }

  updateTaskStatus(sessionId: string, status: ArchiveTask['status'], error?: string): void {
    const task = this.activeTasks.get(sessionId);
    if (!task) return;

    // A failure is a result, not the end of the callback: artifact cleanup
    // still needs shutdown protection and must remain visible as active.
    if (this.executingTasks.has(sessionId) && (status === 'failed' || status === 'completed')) {
      if (status === 'failed') {
        const failure = error ?? 'Archive cleanup failed';
        this.failures.set(sessionId, failure);
        task.error = failure;
      }
      this.emitProgress();
      return;
    }

    task.status = status;
    console.log(`[ArchiveProgressManager] status sessionId=${sessionId} status=${status}${error ? ` error=${JSON.stringify(error)}` : ''}`);
    
    if (error) {
      task.error = error;
    }
    
    if (status === 'completed' || status === 'failed') {
      task.endTime = new Date();
    }
    
    this.emitProgress();
    
    // Remove completed/failed tasks after a delay to show completion
    if (status === 'completed' || status === 'failed') {
      setTimeout(() => {
        this.activeTasks.delete(sessionId);
        this.emitProgress();
      }, 3000); // Keep visible for 3 seconds
    }
  }

  setTrashDeletion(sessionId: string, trashDeletion: 'pending' | 'done'): void {
    const task = this.activeTasks.get(sessionId);
    if (task) task.trashDeletion = trashDeletion;
  }

  getActiveTasks(): ArchiveProgressTask[] {
    // Return a serializable version without the executeCallback
    const transient = Array.from(this.activeTasks.values()).map(task => ({
      sessionId: task.sessionId,
      sessionName: task.sessionName,
      worktreeName: task.worktreeName,
      projectName: task.projectName,
      status: task.status,
      startTime: task.startTime.toISOString(),
      endTime: task.endTime?.toISOString(),
      error: task.error,
      trashDeletion: task.trashDeletion,
    }));
    // Newest first by start time: running work sits above finished history, and a
    // row moves only when a newer archive starts above it, never on a status change.
    return [...transient, ...(this.durableTasks?.() ?? [])]
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
  }

  hasActiveTasks(): boolean {
    // Consider both active tasks and queued tasks
    const hasActive = this.getActiveTasks().some(
      task => task.status !== 'completed' && task.status !== 'failed'
    );
    return hasActive || this.taskQueue.length > 0;
  }

  getActiveTaskCount(): number {
    return this.getActiveTasks().length;
  }

  getQueuedTaskCount(): number {
    return this.taskQueue.length;
  }

  getProgress(): ArchiveProgressSnapshot {
    const tasks = this.getActiveTasks();
    const activeCount = tasks.filter(t =>
      t.status !== 'completed' && t.status !== 'failed'
    ).length;
    return { tasks, activeCount, totalCount: tasks.length };
  }

  private emitProgress(): void {
    const progress = this.getProgress();
    console.log('[ArchiveProgressManager] Emitting progress:', {
      tasks: progress.totalCount,
      activeCount: progress.activeCount,
      totalCount: progress.totalCount
    });
    this.emit('archive-progress', progress);
  }

  clearAll(): void {
    this.activeTasks.clear();
    this.emitProgress();
  }
}
