import { installRunpaneShimBestEffort } from '../services/runpaneShim';
import path from 'path';
import { powerMonitor, type App, type BrowserWindow } from 'electron';
import { startupPanelBufferMigration, startupRetentionResult } from '../services/database';
import { ConfigManager } from '../services/configManager';
import { Logger } from '../utils/logger';
import { DatabaseService } from '../database/database';
import { AnalyticsManager } from '../services/analyticsManager';
import { SessionManager } from '../services/sessionManager';
import { ArchiveProgressManager } from '../services/archiveProgressManager';
import { SpotlightManager } from '../services/spotlightManager';
import { PermissionIpcServer } from '../services/permissionIpcServer';
import { WorktreeManager } from '../services/worktreeManager';
import { CliManagerFactory } from '../services/cliManagerFactory';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';
import { GitDiffManager } from '../services/gitDiffManager';
import { GitStatusManager } from '../services/gitStatusManager';
import { ExecutionTracker } from '../services/executionTracker';
import { WorktreeNameGenerator } from '../services/worktreeNameGenerator';
import { RunCommandManager } from '../services/runCommandManager';
import { VersionChecker } from '../services/versionChecker';
import { SkillCacheManager } from '../services/skillCacheManager';
import { applyManagedAgentsMdSetting } from '../services/agentContextManager';
import { PaneChatManager } from '../services/paneChatManager';
import { OrchestrationSessionManager } from '../services/orchestrationSessionManager';
import { TaskQueue } from '../services/taskQueue';
import { registerIpcHandlers } from '../ipc';
import { isLockOwnerLive } from '../ipc/runpane';
import { PaneDaemonServer } from './server';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { PaneRemoteTransportController } from './remoteTransportController';
import { createFanoutEventSink, noopPaneEventSink, type PaneEventSink } from '../core/eventSink';
import {
  getPaneEventSink,
  setPaneRuntime,
  type PaneWebviewContext,
  type PtyHostRuntime,
} from '../core/runtime';
import type { AppServices, DaemonHostServices } from '../ipc/types';
import { setupEventListeners } from '../events';
import { getAppDirectory } from '../utils/appDirectory';
import { resourceMonitorService } from '../services/resourceMonitorService';
import type { PaneCommandRegistry } from './commandRegistry';
import { syncRemoteTransportForMode } from './remoteTransportStartup';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { createPanelResume, createScrollbackCheckpoint } from '../services/panelResumeService';
import { WorkspaceJournal } from '../services/workspaceJournal';
import { SessionPrMonitor } from '../services/sessionPrMonitor';
import { NamedLockService } from '../services/namedLockService';
import { NamedLockStore } from '../services/namedLockStore';
import { WorkspaceStateReader } from '../services/workspaceStateReader';
import { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import { extractWorkspaceHeldInput } from '../services/workspaceHeldInput';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { cloudDaemonHealth } from './cloud/readiness';
import { userClientActivity } from './cloud/clientActivity';
import { readBuildCommit, registerCloudDaemonHandlers } from './cloud/cloudDaemon';
import { registerSessionPortsHandlers } from './cloud/ports/registerPorts';
import { whenCloudSession } from './cloud/cloudSessionMarker';
import { registerAgentNotesHandler, writeSessionAgentNotes } from './cloud/sessionAgentNotes';
import { applySessionAgentDefaults, registerAgentDefaultsHandler } from './cloud/sessionAgentDefaults';
import { remoteHostRuntimeStateStore } from './remoteHostRuntimeState';

interface PaneDaemonHostOptions {
  app: App;
  getMainWindow: () => BrowserWindow | null;
  getPtyHostRuntime: () => PtyHostRuntime | null;
  getWebviewContextMap?: () => Map<number, PaneWebviewContext>;
  rendererEventSink?: PaneEventSink;
  mode?: 'desktop' | 'headless';
  restoreSpotlights?: boolean;
  startRemoteTransport?: boolean;
}

export interface PaneDaemonHost {
  services: AppServices;
  daemonServices: DaemonHostServices;
  commandRegistry: PaneCommandRegistry;
  paneDaemonServer: PaneDaemonServer | null;
  remoteHttpApiServer: PaneRemoteHttpApiServer | null;
  permissionIpcServer: PermissionIpcServer | null;
  shutdown(): Promise<void>;
}

let powerMonitorDiagnosticsRegistered = false;

/** How often the headless daemon saves live terminal scrollback (boat stops are power-offs). */
const SCROLLBACK_CHECKPOINT_INTERVAL_MS = 10_000;

function installPaneRuntime(
  eventSink: PaneEventSink,
  configManager: ConfigManager,
  getPtyHostRuntime: () => PtyHostRuntime | null,
  getWebviewContextMap: () => Map<number, PaneWebviewContext>,
  daemonEventSink?: PaneEventSink,
): void {
  setPaneRuntime({
    eventSink,
    daemonEventSink,
    getConfigManager: () => configManager,
    getPtyHostRuntime,
    getWebviewContextMap,
  });
}

function registerPowerMonitorDiagnostics(logger: Logger): void {
  if (powerMonitorDiagnosticsRegistered) {
    return;
  }

  powerMonitorDiagnosticsRegistered = true;
  powerMonitor.on('suspend', () => logger.info('[Lifecycle] power:suspend'));
  powerMonitor.on('resume', () => logger.info('[Lifecycle] power:resume'));
  powerMonitor.on('lock-screen', () => logger.info('[Lifecycle] power:lock-screen'));
  powerMonitor.on('unlock-screen', () => logger.info('[Lifecycle] power:unlock-screen'));
}

function megabytes(bytes: number | null): string {
  return bytes === null ? 'unknown' : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export async function createPaneDaemonHost(options: PaneDaemonHostOptions): Promise<PaneDaemonHost> {
  const mode = options.mode ?? 'desktop';
  const startRemoteTransport = options.startRemoteTransport ?? true;
  const rendererEventSink = options.rendererEventSink ?? noopPaneEventSink;
  const headlessWebviewContextMap = new Map<number, PaneWebviewContext>();
  const getWebviewContextMap = options.getWebviewContextMap ?? (() => headlessWebviewContextMap);

  const configManager = new ConfigManager();
  await configManager.initialize();
  installPaneRuntime(rendererEventSink, configManager, options.getPtyHostRuntime, getWebviewContextMap);
  if (mode === 'desktop') {
    // `runpane cloud new|sync|destroy` save remote hosts into config.json while the app runs; the
    // renderer refetches so the host switcher shows them without a restart.
    configManager.on('config-updated', () => rendererEventSink.send('config:changed'));
    configManager.startWatching();
  }

  const logger = new Logger(configManager);
  console.log('[Main] Logger initialized with file logging to ~/.pane/logs');
  registerPowerMonitorDiagnostics(logger);

  if (startupPanelBufferMigration.error) {
    logger.error('[PanelBuffers] Startup migration failed', startupPanelBufferMigration.error);
  } else if (startupPanelBufferMigration.result?.migrated) {
    const migration = startupPanelBufferMigration.result;
    logger.info(
      `[PanelBuffers] Moved terminal bytes out of ${migration.panelsRepaired} panel states ` +
      `(${migration.panelsWithBuffers} with buffers) in ${migration.durationMs} ms; ` +
      `sessions.db ${megabytes(migration.fileBytesBefore)} -> ${megabytes(migration.fileBytesAfter)}; ` +
      `backup ${migration.backupPath ?? 'none'}`,
    );
  }

  if (startupRetentionResult.error) {
    logger.error('[ScrollbackRetention] Sweep failed', startupRetentionResult.error);
  } else if (startupRetentionResult.result && startupRetentionResult.result.panelsCleared > 0) {
    const result = startupRetentionResult.result;
    logger.info(
      `[ScrollbackRetention] Cleared ${result.panelsCleared} panels across ` +
      `${result.sessionsTouched} sessions, freed ~${megabytes(result.bytesFreed)}`,
    );
  }

  const dbPath = configManager.getDatabasePath();
  const databaseService = new DatabaseService(dbPath);
  databaseService.initialize();

  const analyticsManager = new AnalyticsManager(configManager);
  const sessionManager = new SessionManager(databaseService, analyticsManager);
  sessionManager.initializeFromDatabase();

  // Headless starts follow a crash, a restart or a sandbox power-off: no PTY
  // survived, so clear stale runtime flags before anything can start one.
  const logResume = (message: string, error?: Error) => {
    if (error) logger.warn(message, error);
    else logger.info(message);
  };
  const panelResume = mode === 'headless' ? createPanelResume(databaseService, sessionManager, logResume) : undefined;
  const scrollbackCheckpoint = mode === 'headless'
    ? createScrollbackCheckpoint(SCROLLBACK_CHECKPOINT_INTERVAL_MS, logResume)
    : undefined;
  if (panelResume) {
    panelResume.enable();
    const interrupted = await panelResume.recoverAfterRestart();
    logger.info(`[PanelResume] ${interrupted.length} agent panel(s) were interrupted by the last stop`);
  }

  if (process.platform === 'win32') {
    const wslDistros = databaseService.getAllProjects()
      .filter((project) => project.wsl_enabled && project.wsl_distribution)
      .map((project) => project.wsl_distribution!);
    if (wslDistros.length > 0) {
      void import('../utils/wslUtils').then(({ bumpWSLInotifyLimits }) =>
        bumpWSLInotifyLimits(wslDistros).catch(() => {}),
      );
    }
  }

  const archiveProgressManager = new ArchiveProgressManager();
  const spotlightManager = new SpotlightManager(sessionManager, logger, options.getMainWindow);

  console.log('[Main] Initializing Permission IPC server...');
  let permissionIpcServer: PermissionIpcServer | null = new PermissionIpcServer();
  console.log('[Main] Starting Permission IPC server...');
  let permissionIpcPath: string | null = null;

  try {
    await permissionIpcServer.start();
    permissionIpcPath = permissionIpcServer.getSocketPath();
    console.log('[Main] Permission IPC server started successfully');
    console.log('[Main] Permission IPC socket path:', permissionIpcPath);
  } catch (error) {
    console.error('[Main] Failed to start Permission IPC server:', error);
    console.error('[Main] Permission-based MCP will be disabled');
    permissionIpcServer = null;
  }

  const worktreeManager = new WorktreeManager(configManager, analyticsManager);
  const activeProject = sessionManager.getActiveProject();
  if (activeProject) {
    const context = sessionManager.getProjectContextByProjectId(activeProject.id);
    if (context) {
      await worktreeManager.initializeProject(activeProject.path, undefined, context.pathResolver, context.commandRunner);
    }
  }

  const cliManagerFactory = CliManagerFactory.getInstance(logger, configManager);
  const defaultCliManager: AbstractCliManager = await cliManagerFactory.createManager('claude', {
    sessionManager,
    logger,
    configManager,
    additionalOptions: { permissionIpcPath },
    skipValidation: true,
  });
  const gitDiffManager = new GitDiffManager(logger, analyticsManager);
  const gitStatusManager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager, logger, databaseService);
  const executionTracker = new ExecutionTracker(sessionManager, gitDiffManager);
  const worktreeNameGenerator = new WorktreeNameGenerator(configManager);
  const runCommandManager = new RunCommandManager(databaseService);
  const versionChecker = new VersionChecker(configManager, logger);
  // Terminals launched below find this build's runpane first on PATH.
  installRunpaneShimBestEffort(getAppDirectory());
  const skillCacheManager = new SkillCacheManager();
  await skillCacheManager.start().catch(error => {
    logger.warn('[SkillCache] Failed to install Pane Chat skills', error instanceof Error ? error : undefined);
  });
  await skillCacheManager.syncHomeSkill(configManager.getConfig(), databaseService.getAllProjects());
  if (configManager.getConfig().agentContext?.cleanupPending && configManager.getConfig().agentContext?.managedAgentsMd !== true) {
    // Retry until all saved repositories are available, without delaying startup.
    const migrationConfig = configManager.getConfig();
    void applyManagedAgentsMdSetting(migrationConfig, {
      all: () => databaseService.getAllProjects(),
      active: () => sessionManager.getActiveProject(),
    }).then(async succeeded => {
      if (succeeded && configManager.getConfig() === migrationConfig) {
        await configManager.updateConfig({ agentContext: { cleanupPending: false } });
      }
    }).catch(error => console.warn('[AgentContext] Could not finish startup cleanup:', error));
  }
  const paneChatManager = new PaneChatManager(configManager, sessionManager, skillCacheManager);
  await paneChatManager.getOrCreate().catch(error => {
    logger.warn('[PaneChat] Failed to ensure startup Pane Chat session', error instanceof Error ? error : undefined);
  });
  const orchestrationSessionManager = new OrchestrationSessionManager(
    configManager,
    sessionManager,
    skillCacheManager,
    paneChatManager,
    gitStatusManager,
  );
  // A named Session's orchestrator lives in a hidden Pane; bring it back on start like other agents.
  panelResume?.alsoResumePanes(() => orchestrationSessionManager.activeOrchestratorPaneIds());
  await orchestrationSessionManager.initialize().catch(error => {
    // Keep the rest of Pane available when a previously-written Session store
    // cannot be read. Session APIs retry and return the exact failure instead
    // of silently replacing the user's metadata.
    logger.error('[Sessions] Failed to initialize durable Session metadata', error instanceof Error ? error : new Error(String(error)));
  });
  const taskQueue = new TaskQueue({
    sessionManager,
    worktreeManager,
    claudeCodeManager: defaultCliManager,
    gitDiffManager,
    executionTracker,
    worktreeNameGenerator,
  });

  const workspaceJournal = new WorkspaceJournal({
    resolvePane: (paneId) => {
      const session = sessionManager.getSession(paneId);
      if (!session) return undefined;
      const project = sessionManager.getProjectForSession(paneId);
      return {
        paneId,
        paneName: session.name,
        repoId: project?.id,
        repoName: project?.name,
        worktreePath: session.worktreePath,
      };
    },
    resolvePanel: (panelId) => {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return undefined;
      const snapshot = terminalPanelManager.getTerminalSnapshot(panelId);
      const customState = decodeBoundary(panel.state.customState ?? {}, boundary.object({
        agentType: boundary.optional(boundary.string),
        isCliPanel: boundary.optional(boundary.boolean),
      }));
      return {
        panelId,
        paneId: panel.sessionId,
        isCliPanel: snapshot?.isCliPanel ?? customState.isCliPanel ?? false,
        agentType: snapshot?.agentType ?? customState.agentType,
        panelTitle: panel.title,
        lastActivityAt: snapshot?.lastActivityTime,
        heldInput: snapshot?.screenText ? extractWorkspaceHeldInput(snapshot.screenText) : undefined,
      };
    },
    resolveSessionMembership: sessionId => orchestrationSessionManager.workspaceMembership(sessionId),
  });
  for (const session of sessionManager.getAllSessions()) {
    const project = sessionManager.getProjectForSession(session.id);
    workspaceJournal.rememberPane({
      paneId: session.id,
      paneName: session.name,
      repoId: project?.id,
      repoName: project?.name,
      worktreePath: session.worktreePath,
    });
  }
  // Polls GitHub only for Panes in a live Session with an open PR; idle rounds run no gh.
  const sessionPrMonitor = new SessionPrMonitor({
    sessions: orchestrationSessionManager,
    panes: sessionManager,
    gitStatus: gitStatusManager,
    journal: workspaceJournal,
    logger,
  });
  const workspaceStateReader = new WorkspaceStateReader(
    sessionManager,
    () => workspaceJournal.epoch,
    () => workspaceJournal.generation,
  );
  const workspaceCursorStore = new WorkspaceCursorStore(
    path.join(getAppDirectory(), 'workspace-cursors.json'),
  );
  const namedLockService = new NamedLockService(new NamedLockStore(path.join(getAppDirectory(), 'locks.json')), {
    isOwnerLive: owner => isLockOwnerLive({ sessionManager }, owner),
    log: (message, error) => logger.warn(message, error),
  });

  const daemonServices: DaemonHostServices = {
    configManager,
    databaseService,
    sessionManager,
    worktreeManager,
    cliManagerFactory,
    claudeCodeManager: defaultCliManager,
    gitDiffManager,
    gitStatusManager,
    executionTracker,
    worktreeNameGenerator,
    runCommandManager,
    versionChecker,
    skillCacheManager,
    paneChatManager,
    orchestrationSessionManager,
    taskQueue,
    getMainWindow: options.getMainWindow,
    logger,
    archiveProgressManager,
    analyticsManager,
    spotlightManager,
    workspaceJournal,
    workspaceStateReader,
    workspaceCursorStore,
    namedLockService,
    panelResume,
    scrollbackCheckpoint,
  };

  const services: AppServices = {
    app: options.app,
    ...daemonServices,
  };

  const commandRegistry = registerIpcHandlers(services);
  cloudDaemonHealth.setVersion(options.app.getVersion(), readBuildCommit(options.app.getAppPath()));
  registerCloudDaemonHandlers({
    commandRegistry,
    health: cloudDaemonHealth,
    clientActivity: userClientActivity,
    terminals: terminalPanelManager,
    getPanel: panelId => panelManager.getPanel(panelId),
    getPanelsForPane: paneId => panelManager.getPanelsForSession(paneId),
    listPaneIds: () => sessionManager.getAllSessions().map(session => session.id),
    listLocks: () => namedLockService.list(),
    pendingPrChecks: maxAgeMs => sessionPrMonitor.pendingChecks(maxAgeMs),
    connectedClients: () => remoteHostRuntimeStateStore.getState().connectedClients,
    remoteConfig: () => configManager.getConfig().remoteDaemon,
    writeRemoteConfig: async (remoteDaemon) => {
      await configManager.updateConfig({ remoteDaemon });
    },
    checkpointWal: () => databaseService.checkpointWal(),
    paneDirectory: getAppDirectory(),
    databaseFile: dbPath,
  });
  const sessionPorts = registerSessionPortsHandlers({
    commandRegistry,
    panelIds: () => terminalPanelManager.getAllPanelIds(),
    panelPid: panelId => terminalPanelManager.getPanelPid(panelId),
    paneIdOf: panelId => panelManager.getPanel(panelId)?.sessionId,
    projectPaths: () => databaseService.getAllProjects().map(project => project.path),
    daemonPort: () => configManager.getConfig().remoteDaemon?.host.config.listenPort,
    emit: (channel, result) => getPaneEventSink().send(channel, result),
    log: message => logger.info(`[Pane daemon] ${message}`),
  });
  registerAgentNotesHandler(commandRegistry);
  registerAgentDefaultsHandler(commandRegistry);
  const stopWaitingForAgentNotes = whenCloudSession(() => {
    try {
      const notes = writeSessionAgentNotes();
      if (notes.length > 0) logger.info(`[Pane daemon] wrote the Session notes for agents: ${notes.join(', ')}`);
    } catch (error) {
      logger.warn(`[Pane daemon] could not write the Session notes for agents: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const defaults = applySessionAgentDefaults();
      if (defaults.changedFiles.length > 0 || defaults.claudeModel.outcome === 'kept-session-choice' || defaults.claudeModel.outcome === 'settings-unreadable') {
        logger.info(`[Pane daemon] agent defaults: Claude model ${defaults.claudeModel.outcome} (${defaults.claudeModel.inSettings ?? 'Claude Code default'})`);
      }
    } catch (error) {
      logger.warn(`[Pane daemon] could not apply the agent defaults: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  let paneDaemonServer: PaneDaemonServer | null = null;
  const remoteTransportController = new PaneRemoteTransportController(commandRegistry, configManager, analyticsManager);
  try {
    paneDaemonServer = new PaneDaemonServer(commandRegistry, getAppDirectory());
    const endpoint = paneDaemonServer.getEndpoint();
    logger.info(`[Pane daemon] Starting local daemon server on ${endpoint.transport}:${endpoint.path}`);
    await paneDaemonServer.start();
    logger.info(`[Pane daemon] Local daemon server listening on ${endpoint.transport}:${endpoint.path}`);
  } catch (error) {
    logger.error(
      '[Pane daemon] Failed to start local daemon server; continuing with renderer-only runtime events',
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  if (startRemoteTransport) {
    remoteTransportController.startWatchingConfig();
    await syncRemoteTransportForMode(remoteTransportController, mode, async () => {
      await remoteTransportController.stopWatchingAndShutdown();
      await paneDaemonServer?.stop();
    });
  }

  const daemonSinks: PaneEventSink[] = [workspaceJournal, namedLockService];
  if (paneDaemonServer) {
    daemonSinks.push(paneDaemonServer.getEventSink());
  }
  if (startRemoteTransport) {
    daemonSinks.push(remoteTransportController.getEventSink());
  }

  installPaneRuntime(
    createFanoutEventSink([rendererEventSink, ...daemonSinks]),
    configManager,
    options.getPtyHostRuntime,
    getWebviewContextMap,
    createFanoutEventSink(daemonSinks),
  );

  setupEventListeners(services);

  const { logsManager } = await import('../services/panels/logPanel/logsManager');
  logsManager.setAnalyticsManager(analyticsManager);

  gitStatusManager.startPolling();
  sessionPrMonitor.start();
  if (mode === 'desktop') {
    versionChecker.startPeriodicCheck();
  }
  resourceMonitorService.initialize({
    app: options.app,
    getSessionById: (sessionId) => sessionManager.getSession(sessionId),
    getSessionWslDistro: (sessionId) => {
      const projectId = sessionManager.getSession(sessionId)?.projectId;
      if (!projectId) return null;
      const project = databaseService.getProject(projectId);
      return project?.wsl_enabled && project.wsl_distribution ? project.wsl_distribution : null;
    },
  });

  scrollbackCheckpoint?.start();
  if (panelResume) {
    // Not awaited: the socket is up already, and a submit to a panel that is
    // still coming back waits for that panel on its own. /health readiness
    // stays "starting" until the resume pass ends, so a cloud wake waits for it.
    cloudDaemonHealth.setAgentRestorePhase('pending');
    void panelResume.resumeInterruptedAgents().then(status => {
      const failed = status.panels.filter(panel => panel.state === 'failed').length;
      logger.info(`[PanelResume] Resumed ${status.panels.length - failed} of ${status.panels.length} agent panel(s)`);
    }).finally(() => cloudDaemonHealth.setAgentRestorePhase('done'));
  }

  if (options.restoreSpotlights !== false) {
    try {
      await spotlightManager.restoreAll();
    } catch (error) {
      console.error('[Main] Failed to restore spotlight state:', error);
    }
  }

  cloudDaemonHealth.markDaemonReady();

  return {
    services,
    daemonServices,
    commandRegistry,
    paneDaemonServer,
    get remoteHttpApiServer() {
      return remoteTransportController.getServer();
    },
    permissionIpcServer,
    async shutdown(): Promise<void> {
      // First: Ports' timers and the agent-notes wait read terminals, projects and config, and emit events.
      sessionPorts?.stop();
      stopWaitingForAgentNotes();
      // Keep the latest scrollback; start-up recovery marks the agents interrupted.
      if (scrollbackCheckpoint) {
        scrollbackCheckpoint.stop();
        await scrollbackCheckpoint.checkpoint().catch(error => {
          logResume('[ScrollbackCheckpoint] Final save failed', error instanceof Error ? error : new Error(String(error)));
        });
      }
      // Before terminals stop: their exits during shutdown must not release locks.
      namedLockService.dispose();
      resourceMonitorService.stop();
      await spotlightManager.disableAll();
      await sessionManager.cleanup();
      await runCommandManager.stopAllRunCommands();
      gitStatusManager.stopPolling();
      sessionPrMonitor.stop();
      configManager.stopWatching();
      await cliManagerFactory.shutdown();
      await taskQueue.close();
      workspaceJournal.dispose();
      await permissionIpcServer?.stop();
      await remoteTransportController.stopWatchingAndShutdown();
      if (paneDaemonServer) {
        await paneDaemonServer.stop();
      }
      versionChecker.stopPeriodicCheck();
      logger.close();
    },
  };
}
