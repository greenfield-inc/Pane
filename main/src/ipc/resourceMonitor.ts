import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { resourceMonitorService } from '../services/resourceMonitorService';

const DAEMON_RESOURCE_MONITOR_CHANNELS = [
  'resource-monitor:get-snapshot',
] as const;

export function registerResourceMonitorHandlers(
  ipcMain: IpcMain,
  _services: AppServices,
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

  commandRegistry.bindChannels(ipcMain, DAEMON_RESOURCE_MONITOR_CHANNELS);
}
