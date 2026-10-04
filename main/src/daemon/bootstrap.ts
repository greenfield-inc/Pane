import { installRunpaneShimBestEffort } from '../services/runpaneShim';
import os from 'os';
import path from 'path';
import { powerMonitor, type App, type BrowserWindow } from 'electron';
import { startupPanelBufferMigration, startupRetentionResult } from '../services/database';
import { ConfigManager } from '../services/configManager';
import { Logger } from '../utils/logger';
import { DatabaseService } from '../database/database';
import { AnalyticsManager } from '../services/analyticsManager';
import { SessionManager } from '../services/sessionManager';
import { ArchiveProgressManager } from '../services/archiveProgressManager';
import { ArchiveCleanupManager } from '../services/archiveCleanupManager';
import { SpotlightManager } from '../services/spotlightManager';
import { PermissionIpcServer } from '../services/permissionIpcServer';
import { WorktreeManager } from '../services/worktreeManager';
import { CliManagerFactory } from '../services/cliManagerFactory';
import { CliToolRegistry } from '../services/cliToolRegistry';
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
import { PaneWorkspaceHostController } from './workspaceHost';
import { runRemoteSetupCommand } from './remote-setup-command';
import { RemoteHostTailnetMonitor } from './remoteHostTailnet';
import { registerWorkspaceCommands } from '../ipc/workspace';
import { getMobilePushSender } from './mobilePushSender';
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
import { pausedMarkOf, type TerminalPanelState } from '../../../shared/types/panels';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { createListeningPortMonitor } from '../services/listeningPorts';
import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';
import { PhonePreviewHost } from './phonePreviews';
import { createPreviewFiles } from './previewProxy';
import { createPanelResume, createScrollbackCheckpoint } from '../services/panelResumeService';
import { WorkspaceJournal } from '../services/workspaceJournal';
import { SessionPrMonitor } from '../services/sessionPrMonitor';
import { LoopManager } from '../services/loops/loopManager';
import { AutoPauser } from '../services/autoPause';
import { pausePanes } from '../services/panePause';
import { updateHoldIsLive } from '../services/updateRestoration';
import { LoopRepository } from '../services/loops/loopRepository';
import { archiveLoopRun, prepareLoopSession, startLoopRun } from '../ipc/loops';
import { NamedLockService } from '../services/namedLockService';
import { NamedLockStore } from '../services/namedLockStore';
import { WorkspaceStateReader } from '../services/workspaceStateReader';
import { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

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

/** How often the headless daemon saves live terminal scrollback and flushes the database. */
const SCROLLBACK_CHECKPOINT_INTERVAL_MS = 10_000;

/**
 * Set to 1 where the machine can stop without a shutdown (a cloud sandbox's
 * service sets it): the headless daemon then relaunches the agents that were
 * running as soon as it starts. Elsewhere they resume when they are opened.
 */
function resumeAgentsOnStart(): boolean {
  return process.env.PANE_RESUME_AGENTS_ON_START === '1';
}

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

  // Headless starts follow a crash, a restart or a power-off. Clear stale
  // runtime flags before anything can start a PTY.
  const logResume = (message: string, error?: Error) => {
    if (error) logger.warn(message, error);
    else logger.info(message);
  };
  const panelResume = mode === 'headless' ? createPanelResume(databaseService, sessionManager, logResume) : undefined;
  const scrollbackCheckpoint = mode === 'headless'
    ? createScrollbackCheckpoint(databaseService, SCROLLBACK_CHECKPOINT_INTERVAL_MS, logResume)
    : undefined;
  if (panelResume) {
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
      await worktreeManager.initializeProject(activeProject.path, activeProject.worktree_folder || undefined, context.pathResolver, context.commandRunner);
    }
  }
  // Repositories whose worktree folder predates this hide it from their own git status.
  for (const project of databaseService.getAllProjects()) {
    const context = sessionManager.getProjectContextByProjectId(project.id);
    if (context) void worktreeManager.excludeWorktreeFolder(project.path, project.worktree_folder || undefined, context.pathResolver, context.commandRunner);
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
  panelResume?.alsoResumePanes(() => orchestrationSessionManager.ownerPaneIds());
  await orchestrationSessionManager.initialize().catch(error => {
    // Keep the rest of Pane available when a previously-written Session store
    // cannot be read. Session APIs retry and return the exact failure instead
    // of silently replacing the user's metadata.
    logger.error('[Sessions] Failed to initialize durable Session metadata', error instanceof Error ? error : new Error(String(error)));
  });
  getMobilePushSender(configManager, { resolveSubject: paneId => orchestrationSessionManager.alertSubject(paneId) });
  const taskQueue = new TaskQueue({
    sessionManager,
    worktreeManager,
    claudeCodeManager: defaultCliManager,
    gitDiffManager,
    executionTracker,
    worktreeNameGenerator,
  });

  const workspaceJournal = new WorkspaceJournal({
    filePath: path.join(getAppDirectory(), 'workspace-journal.json'),
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
        paused: !!pausedMarkOf(panel),
        // Typed cells only, so a dim or grey prompt suggestion is not held input.
        screen: { screenText: snapshot?.screenText, typedText: terminalPanelManager.getInputScreenText(panelId) },
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
  // Loop runs go through the registry's `runpane panes create`, which exists once handlers are registered.
  const loopManager = new LoopManager({
    repo: new LoopRepository(() => databaseService.getDb()),
    startRun: (loop, slotAtMs) => startLoopRun(commandRegistry, loop, slotAtMs, { launchedCommand: panelId => terminalPanelManager.launchedCommand(panelId) }),
    archiveRun: sessionId => archiveLoopRun(commandRegistry, sessionId),
    projectExists: projectId => Boolean(databaseService.getProject(projectId)),
    prepareSession: (target, loop) => prepareLoopSession(commandRegistry, target, loop),
    onChange: () => getPaneEventSink().send('loops:changed'),
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

  const archiveCleanupManager = new ArchiveCleanupManager(databaseService, sessionManager, archiveProgressManager);
  worktreeManager.setArchivePathGuard(target => archiveCleanupManager.assertPathAvailable(target));
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
    archiveCleanupManager,
    analyticsManager,
    spotlightManager,
    workspaceJournal,
    workspaceStateReader,
    sessionPrMonitor,
    loopManager,
    workspaceCursorStore,
    namedLockService,
  };

  const services: AppServices = {
    app: options.app,
    ...daemonServices,
  };

  const commandRegistry = registerIpcHandlers(services);
  const autoPauser = new AutoPauser({
    now: () => Date.now(),
    settings: () => ({ enabled: configManager.getConfig().autoPauseEnabled, hours: configManager.getConfig().autoPauseAfterHours }),
    panes: () => databaseService.getAllSessions(undefined, { includeHidden: true }).map(row => {
      const pane = sessionManager.getSession(row.id);
      return { id: row.id, archived: pane?.archived ?? true, createdAt: pane?.createdAt ?? new Date(), lastViewedAt: pane?.lastViewedAt };
    }),
    panels: paneId => panelManager.getPanelsForSession(paneId),
    liveActivity: panelId => terminalPanelManager.getLastActivity(panelId),
    agentState: panelId => terminalPanelManager.getAgentStatus(panelId),
    hasOpenNotify: panelIds => services.notifyService?.queue.hasOpenFor(panelIds) ?? false,
    focusedPaneId: () => (options.getMainWindow()?.isFocused() ? gitStatusManager.getActiveSessionId() ?? undefined : undefined),
    heldByUpdate: panel => {
      // SAFETY: auto-pause only passes terminal panels; their custom state is TerminalPanelState.
      const hold = (panel.state.customState as TerminalPanelState | undefined)?.updateResumeHold;
      return !!hold && updateHoldIsLive(hold);
    },
    pause: (paneId, mark) => pausePanes(commandRegistry, [paneId], mark),
    testThresholdMs: Number(process.env.PANE_AUTO_PAUSE_TEST_THRESHOLD_MS) || undefined,
  });
  configManager.on('config-updated', () => autoPauser.sync());
  const listeningPortMonitor = createListeningPortMonitor({
    // Terminal panels and agent CLIs (Claude, Codex) both run PTYs inside a Pane.
    terminalPanes: () => [terminalPanelManager, ...CliToolRegistry.getInstance().getAllManagers()].flatMap(manager =>
      [...manager.getSessionPids()].flatMap(([sessionId, pids]) => {
        const paneName = sessionManager.getSession(sessionId)?.name ?? '';
        return pids.map(pid => ({ pid, sessionId, paneName }));
      })),
    onChange: snapshot => {
      latestPorts = snapshot;
      publishPorts();
      void phonePreviews.update(snapshot);
    },
  });
  // Every listed port is forwarded to signed-in clients, Pane's own included.
  const isForwardedPort = (port: number) => listeningPortMonitor.snapshot().ports.some(listed => listed.port === port);
  // On by default only for the desktop Pane that owns ~/.pane; other data dirs opt in through config.
  const workspaceHost = new PaneWorkspaceHostController(
    commandRegistry,
    configManager,
    mode === 'desktop' && path.resolve(getAppDirectory()) === path.join(os.homedir(), '.pane'),
    runRemoteSetupCommand,
    isForwardedPort,
    options.app.getVersion(),
  );
  registerWorkspaceCommands(commandRegistry, workspaceHost, configManager, options.app.getVersion());
  const phonePreviews = new PhonePreviewHost({
    workspace: workspaceHost,
    paneDir: getAppDirectory(),
    files: createPreviewFiles({
      getPanel: panelId => panelManager.getPanel(panelId),
      resolvePath: async (sessionId, filePath) => decodeBoundary(
        await commandRegistry.invoke('file:getPath', [{ sessionId, filePath }]),
        boundary.object({ success: boundary.literal(true), path: boundary.string }),
      ).path,
    }),
    onChange: () => publishPorts(),
  });
  let latestPorts: ListeningPortsSnapshot | null = null;
  const publishPorts = () => {
    if (latestPorts) getPaneEventSink().send('ports:changed', phonePreviews.decorate(latestPorts));
  };
  commandRegistry.register('ports:list', async () => phonePreviews.decorate(await listeningPortMonitor.refresh()));
  // A phone opening a web port; its address arrives with the next ports:changed.
  commandRegistry.register('ports:phone-address', async (port: number) => { await phonePreviews.request(port); });

  let paneDaemonServer: PaneDaemonServer | null = null;
  const remoteTransportController = new PaneRemoteTransportController(commandRegistry, configManager, analyticsManager, isForwardedPort, options.app.getVersion());
  const remoteHostTailnetMonitor = new RemoteHostTailnetMonitor(configManager);
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

  void workspaceHost.start();
  void phonePreviews.start().catch(error => console.warn('[Pane phone previews] Failed to start:', error));
  if (startRemoteTransport) {
    void remoteHostTailnetMonitor.start();
  }

  const daemonSinks: PaneEventSink[] = [workspaceJournal, namedLockService];
  if (paneDaemonServer) {
    daemonSinks.push(paneDaemonServer.getEventSink());
  }
  if (startRemoteTransport) {
    daemonSinks.push(remoteTransportController.getEventSink());
  }
  daemonSinks.push(workspaceHost.getEventSink());

  installPaneRuntime(
    createFanoutEventSink([rendererEventSink, ...daemonSinks]),
    configManager,
    options.getPtyHostRuntime,
    getWebviewContextMap,
    createFanoutEventSink(daemonSinks),
  );

  setupEventListeners(services);
  archiveCleanupManager.start();

  const { logsManager } = await import('../services/panels/logPanel/logsManager');
  logsManager.setAnalyticsManager(analyticsManager);

  gitStatusManager.startPolling();
  sessionPrMonitor.start();
  loopManager.start();
  autoPauser.sync();
  listeningPortMonitor.start();
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
  if (panelResume && resumeAgentsOnStart()) {
    // Not awaited: the socket is up already, and each panel comes back on its own.
    void panelResume.resumeInterruptedAgents().then(results => {
      const failed = results.filter(result => result.state === 'failed').length;
      logger.info(`[PanelResume] Resumed ${results.length - failed} of ${results.length} agent panel(s)`);
    }, error => {
      logResume('[PanelResume] Could not resume the interrupted agent panels', error instanceof Error ? error : new Error(String(error)));
    });
  }

  if (options.restoreSpotlights !== false) {
    try {
      await spotlightManager.restoreAll();
    } catch (error) {
      console.error('[Main] Failed to restore spotlight state:', error);
    }
  }

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
      if (mode === 'headless') logger.info('[Pane daemon] Shutting down');
      // First, so no run starts while the services it needs are closing.
      loopManager.stop();
      autoPauser.stop();
      // Keep the latest scrollback; start-up recovery marks the agents interrupted.
      if (scrollbackCheckpoint) {
        scrollbackCheckpoint.stop();
        await scrollbackCheckpoint.checkpoint();
      }
      await archiveCleanupManager.stop();
      // Before terminals stop: their exits during shutdown must not release locks.
      namedLockService.dispose();
      if (mode === 'headless') {
        // Stop the panels' processes here: systemd's stop does not reach them
        // (see strayPanelProcesses.ts), and the next start resumes the agents.
        const terminals = terminalPanelManager.getAllPanelIds().length;
        const survivors = await terminalPanelManager.stopAllTerminalProcesses();
        logger.info(`[Pane daemon] Stopped ${terminals} terminal(s)`);
        if (survivors.length > 0) logger.warn(`[Pane daemon] ${survivors.length} terminal process(es) survived shutdown: ${survivors.join(', ')}`);
      }
      resourceMonitorService.stop();
      listeningPortMonitor.stop();
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
      remoteHostTailnetMonitor.stop();
      await remoteTransportController.stopWatchingAndShutdown();
      // The workspace handler first: phone handler removal can use up the rest of the budget.
      await workspaceHost.shutdown();
      await phonePreviews.shutdown();
      if (paneDaemonServer) {
        await paneDaemonServer.stop();
      }
      versionChecker.stopPeriodicCheck();
      logger.close();
    },
  };
}
