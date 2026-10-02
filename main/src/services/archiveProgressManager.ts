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
        try {
          console.log(`[ArchiveProgressManager] Starting archive for session ${task.sessionId}`);
          await task.executeCallback();
          
          // If the task wasn't explicitly marked as failed, mark it as completed
          const currentTask = this.activeTasks.get(task.sessionId);
          if (currentTask && currentTask.status !== 'failed') {
            this.updateTaskStatus(task.sessionId, 'completed');
          }
        } catch (error) {
          console.error(`[ArchiveProgressManager] Error processing archive for session ${task.sessionId}:`, error);
          this.updateTaskStatus(task.sessionId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }

    this.isProcessing = false;
    console.log('[ArchiveProgressManager] Queue processing completed');
  }

  updateTaskStatus(sessionId: string, status: ArchiveTask['status'], error?: string): void {
    const task = this.activeTasks.get(sessionId);
    if (!task) return;

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
    return Array.from(this.activeTasks.values()).map(task => ({
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
  }

  hasActiveTasks(): boolean {
    // Consider both active tasks and queued tasks
    const hasActive = Array.from(this.activeTasks.values()).some(
      task => task.status !== 'completed' && task.status !== 'failed'
    );
    return hasActive || this.taskQueue.length > 0;
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
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
