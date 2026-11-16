import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { resourceMonitorService } from '../services/resourceMonitorService';
import { MACHINE_HEALTH_SNAPSHOT_CHANNEL } from '../../../shared/types/machineHealth';
import { PaneError } from '../../../shared/paneError';

const DAEMON_RESOURCE_MONITOR_CHANNELS = [
  'resource-monitor:get-snapshot',
  MACHINE_HEALTH_SNAPSHOT_CHANNEL,
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

  commandRegistry.register(MACHINE_HEALTH_SNAPSHOT_CHANNEL, async () => {
    if (!services.machineHealth) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Machine health is not running in this Pane process.', 'Restart Pane, then try again.');
    }
    return services.machineHealth.getSnapshot();
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_RESOURCE_MONITOR_CHANNELS);
}
