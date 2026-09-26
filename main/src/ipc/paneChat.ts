import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { normalizePaneChatAgent } from '../../../shared/types/paneChat';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

export function registerPaneChatHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('pane-chat:get-or-create', async () => {
    try {
      const state = await services.paneChatManager.getOrCreate();
      return { success: true, data: state };
    } catch (error) {
      console.error('[PaneChat IPC] Failed to get or create Pane Chat:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get or create Pane Chat',
      };
    }
  });
  commandRegistry.bindChannel(ipcMain, 'pane-chat:get-or-create');

  commandRegistry.register('pane-chat:set-agent', async (agent: PaneCommandValue) => {
    try {
      const decodedAgent = decodeBoundary(agent, boundary.optional(boundary.json));
      const state = await services.paneChatManager.setAgent(normalizePaneChatAgent(decodedAgent));
      return { success: true, data: state };
    } catch (error) {
      console.error('[PaneChat IPC] Failed to set Pane Chat agent:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set Pane Chat agent',
      };
    }
  });
  commandRegistry.bindChannel(ipcMain, 'pane-chat:set-agent');
}
