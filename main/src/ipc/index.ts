import { ipcMain } from 'electron';
import type { AppServices } from './types';
import { registerAppHandlers } from './app';
import { registerUpdaterHandlers } from './updater';
import { registerSessionHandlers } from './session';
import { registerProjectHandlers } from './project';
import { registerConfigHandlers } from './config';
import { registerDialogHandlers } from './dialog';
import { registerGitHandlers } from './git';
import { registerScriptHandlers } from './script';
import { registerPromptHandlers } from './prompt';
import { registerFileHandlers } from './file';
import { registerFolderHandlers } from './folders';
import { registerUIStateHandlers } from './uiState';
import { registerDashboardHandlers } from './dashboard';
import { setupLogHandlers } from './logs';
import { registerPanelHandlers } from './panels';
import { registerEditorPanelHandlers } from './editorPanel';
import { registerNimbalystHandlers } from './nimbalyst';
import { registerSpotlightHandlers } from './spotlight';
import { registerRemoteDaemonHandlers } from './remoteDaemon';
import { registerRunpaneHandlers } from './runpane';
import { registerClipboardHandlers } from './clipboard';
import { registerResourceMonitorHandlers } from './resourceMonitor';
import { registerOnboardingHandlers } from './onboarding';
import { registerVoiceHandlers } from './voice';
import { registerPaneChatHandlers } from './paneChat';
import { registerUsageHandlers } from './usage';
import { registerOrchestrationSessionHandlers } from './orchestrationSessions';
import { registerExportHandlers } from './export';
import { createDaemonBridgeRouter, registerDaemonBridgeHandlers } from './daemon';
import { registerPermissionHandlers } from './permissions';
import { registerAgentUsageHandlers } from './agentUsage';
import { registerFeedbackHandlers } from './feedback';
import { registerMobilePushHandlers } from './mobilePush';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';


export function registerIpcHandlers(services: AppServices): PaneCommandRegistry {
  const commandRegistry = new PaneCommandRegistry();
  const rendererEventSink = {
    send(channel: string, ...args: unknown[]) {
      const window = services.getMainWindow();
      if (!window || window.isDestroyed()) {
        return;
      }

      window.webContents.send(channel, ...args);
    },
  };
  remotePaneClientController.initialize({
    configManager: services.configManager,
    rendererEventSink,
    analyticsManager: services.analyticsManager,
  });
  const bridgeRouter = createDaemonBridgeRouter(commandRegistry);

  registerAppHandlers(ipcMain, services);
  registerFeedbackHandlers(ipcMain, services);
  registerUpdaterHandlers(ipcMain, services);
  registerSessionHandlers(ipcMain, services, commandRegistry);
  registerProjectHandlers(ipcMain, services, commandRegistry);
  registerConfigHandlers(ipcMain, services, commandRegistry);
  registerMobilePushHandlers(ipcMain, services, commandRegistry);
  registerDialogHandlers(ipcMain, services);
  registerExportHandlers(ipcMain, services);
  registerPermissionHandlers(ipcMain, services, commandRegistry);
  registerGitHandlers(ipcMain, services, commandRegistry);
  registerScriptHandlers(ipcMain, services, commandRegistry);
  registerPromptHandlers(ipcMain, services, commandRegistry);
  registerFileHandlers(ipcMain, services, commandRegistry);
  registerFolderHandlers(ipcMain, services, commandRegistry);
  registerUIStateHandlers(services);
  registerDashboardHandlers(ipcMain, services);
  setupLogHandlers(ipcMain, services.sessionManager, commandRegistry);
  registerPanelHandlers(ipcMain, services, commandRegistry);
  registerEditorPanelHandlers(ipcMain, services);
  registerNimbalystHandlers(ipcMain, services);
  registerSpotlightHandlers(ipcMain, services);
  registerRemoteDaemonHandlers(ipcMain, services);
  registerRunpaneHandlers(ipcMain, services, commandRegistry);
  registerClipboardHandlers(ipcMain, services);
  registerResourceMonitorHandlers(ipcMain, services, commandRegistry);
  registerAgentUsageHandlers(ipcMain, services, commandRegistry);
  registerVoiceHandlers(ipcMain, services, commandRegistry);
  registerPaneChatHandlers(ipcMain, services, commandRegistry);
  registerOrchestrationSessionHandlers(ipcMain, services, commandRegistry);
  registerUsageHandlers(ipcMain, commandRegistry);
  registerOnboardingHandlers(ipcMain, services);
  registerDaemonBridgeHandlers(ipcMain, bridgeRouter);

  return commandRegistry;
}
