import { registerChatTabHandlers } from './chatTabs';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { app, dialog, ipcMain, powerMonitor, type BrowserWindow, type MessageBoxOptions } from 'electron';
import type { AppServices } from './types';
import { registerAppHandlers } from './app';
import { registerNotesHandlers } from './notes';
import { registerUpdaterHandlers } from './updater';
import { registerUpdateOperationHandlers } from './updateOperation';
import { registerSessionHandlers } from './session';
import { registerProjectHandlers } from './project';
import { registerConfigHandlers } from './config';
import { registerCustomCommandHandlers } from './customCommands';
import { registerDialogHandlers } from './dialog';
import { registerGitHandlers } from './git';
import { registerScriptHandlers } from './script';
import { registerPromptHandlers } from './prompt';
import { registerMediaPreview } from '../services/mediaPreview';
import { registerFileHandlers } from './file';
import { registerFolderHandlers } from './folders';
import { registerUIStateHandlers } from './uiState';
import { registerDashboardHandlers } from './dashboard';
import { setupLogHandlers } from './logs';
import { registerPanelHandlers } from './panels';
import { registerTerminalPathHandlers } from './terminalPaths';
import { registerEditorPanelHandlers } from './editorPanel';
import { registerNimbalystHandlers } from './nimbalyst';
import { registerSpotlightHandlers } from './spotlight';
import { registerJourneyTimingHandlers } from './journeyTimings';
import { registerRemoteDaemonHandlers } from './remoteDaemon';
import { registerRunpaneHandlers } from './runpane';
import { registerNotifyHandlers } from './notify';
import { registerAutopilotHandlers } from './autopilot';
import { registerDesktopAlertHandlers } from './desktopAlerts';
import { registerClipboardHandlers } from './clipboard';
import { registerResourceMonitorHandlers } from './resourceMonitor';
import { registerOnboardingHandlers } from './onboarding';
import { registerVoiceHandlers } from './voice';
import { registerPaneChatHandlers } from './paneChat';
import { registerSshHostHandlers } from './sshHosts';
import { registerSshRouteHandlers } from './sshRoutes';
import { ensureSshRoute } from '../daemon/sshRoute';
import { registerUsageHandlers } from './usage';
import { registerSessionImportHandlers } from './sessionImport';
import { registerSessionMoveHandlers } from './sessionMove';
import { registerOrchestrationSessionHandlers } from './orchestrationSessions';
import { registerExportHandlers } from './export';
import { registerSetupHandlers } from './setup';
import { registerLoopHandlers } from './loops';
import { registerTodoHandlers } from './todos';
import { registerMissionControlHandlers } from './missionControl';
import { createDaemonBridgeRouter, registerDaemonBridgeHandlers } from './daemon';
import { registerPermissionHandlers } from './permissions';
import { registerAgentUsageHandlers } from './agentUsage';
import { registerFeedbackHandlers } from './feedback';
import { registerMobilePushHandlers } from './mobilePush';
import { registerSharedCredentialHandlers } from './sharedCredentials';
import { registerPaneSecretHandlers } from './paneSecrets';
import { registerCustomThemeHandlers } from './customTheme';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerPaneLinkHandler } from '../services/paneLinks';
import { RepositoryIdentities } from '../services/repositoryIdentity';
import { registerStartLinkConfirm } from './startLinkConfirm';
import { submitOnlyToAgent } from './runpane';
import { isOnPath } from '../utils/onPath';
import { configuredAgent, CONFIGURED_AGENT_IDS } from '../../../shared/agents';
import { normalizePaneChatAgent } from '../../../shared/types/paneChat';
import { getPaneEventSink } from '../core/runtime';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { registerWorkspaceAccessHandlers } from './workspaceAccess';
import { registerBrowserHandlers } from './browser';
import { electronBrowserHost } from '../services/browser/browserHost';
import { registerDeviceHandlers } from './devices';
import { readTailscaleStatus, resolveTailnetMachineUrl } from '../services/tailnetMachines';
import { startedOnFreshBoot } from '../services/freshBoot';


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
    rendererIds: () => {
      const window = services.getMainWindow();
      return window && !window.isDestroyed() ? [window.webContents.id] : [];
    },
    analyticsManager: services.analyticsManager,
    resolveTailnetMachineUrl: (machine) => resolveTailnetMachineUrl(machine, readTailscaleStatus),
    prepareSshRoute: ensureSshRoute,
    appVersion: services.app.getVersion(),
    freshBoot: startedOnFreshBoot,
  });
  ipcMain.handle('remote-daemon:restore-complete', (event, restoreId: PaneCommandValue, error: PaneCommandValue) => {
    const result = decodeBoundary({ restoreId, error }, boundary.object({ restoreId: boundary.number, error: boundary.optional(boundary.string) }));
    remotePaneClientController.acknowledgeRestore(event.sender.id, result.restoreId, result.error);
  });
  ipcMain.on('remote-daemon:restore-ready', event => remotePaneClientController.rendererReady(event.sender.id));
  // Pause the remote connection while the system sleeps and reconnect on wake.
  powerMonitor.on('suspend', () => remotePaneClientController.suspend());
  powerMonitor.on('resume', () => remotePaneClientController.resume());
  // While reconnecting, the window regaining focus or the network coming back retries at once.
  app.on('browser-window-focus', () => remotePaneClientController.retryIfReconnecting('window focused'));
  ipcMain.on('remote-daemon:network-online', () => remotePaneClientController.retryIfReconnecting('network online'));
  const bridgeRouter = createDaemonBridgeRouter(commandRegistry);

  registerAppHandlers(ipcMain, services);
  registerNotesHandlers(ipcMain, services, commandRegistry);
  registerFeedbackHandlers(ipcMain, services);
  registerUpdaterHandlers(ipcMain, services);
  registerUpdateOperationHandlers(services, commandRegistry);
  registerSessionHandlers(ipcMain, services, commandRegistry);
  registerProjectHandlers(ipcMain, services, commandRegistry);
  registerConfigHandlers(ipcMain, services, commandRegistry);
  registerCustomCommandHandlers(ipcMain, services.configManager, commandRegistry);
  registerMobilePushHandlers(ipcMain, services, commandRegistry);
  registerSharedCredentialHandlers(services, commandRegistry);
  registerPaneSecretHandlers(ipcMain, commandRegistry);
  registerDeviceHandlers(ipcMain, services, commandRegistry);
  registerBrowserHandlers(services, commandRegistry, electronBrowserHost(services.getMainWindow, commandRegistry, services.sessionManager));
  registerCustomThemeHandlers(ipcMain, commandRegistry, services.configManager, services.getMainWindow);
  registerDialogHandlers(ipcMain, services);
  registerExportHandlers(ipcMain, services);
  registerSetupHandlers(ipcMain, services);
  registerPermissionHandlers(ipcMain, services, commandRegistry);
  registerGitHandlers(ipcMain, services, commandRegistry);
  registerScriptHandlers(ipcMain, services, commandRegistry);
  registerPromptHandlers(ipcMain, services, commandRegistry);
  registerFileHandlers(ipcMain, services, commandRegistry);
  registerMediaPreview(commandRegistry);
  registerFolderHandlers(ipcMain, services, commandRegistry);
  registerUIStateHandlers(services);
  registerDashboardHandlers(ipcMain, services);
  setupLogHandlers(ipcMain, services.sessionManager, commandRegistry);
  registerPanelHandlers(ipcMain, services, commandRegistry);
  registerTerminalPathHandlers(ipcMain, services, commandRegistry);
  registerEditorPanelHandlers(ipcMain, services);
  registerNimbalystHandlers(ipcMain, services);
  registerSpotlightHandlers(ipcMain, services);
  registerJourneyTimingHandlers(ipcMain, services);
  registerRemoteDaemonHandlers(ipcMain, services);
  registerWorkspaceAccessHandlers(ipcMain, services, commandRegistry);
  registerRunpaneHandlers(ipcMain, services, commandRegistry);
  registerDesktopAlertHandlers(ipcMain, services);
  const notify = registerNotifyHandlers(ipcMain, services, commandRegistry);
  services.notifyService = notify;
  const raiseMainWindow = (): BrowserWindow | undefined => {
    const window = services.getMainWindow();
    if (!window || window.isDestroyed()) return undefined;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  };
  const showMessage = (options: MessageBoxOptions) => {
    const window = raiseMainWindow();
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  };
  const repositoryIdentities = new RepositoryIdentities();
  registerPaneLinkHandler(commandRegistry, {
    showWaitingCard: (paneId, panelId) => notify.showWaitingCard(paneId, panelId),
    repoExists: (repoId) => Boolean(services.databaseService.getProject(repoId)),
    listRepos: async () => {
      const projects = services.databaseService.getAllProjects();
      const identities = await repositoryIdentities.of(projects);
      return projects.map((project, index) => ({ id: project.id, name: project.name, identity: identities[index] ?? null }));
    },
    installedAgents: async () => {
      const installed = await Promise.all(CONFIGURED_AGENT_IDS.map(async (id) =>
        (await Promise.all(configuredAgent(id).executables.map((executable) => isOnPath(executable)))).some(Boolean)));
      return CONFIGURED_AGENT_IDS.filter((_id, index) => installed[index]);
    },
    defaultAgent: () => normalizePaneChatAgent(services.configManager.getConfig().defaultOrchestratorAgent),
    confirmStart: registerStartLinkConfirm(ipcMain, raiseMainWindow),
    submitToAgent: (panelId, submit) => submitOnlyToAgent(panelId, submit),
    showError: (message) => void showMessage({ type: 'warning', message: 'Pane could not open this link', detail: message }),
    navigate: (target) => {
      raiseMainWindow();
      getPaneEventSink().send('pane:open-link', target);
    },
    // A pairing link opened outside Pane: bring the window up on its confirm page.
    openPairLink: (link) => {
      raiseMainWindow();
      getPaneEventSink().send('relay:link-opened', { link });
    },
  });
  registerClipboardHandlers(ipcMain, services);
  registerResourceMonitorHandlers(ipcMain, services, commandRegistry);
  registerAgentUsageHandlers(ipcMain, services, commandRegistry);
  registerVoiceHandlers(ipcMain, services, commandRegistry);
  registerPaneChatHandlers(ipcMain, services, commandRegistry);
  registerChatTabHandlers(ipcMain, services, commandRegistry);
  registerSshHostHandlers(ipcMain, services, commandRegistry);
  registerSshRouteHandlers(ipcMain, services, commandRegistry);
  registerOrchestrationSessionHandlers(ipcMain, services, commandRegistry);
  registerAutopilotHandlers(services, commandRegistry, notify);
  registerUsageHandlers(ipcMain, commandRegistry);
  registerSessionImportHandlers(ipcMain, services, commandRegistry);
  registerSessionMoveHandlers(ipcMain, services, commandRegistry);
  if (services.loopManager) registerLoopHandlers(ipcMain, services.loopManager, commandRegistry);
  registerTodoHandlers(ipcMain, services, commandRegistry);
  registerMissionControlHandlers(ipcMain, services, commandRegistry);
  registerOnboardingHandlers(ipcMain, services);
  registerDaemonBridgeHandlers(ipcMain, bridgeRouter);

  return commandRegistry;
}
