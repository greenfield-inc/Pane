import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { ScheduleManager } from '../services/scheduleManager';
import { ScheduleRepository } from '../services/scheduleRepository';
import { databaseService } from '../services/database';
import { validateScheduledRunInput } from '../services/scheduleValidation';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { scheduledRunInputSchema } from '../../../shared/types/schedule';
import type { PaneCommandValue } from '../daemon/commandRegistry';

const DAEMON_SCHEDULE_CHANNELS = [
  'schedules:list',
  'schedules:save',
  'schedules:delete',
  'schedules:set-enabled',
  'schedules:run-now',
] as const;

/**
 * Recurring agent runs.
 *
 * Daemon-owned: a schedule starts a session in a worktree on the machine that
 * runs the agents, and it has to keep firing while no window is open — which is
 * exactly what the daemon is for.
 */
export function registerScheduleHandlers(
  ipcMain: IpcMain,
  { taskQueue }: AppServices,
  commandRegistry: PaneCommandRegistry,
): ScheduleManager {
  const repository = new ScheduleRepository(() => databaseService.getDb());

  const scheduleManager = new ScheduleManager(repository, async input => {
    if (!taskQueue) throw new Error('Task queue not initialised');

    // The same call the create dialog makes, so a scheduled session is
    // indistinguishable from one started by hand — but waiting for the queue,
    // because the job id is not a session id and the schedule list links to
    // the session it produced.
    const result = await taskQueue.createSessionAndWait({
      prompt: input.prompt,
      worktreeTemplate: input.worktreeTemplate,
      projectId: input.projectId,
      toolType: input.toolType,
    });

    return { sessionId: result.sessionId };
  });

  commandRegistry.register('schedules:list', async (value?: PaneCommandValue) => {
    try {
      const projectId = decodeBoundary(value, boundary.optional(boundary.number));
      const data = scheduleManager.list(Number.isFinite(projectId) ? projectId : undefined);
      return { success: true, data };
    } catch (error) {
      console.error('[Schedule] Failed to list schedules:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list schedules' };
    }
  });

  commandRegistry.register('schedules:save', async (value: PaneCommandValue) => {
    try {
      const input = decodeBoundary(value, scheduledRunInputSchema);
      const result = validateScheduledRunInput(input);
      if (!result.success) return result;
      return { success: true, data: scheduleManager.save(result.data) };
    } catch (error) {
      console.error('[Schedule] Failed to save schedule:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save the schedule' };
    }
  });

  commandRegistry.register('schedules:delete', async (id: string) => {
    try {
      scheduleManager.delete(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete the schedule' };
    }
  });

  commandRegistry.register('schedules:set-enabled', async (id: string, enabled: boolean) => {
    try {
      const data = scheduleManager.setEnabled(id, Boolean(enabled));
      if (!data) return { success: false, error: 'Schedule not found' };
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update the schedule' };
    }
  });

  commandRegistry.register('schedules:run-now', async (id: string) => {
    try {
      const data = await scheduleManager.runNow(id);
      if (!data) return { success: false, error: 'Schedule not found' };
      if (data.lastRunStatus === 'failed') {
        return { success: false, error: data.lastRunError ?? 'The run failed to start' };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start the run' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_SCHEDULE_CHANNELS);

  return scheduleManager;
}
