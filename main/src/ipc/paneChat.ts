import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { normalizePaneChatAgent } from '../../../shared/types/paneChat';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { paneChatIntroOfferEligible } from '../services/paneChatIntroOffer';
import { terminalPanelManager } from '../services/terminalPanelManager';

export function registerPaneChatHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('pane-chat:get-or-create', async () => {
    try {
      if (!services.paneChatManager) {
        throw new Error('Pane Chat manager is not initialized');
      }

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
      if (!services.paneChatManager) {
        throw new Error('Pane Chat manager is not initialized');
      }

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

  commandRegistry.register('pane-chat:intro-offer', async () => {
    try {
      if (!services.orchestrationSessionManager) {
        throw new Error('Sessions manager is not initialized');
      }
      const { sessions } = await services.orchestrationSessionManager.list();
      const agent = normalizePaneChatAgent(services.configManager.getConfig().defaultOrchestratorAgent);
      // A shell that can't take the opening prompt on the launch command line gets it as text to paste.
      const openingPromptAtLaunch = terminalPanelManager.launchShellIsPosix();
      return { success: true, data: { eligible: paneChatIntroOfferEligible(sessions, agent), openingPromptAtLaunch } };
    } catch (error) {
      console.error('[PaneChat IPC] Failed to check the Pane Chat offer:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check the Pane Chat offer',
      };
    }
  });
  commandRegistry.bindChannel(ipcMain, 'pane-chat:intro-offer');
}
