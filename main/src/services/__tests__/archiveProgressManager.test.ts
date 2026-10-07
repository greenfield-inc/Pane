import { describe, expect, it } from 'vitest';
import { ArchiveProgressManager } from '../archiveProgressManager';
import type { ArchiveProgressTask } from '../../../../shared/types/archiveProgress';

const durable = (sessionId: string, startTime: string, status: ArchiveProgressTask['status']): ArchiveProgressTask => ({
  sessionId, sessionName: sessionId, worktreeName: sessionId, projectName: 'Repository', status, startTime, cleanupId: `job-${sessionId}`,
});

describe('ArchiveProgressManager.getProgress', () => {
  it('lists tasks newest first, whichever store holds them and whatever their status', () => {
    const manager = new ArchiveProgressManager();
    // The durable store lists unfinished jobs before completed ones.
    let durableTasks = [
      durable('older', '2026-01-01T00:00:01.000Z', 'removing-worktree'),
      durable('newer', '2026-01-01T00:00:03.000Z', 'completed'),
    ];
    manager.setDurableTasks(() => durableTasks);
    manager.addTask('in-memory', 'in-memory', 'in-memory', 'Repository');

    expect(manager.getProgress().tasks.map(task => task.sessionId)).toEqual(['in-memory', 'newer', 'older']);

    durableTasks = [
      durable('older', '2026-01-01T00:00:01.000Z', 'completed'),
      durable('newer', '2026-01-01T00:00:03.000Z', 'completed'),
    ].reverse();
    expect(manager.getProgress().tasks.map(task => task.sessionId)).toEqual(['in-memory', 'newer', 'older']);
  });
});
