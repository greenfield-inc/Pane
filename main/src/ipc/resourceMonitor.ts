import type { IpcMain } from 'electron';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { resourceMonitorService } from '../services/resourceMonitorService';
import { RECLAIM_KINDS, MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL, MACHINE_HEALTH_FINISHED_CHANNEL, MACHINE_HEALTH_CLEANUP_CHANNEL, MACHINE_HEALTH_HISTORY_CHANNEL, MACHINE_HEALTH_INVENTORY_CHANNEL, MACHINE_HEALTH_SNAPSHOT_CHANNEL } from '../../../shared/types/machineHealth';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const inventoryRequestSchema = boundary.object({ refresh: boundary.optional(boundary.boolean) });
const archiveFinishedSchema = boundary.object({
  ids: boundary.array(boundary.string),
  source: boundary.enumeration('ui', 'card', 'cli'),
});
const cleanupRequestSchema = boundary.object({
  ids: boundary.optional(boundary.array(boundary.string)),
  kinds: boundary.optional(boundary.array(boundary.enumeration(...RECLAIM_KINDS))),
  source: boundary.enumeration('ui', 'card', 'cli'),
});
import { PaneError } from '../../../shared/paneError';

const DAEMON_RESOURCE_MONITOR_CHANNELS = [
  'resource-monitor:get-snapshot',
  MACHINE_HEALTH_SNAPSHOT_CHANNEL,
  MACHINE_HEALTH_INVENTORY_CHANNEL,
  MACHINE_HEALTH_CLEANUP_CHANNEL,
  MACHINE_HEALTH_HISTORY_CHANNEL,
  MACHINE_HEALTH_FINISHED_CHANNEL,
  MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL,
] as const;

export function registerResourceMonitorHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('resource-monitor:get-snapshot', async () => {
    try {
      const snapshot = await resourceMonitorService.getSnapshot();
      return { success: true, data: snapshot };
    } catch (error) {
      console.error('[IPC] Failed to get resource snapshot:', error);
      return { success: false, error: (error instanceof Error) ? error.message : String(error) };
    }
  });

  const machineHealth = () => {
    if (!services.machineHealth) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Machine health is not running in this Pane process.', 'Restart Pane, then try again.');
    }
    return services.machineHealth;
  };
  commandRegistry.register(MACHINE_HEALTH_SNAPSHOT_CHANNEL, async () => machineHealth().getSnapshot());
  /** The last storage inventory, or null before the first scan; `{ refresh: true }` also starts a new scan in the background. */
  commandRegistry.register(MACHINE_HEALTH_INVENTORY_CHANNEL, async (value: PaneCommandValue) =>
    machineHealth().getInventory(decodeBoundary(value ?? {}, inventoryRequestSchema).refresh === true));
  const cleanup = () => {
    if (!services.machineCleanup) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Cleanup does not run in this Pane process: another Pane serves this data folder.', 'Run the cleanup from the Pane that owns this data folder.');
    }
    return services.machineCleanup;
  };
  commandRegistry.register(MACHINE_HEALTH_CLEANUP_CHANNEL, async (value: PaneCommandValue) => {
    const request = decodeBoundary(value, cleanupRequestSchema);
    const run = await cleanup().run({ ...request, tiers: [1, 2] });
    // Refresh in the background so Resources shows what is left.
    void machineHealth().scanInventory().catch(() => undefined);
    return run;
  });
  commandRegistry.register(MACHINE_HEALTH_HISTORY_CHANNEL, async () => cleanup().history());
  const finished = () => {
    if (!services.finishedPanes) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Finished-Pane checks do not run in this Pane process.', 'Restart Pane, then try again.');
    }
    return services.finishedPanes;
  };
  commandRegistry.register(MACHINE_HEALTH_FINISHED_CHANNEL, async (value: PaneCommandValue) =>
    finished().list(decodeBoundary(value ?? {}, inventoryRequestSchema).refresh === true));
  commandRegistry.register(MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL, async (value: PaneCommandValue) => {
    const request = decodeBoundary(value, archiveFinishedSchema);
    return finished().archive(request.ids, request.source);
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_RESOURCE_MONITOR_CHANNELS);
}
