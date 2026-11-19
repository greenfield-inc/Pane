import { prepareNotifyForQuit } from '../ipc/notify';
import { getChatTabManager } from '../services/chatTabs';
import { getRunpaneShimState, installRunpaneShimBestEffort, writeBrowserShim } from '../services/runpaneShim';
import { DEFAULT_BROWSER_SETTINGS } from '../../../shared/types/browser';
import { BUNDLED_MCP_HTTP_MODULE, PaneMcpEndpoint, setPaneMcpEndpoint, type PaneMcpHttpModule } from '../services/paneMcpEndpoint';
import { tabListener } from '../services/tabListener';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { nativeImage, powerMonitor, type App, type BrowserWindow } from 'electron';
import { runStartupRetentionSweep, startupPanelBufferMigration } from '../services/database';
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
import { onFetch } from '../services/worktreeBaseRefresh';
import { ExecutionTracker } from '../services/executionTracker';
import { WorktreeNameGenerator } from '../services/worktreeNameGenerator';
import { RunCommandManager } from '../services/runCommandManager';
import { VersionChecker } from '../services/versionChecker';
import { SkillCacheManager } from '../services/skillCacheManager';
import { installBundledAgentFarm } from '../services/agentFarm/bundledAgentFarm';
import { startProfileRunner } from '../services/profiles/profileRunnerHost';
import { applyManagedAgentsMdSetting } from '../services/agentContextManager';
import { PaneChatManager } from '../services/paneChatManager';
import { OrchestrationSessionManager } from '../services/orchestrationSessionManager';
import { TaskQueue } from '../services/taskQueue';
import { registerIpcHandlers } from '../ipc';
import { isLockOwnerLive } from '../ipc/runpane';
import { isPaneDaemonListening, PaneDaemonServer } from './server';
import { decideInstanceDuties, type InstanceDuties } from './instanceDuties';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { createRelayHost } from './relay/relayHost';
import { PaneRemoteTransportController } from './remoteTransportController';
import { PaneWorkspaceHostController } from './workspaceHost';
import { runRemoteSetupCommand } from './remote-setup-command';
import { RemoteHostTailnetMonitor } from './remoteHostTailnet';
import { registerWorkspaceCommands } from '../ipc/workspace';
import { registerComputerCommands } from './computerCommands';
import { WORKSPACE_HTTPS_PORT } from './workspacePort';
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
import { MachineHealthService } from '../services/machineHealth/machineHealthService';
import { recheckItem, scanStorage } from '../services/machineHealth/storageInventory';
import { readFootprints } from '../services/machineHealth/footprint';
import { parseSessionTimestampMs } from '../services/paneInactivity';
import { agentTempRoots, ignoredDirs, installPathOf, otherToolPaths, processCwds, readUpdateRecords, wslDiskImages } from '../services/machineHealth/inventorySources';
import { DB_CLEAN_OPEN_PREFERENCE } from '../services/machineHealth/reclaimRules';
import { CleanupEngine } from '../services/machineHealth/cleanupEngine';
import { FinishedPaneMonitor, findFinishedPanes } from '../services/machineHealth/finishedPanes';
import { MemoryRelief, canRestartProcess } from '../services/machineHealth/memoryRelief';
import { OtherApps, readAppProcesses } from '../services/machineHealth/otherApps';
import { HealthCardController } from '../services/machineHealth/healthCardController';
import { showDesktopAlert } from '../ipc/desktopAlerts';
import type { FinishedPane } from '../services/machineHealth/finishedPanes';
import { stopProcessIdentities } from '../services/archiveProcessTracker';
import type { LevelChange } from '../services/machineHealth/machineHealthService';
import { paneInactiveSince } from '../services/paneInactivity';
import { findPrStatusForPane } from '../ipc/runpane';
import { protectionOf } from '../services/machineHealth/paneProtections';
import { fastCheckWorkingDirectory, hasUntrackedWork } from '../services/gitPlumbingCommands';
import { withArchiveRepositoryLock } from '../services/archiveRepositoryLock';
import { PaneError } from '../../../shared/paneError';
import { appScratchDirectory, appScratchRoot } from '../services/archiveRetention';
import { panePausedMark } from '../../../shared/types/panels';
import { MACHINE_HEALTH_CHANGED_EVENT, MACHINE_HEALTH_FINISHED_CHANGED_EVENT, MACHINE_HEALTH_INVENTORY_CHANGED_EVENT, MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, type LeakWarning } from '../../../shared/types/machineHealth';
import type { PaneCommandRegistry } from './commandRegistry';
import { syncRemoteTransportForMode } from './remoteTransportStartup';
import { panelManager } from '../services/panelManager';
import { pausedMarkOf, type TerminalPanelState } from '../../../shared/types/panels';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { createListeningPortMonitor } from '../services/listeningPorts';
import { BackgroundActivity } from '../services/backgroundActivity';
import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';
import { PhonePreviewHost } from './phonePreviews';
import { createPreviewFiles } from './previewProxy';
import { REMOTE_MEMBER_KINDS } from '../services/remoteMemberEvents';
import { WorkspaceJournal } from '../services/workspaceJournal';
import { SessionPrMonitor } from '../services/sessionPrMonitor';
import { LoopManager } from '../services/loops/loopManager';
import { TodoService } from '../services/todos/todoService';
import { TodoStore } from '../services/todos/todoStore';
import { createTodoHost } from '../services/todos/todoHost';
import type { GitStatus } from '../types/session';
import { AutoPauser } from '../services/autoPause';
import { pausePanes } from '../services/panePause';
import { updateHoldIsLive } from '../services/updateRestoration';
import { LoopRepository } from '../services/loops/loopRepository';
import { archiveLoopRun, prepareLoopSession, startLoopRun } from '../ipc/loops';
import { NamedLockService } from '../services/namedLockService';
import { NamedLockStore } from '../services/namedLockStore';
import { WorkspaceStateReader } from '../services/workspaceStateReader';
import { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { startArchiveExpiry } from '../services/archiveExpiry';
import { ARCHIVE_EXPIRY_START_DELAY_MS } from '../../../shared/constants/archiveRetention';

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
  duties: InstanceDuties;
  shutdown(): Promise<void>;
}

let powerMonitorDiagnosticsRegistered = false;

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

/** Leftover processes the person chose to keep (pid:start), so a restart does not ask about them again. */
const KEPT_PROCESSES_PREFERENCE = 'machine_health_kept_processes';

export async function createPaneDaemonHost(options: PaneDaemonHostOptions): Promise<PaneDaemonHost> {
  const mode = options.mode ?? 'desktop';
  // First, before anything reads panels: the retention sweep must trim them before they are cached.
  const duties = decideInstanceDuties({
    ownsDataDirectory: !(await isPaneDaemonListening(getAppDirectory())),
    isPackaged: options.app.isPackaged,
    mode,
  });
  const startupRetention = duties.housekeeping ? runStartupRetentionSweep() : null;
  const startRemoteTransport = (options.startRemoteTransport ?? true) && duties.remoteTransport;
  const rendererEventSink = options.rendererEventSink ?? noopPaneEventSink;
  const headlessWebviewContextMap = new Map<number, PaneWebviewContext>();
  const getWebviewContextMap = options.getWebviewContextMap ?? (() => headlessWebviewContextMap);

  const configManager = new ConfigManager();
  await configManager.initialize();
  // Outside edits to config.json (by hand, a script, an agent) reload at once.
  configManager.startWatching();
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

  if (!duties.housekeeping) {
    logger.warn(
      `[Pane] Another Pane already serves ${getAppDirectory()}: this one runs no cleanup on its data, ` +
      'no remote host listener and no Tailscale Serve changes. Quit it and give it its own PANE_DIR.',
    );
  }
  if (startupRetention?.error) {
    logger.error('[ScrollbackRetention] Sweep failed', startupRetention.error);
  } else if (startupRetention?.result && startupRetention.result.panelsCleared > 0) {
    const result = startupRetention.result;
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
  // Desktop only: a headless host has no window or person to wait for, so it keeps today's behaviour.
  const backgroundActivity = mode === 'desktop' ? new BackgroundActivity(configManager, { logger }) : null;
  const gitStatusManager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager, logger, databaseService);
  // Every fetch into a project (Fetch button, dashboard, branch list, new worktree, an agent's own) updates its Panes' ahead/behind.
  onFetch(projectPath => {
    gitStatusManager.refreshProjectAfterFetch(projectPath).catch(error => {
      logger.warn(`[GitStatus] Could not update ${projectPath} after a fetch: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  const executionTracker = new ExecutionTracker(sessionManager, gitDiffManager);
  const worktreeNameGenerator = new WorktreeNameGenerator(configManager);
  const runCommandManager = new RunCommandManager(databaseService);
  const versionChecker = new VersionChecker(configManager, logger);
  // Terminals launched below find this build's runpane first on PATH.
  // Their BROWSER follows Settings > Links (pane-browser).
  const openLinksIn = () => ({ ...DEFAULT_BROWSER_SETTINGS, ...configManager.getConfig().browser }).openLinksIn;
  installRunpaneShimBestEffort(getAppDirectory(), openLinksIn());
  configManager.on('config-updated', () => {
    // A shim Pane can't write keeps the last choice; the setting still saves and other listeners still run.
    try {
      writeBrowserShim(openLinksIn());
    } catch (error) {
      console.error('[runpane] Could not rewrite pane-browser for Settings > Links:', error);
    }
  });
  // The loopback listener for the tabs Pane starts (Claude's prompt hooks, Pane's MCP tools). Not awaited: the
  // first window doesn't wait for it, and a tab spawned before it listens just keeps stdio.
  void tabListener.start().catch(error => {
    logger.warn('[TabListener] Tabs keep stdio Pane tools and terminal-only prompts: the loopback listener did not start', error instanceof Error ? error : undefined);
  });
  // Tabs whose agent supports it reach Pane's tools here over HTTP instead of each starting its own `runpane mcp`.
  const paneMcpEndpoint = new PaneMcpEndpoint({
    load: (): Promise<PaneMcpHttpModule> => import(BUNDLED_MCP_HTTP_MODULE),
    cli: () => getRunpaneShimState()?.cli,
    settings: () => {
      const agentContext = configManager.getConfig().agentContext;
      return { enabled: agentContext?.registerMcp !== false, toolsets: agentContext?.mcpToolsets };
    },
  });
  paneMcpEndpoint.attach();
  setPaneMcpEndpoint(paneMcpEndpoint);
  const skillCacheManager = new SkillCacheManager();
  await skillCacheManager.start().catch(error => {
    logger.warn('[SkillCache] Failed to install Pane Chat skills', error instanceof Error ? error : undefined);
  });
  await skillCacheManager.syncHomeSkill(configManager.getConfig(), databaseService.getAllProjects());
  // Bundled profiles: set up greenfield and the other bundled plugins in Pane's own Agent Farm
  // config root, without delaying startup. It never touches the person's own Agent Farm.
  // The Profiles page shows the install's state, so it reads the library again when it ends.
  void installBundledAgentFarm({ paneDir: getAppDirectory(), log: message => logger.info(message) }).then(() => getPaneEventSink().send('profiles:changed'));
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
  orchestrationSessionManager.liveActivity.start();
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
    ask: async (card, signal) => {
      const queue = services.notifyService?.queue;
      if (!queue) return null;
      const record = card.sessionId ? orchestrationSessionManager.approvalSessionRecord(card.sessionId) : undefined;
      const session = card.sessionId && record ? { id: card.sessionId, name: record.name, paneId: record.paneId } : undefined;
      const result = await queue.ask({
        // Only a pick acts; a note typed beside it never turns the answer into a reply Pane can't act on.
        question: { ui: 'options', title: card.title, context: card.context, optionsOnly: true, choices: card.choices.map((label, index) => ({ label, recommended: index === 0 })) },
        source: { name: 'Loops', agent: 'Pane', ...(session && { session }) },
      }, signal);
      if ('answer' in result) return card.choices.includes(result.answer) ? result.answer : result.answers?.[0] ?? null;
      return 'reply' in result ? result.picks?.[0] ?? null : null;
    },
    archiveSession: async sessionId => {
      await commandRegistry.invoke('runpane:sessions:update', [{ selector: { sessionId }, input: { archived: true, source: 'user' } }]);
    },
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
  // A WSL project stores Linux paths; Node's fs reads them through the project's path resolver.
  const contextOf = (session: { project_id?: number | null }) => (session.project_id ? sessionManager.getProjectContextByProjectId(session.project_id) : null);
  const fileSystemPath = (session: { project_id?: number | null }, stored: string) => contextOf(session)?.pathResolver.toFileSystem(stored) ?? stored;
  // Git runs through the project's command runner at the stored (Linux, for WSL) path.
  const storedWorktrees = new Map<string, string>();
  const inventoryPanes = () => databaseService.getAllSessionsIncludingArchived({ includeHidden: true }).flatMap(session => {
    const context = contextOf(session);
    if (!context) return [];
    if (session.worktree_path) storedWorktrees.set(session.id, session.worktree_path);
    return [{
      id: session.id, name: session.name, worktreePath: session.worktree_path ? context.pathResolver.toFileSystem(session.worktree_path) : null,
      projectPath: context.pathResolver.toFileSystem(context.project.path),
      branch: session.worktree_name, archived: !!session.archived, updatedAt: parseSessionTimestampMs(session.updated_at), isMainRepo: !!session.is_main_repo,
      ownedByPane: session.worktree_ownership !== 'external',
      paused: !session.archived && !!panePausedMark(panelManager.getPanelsForSession(session.id)),
    }];
  });
  // Only folders Pane made worktrees in: an adopted worktree's or a projectless session's parent is the person's own folder.
  const worktreeRoots = () => [...new Set(databaseService.getAllSessionsIncludingArchived({ includeHidden: true })
    .flatMap(session => (session.worktree_path && session.project_id && !session.is_main_repo && session.worktree_ownership !== 'external'
      ? [path.dirname(fileSystemPath(session, session.worktree_path))] : [])))];
  const installPath = () => installPathOf(process.execPath, !!options.app?.isPackaged);
  const listGitWorktrees = async (pane: { id: string }) => {
    const context = sessionManager.getProjectContext(pane.id);
    if (!context) return [];
    const { project, commandRunner, pathResolver } = context;
    return (await worktreeManager.listWorktrees(project.path, commandRunner)).map(worktree => ({ ...worktree, path: pathResolver.toFileSystem(worktree.path) }));
  };
  const inventoryIgnoredDirs = async (pane: { id: string }) => {
    const context = sessionManager.getProjectContext(pane.id);
    const stored = storedWorktrees.get(pane.id);
    return context && stored ? ignoredDirs(stored, context.commandRunner) : [];
  };
  const machineHealth = new MachineHealthService({
    now: () => Date.now(),
    settings: () => configManager.getConfig().machineHealth,
    volumePaths: () => [
      { path: getAppDirectory(), role: 'pane-data' as const },
      { path: os.tmpdir(), role: 'temp' as const },
      ...[...new Set(databaseService.getAllSessions(undefined, { includeHidden: true })
        .flatMap(session => (session.worktree_path ? [path.dirname(fileSystemPath(session, session.worktree_path))] : [])))]
        .map(folder => ({ path: folder, role: 'worktrees' as const })),
    ],
    processes: () => resourceMonitorService.getSnapshot(),
    readFootprints: process.platform === 'darwin' ? readFootprints : undefined,
    scanInventory: () => scanStorage({
      now: () => Date.now(),
      paneDir: getAppDirectory(),
      panes: inventoryPanes,
      worktreeRoots,
      agentTempRoots: () => agentTempRoots(),
      installPath,
      cleanOpenAt: () => Number(databaseService.getUserPreference(DB_CLEAN_OPEN_PREFERENCE)) || null,
      archiveJobsInFlight: () => new Set(archiveCleanupManager.getTasks().filter(task => task.status !== 'completed').map(task => task.sessionId)),
      readUpdates: () => readUpdateRecords(getAppDirectory()),
      listGitWorktrees,
      ignoredDirs: inventoryIgnoredDirs,
      processCwds,
      otherTools: async () => [...otherToolPaths(), ...await wslDiskImages()],
      appScratchDir: appScratchDirectory,
    }),
  });
  // Payload-free: readers re-read. The per-minute sample stays off the daemon stream.
  machineHealth.on('level-changed', () => getPaneEventSink().send(MACHINE_HEALTH_CHANGED_EVENT));
  machineHealth.on('inventory', () => getPaneEventSink().send(MACHINE_HEALTH_INVENTORY_CHANGED_EVENT));
  // Migration backups become removable once a later start opened the database cleanly.
  if (duties.housekeeping && !startupPanelBufferMigration.error) databaseService.setUserPreference(DB_CLEAN_OPEN_PREFERENCE, String(Date.now()));
  const daemonServices: DaemonHostServices = {
    machineHealth,
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
    backgroundActivity: backgroundActivity ?? undefined,
  };

  const services: AppServices = {
    app: options.app,
    ...daemonServices,
  };

  const commandRegistry = registerIpcHandlers(services);

  // To-dos (D-409): the service answers reads everywhere; only the instance that does housekeeping
  // runs the supervisor, the load gate and launch resume, so one data folder has one supervisor.
  // Test-only (D-409 validation): PANE_TODOS_TIME_SCALE=60 runs the supervisor's and gate's minutes as seconds. Ignored when packaged.
  const todoTimeScale = options.app?.isPackaged !== false ? 1 : Math.max(1, Number(process.env.PANE_TODOS_TIME_SCALE) || 1);
  const todoClockStart = Date.now();
  const todoClock = todoTimeScale === 1 ? Date.now : () => todoClockStart + (Date.now() - todoClockStart) * todoTimeScale;
  const todoService = new TodoService(new TodoStore(databaseService.getDb()), createTodoHost(services, commandRegistry), todoClock);
  services.todoService = todoService;
  // T-7: to-do Sessions made before Sessions carried their to-do's number get it now, so no list shows them.
  void services.orchestrationSessionManager?.markTodoSessions(todoService.sessionLinks()).catch((error: Error) => {
    console.warn('[todos] Could not mark older to-do Sessions; the Sessions list hides them once the to-dos load:', error);
  });
  daemonServices.todoService = todoService;
  let todosChangedTimer: ReturnType<typeof setTimeout> | undefined;
  todoService.on('changed', () => {
    if (todosChangedTimer) return;
    todosChangedTimer = setTimeout(() => {
      todosChangedTimer = undefined;
      getPaneEventSink().send('todos:changed');
    }, 150);
  });
  services.notifyService?.queue.on('change', () => {
    const queue = services.notifyService?.queue;
    if (queue) todoService.onApprovalsChanged(queue.snapshot().items);
  });
  const lastCommits = new Map<string, number>();
  gitStatusManager.on('git-status-updated', (paneId: string, status: GitStatus) => {
    if (status.prNumber && status.prUrl) todoService.onPr(paneId, { url: status.prUrl, number: status.prNumber, title: status.prTitle });
    const commits = status.totalCommits ?? 0;
    const before = lastCommits.get(paneId);
    lastCommits.set(paneId, commits);
    if (before !== undefined && commits > before) todoService.noteProgressForPane(paneId);
  });
  let todoTimer: ReturnType<typeof setInterval> | undefined;
  let todoLaunchTimer: ReturnType<typeof setTimeout> | undefined;
  if (duties.housekeeping) {
    let ticking = false;
    todoTimer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      // Round 9: the wake check reads the wall clock each tick (no timer per to-do), so a snooze that came due
      // while Pane was closed or the Mac slept wakes on the first tick after; it waits for launch resume below.
      // Each stage catches its own failure, so one can't stop wakes, the load gate or the supervisor (F-4).
      const stage = (name: string, run: () => Promise<void>) => () => run().catch(error => logger.warn(`[Todos] ${name} failed`, error));
      void stage('tick', () => todoService.fastTick())()
        .then(stage('wake check', () => todoService.wakeTick()))
        .then(stage('load check', () => todoService.loadTick()))
        .then(stage('supervisor pass', () => todoService.supervisorPass()))
        .finally(() => { ticking = false; });
    }, 2_000);
    todoService.prune();
    // Launch resume, once the window and tabs have settled.
    todoLaunchTimer = setTimeout(() => {
      void todoService.resumeOnLaunch('launch').catch(error => logger.warn('[Todos] launch resume failed', error));
    }, 10_000);
    powerMonitor.on('resume', () => {
      setTimeout(() => { void todoService.resumeOnLaunch('wake').catch(error => logger.warn('[Todos] wake resume failed', error)); }, 10_000);
    });
  }
  const autoPauser = new AutoPauser({
    now: () => Date.now(),
    settings: () => ({ enabled: configManager.getConfig().autoPauseEnabled, hours: configManager.getConfig().autoPauseAfterHours, chatMinutes: configManager.getConfig().chatIdleReleaseMinutes }),
    panes: () => databaseService.getAllSessions(undefined, { includeHidden: true }).map(row => {
      const pane = sessionManager.getSession(row.id);
      return { id: row.id, archived: pane?.archived ?? true, createdAt: pane?.createdAt ?? new Date(), lastViewedAt: pane?.lastViewedAt };
    }),
    panels: paneId => panelManager.getPanelsForSession(paneId),
    liveActivity: panelId => terminalPanelManager.getLastActivity(panelId) ?? getChatTabManager().lastActivity(panelId),
    agentState: panelId => panelManager.getPanel(panelId)?.type === 'chat' ? getChatTabManager().agentState(panelId) : terminalPanelManager.getAgentStatus(panelId),
    hasOpenNotify: panelIds => services.notifyService?.queue.hasOpenFor(panelIds) ?? false,
    focusedPaneId: () => (options.getMainWindow()?.isFocused() ? gitStatusManager.getActiveSessionId() ?? undefined : undefined),
    shownPaneId: () => {
      const window = options.getMainWindow();
      return window?.isVisible() && !window.isMinimized() ? gitStatusManager.getActiveSessionId() ?? undefined : undefined;
    },
    heldByUpdate: panel => {
      // SAFETY: auto-pause only passes terminal panels; their custom state is TerminalPanelState.
      const hold = (panel.state.customState as TerminalPanelState | undefined)?.updateResumeHold;
      return !!hold && updateHoldIsLive(hold);
    },
    pause: (paneId, mark) => pausePanes(commandRegistry, [paneId], mark),
    chatRunning: panelId => getChatTabManager().isRunning(panelId),
    pauseChats: (panelIds, mark) => getChatTabManager().pause(panelIds, mark),
    testThresholdMs: Number(process.env.PANE_AUTO_PAUSE_TEST_THRESHOLD_MS) || undefined,
  });
  configManager.on('config-updated', () => autoPauser.sync());
  // Terminal panels, agent CLIs (Claude, Codex) and chat tab agents all run processes inside a Pane.
  // Chat tab agents talk over stdio, not a PTY; their updates count as output too.
  const paneProcessManagers = () => [terminalPanelManager, ...CliToolRegistry.getInstance().getAllManagers(), getChatTabManager()];
  const listeningPortMonitor = createListeningPortMonitor({
    terminalPanes: () => paneProcessManagers().flatMap(manager =>
      [...manager.getSessionPids()].flatMap(([sessionId, pids]) => {
        const paneName = sessionManager.getSession(sessionId)?.name ?? '';
        return pids.map(pid => ({ pid, sessionId, paneName }));
      })),
    lastOutputAt: () => Math.max(...paneProcessManagers().map(manager => manager.latestOutputAt())),
    // Remote clients over the paired or the Tailscale transport. This desktop's own ports lists
    // ask for a read while they are on screen (useListeningPorts).
    watched: () => [remoteTransportController.getServer(), workspaceHost].some(server => server?.hasEventSubscriber('ports:changed')),
    onChange: snapshot => {
      latestPorts = snapshot;
      publishPorts();
      void phonePreviews.update(snapshot);
    },
  });
  // Ports pause while nobody is looking and catch up the moment someone is.
  backgroundActivity?.on('change', (away: boolean) => listeningPortMonitor.setPaused(away));
  listeningPortMonitor.setPaused(backgroundActivity?.isAway() ?? false);
  // Every listed port is forwarded to signed-in clients, Pane's own included. While polling is
  // paused the list can be old, so a port missing from it is read once before it is refused.
  const isListed = (port: number) => listeningPortMonitor.snapshot().ports.some(listed => listed.port === port);
  const isForwardedPort = async (port: number) => isListed(port)
    || (listeningPortMonitor.isPaused() && (await listeningPortMonitor.refresh()).ports.some(listed => listed.port === port));
  // On by default only for the desktop Pane that owns ~/.pane; other data dirs opt in through config.
  const workspaceHost = new PaneWorkspaceHostController(
    commandRegistry,
    configManager,
    duties.serveRefusal
      ? { kind: 'refused', reason: duties.serveRefusal }
      : { kind: 'allowed', onByDefault: mode === 'desktop' && path.resolve(getAppDirectory()) === path.join(os.homedir(), '.pane') },
    runRemoteSetupCommand,
    isForwardedPort,
    options.app.getVersion(),
  );
  registerWorkspaceCommands(commandRegistry, workspaceHost, configManager, options.app.getVersion());
  const phonePreviewFiles = createPreviewFiles({
    getPanel: panelId => panelManager.getPanel(panelId),
    resolvePath: async (sessionId, filePath) => decodeBoundary(
      await commandRegistry.invoke('file:getPath', [{ sessionId, filePath }]),
      boundary.object({ success: boundary.literal(true), path: boundary.string }),
    ).path,
  });
  const phonePreviews = new PhonePreviewHost({
    workspace: workspaceHost,
    paneDir: getAppDirectory(),
    files: phonePreviewFiles,
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
  // Phone access through Pane's relays (QR pairing); idle until turned on in Remote Access.
  const relayHost = startRemoteTransport
    ? await createRelayHost({
      commandRegistry,
      configManager,
      dataDir: getAppDirectory(),
      // A relay phone's open event stream keeps port reads running, so the snapshot is current.
      isForwardedPort: isListed,
      files: phonePreviewFiles,
      log: line => logger.info(line),
    }).catch((cause: unknown) => {
      logger.error('[Pane relay] Failed to start', cause instanceof Error ? cause : new Error(String(cause)));
      return null;
    })
    : null;
  registerComputerCommands(commandRegistry, configManager, {
    relay: () => relayHost?.service.computerInfo(),
    tailnet: () => {
      const tailnet = workspaceHost.getTailnet();
      return tailnet && workspaceHost.getAccess().visibility !== 'off' ? { dnsName: tailnet.dnsName, machineName: tailnet.machineName, port: WORKSPACE_HTTPS_PORT } : null;
    },
  });
  if (relayHost) {
    powerMonitor.on('suspend', () => relayHost.suspend());
    powerMonitor.on('resume', () => relayHost.resume());
  }
  const remoteTransportController = new PaneRemoteTransportController(commandRegistry, configManager, analyticsManager, isForwardedPort, options.app.getVersion(), relayHost?.pairing, workspaceHost.glasses);
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
  // Profiles: Pane runs each launched profile's workflow from its file, and resumes saved runs.
  startProfileRunner(services, commandRegistry, workspaceJournal, message => logger.info(message));
  // A member Pane's reports and exits go to every connected computer: one whose Session holds this
  // Pane records them (`RemoteMemberEvents`). Entries recorded from another machine are not sent on.
  workspaceJournal.subscribe(entry => {
    if (REMOTE_MEMBER_KINDS.has(entry.kind) && !entry.machine) getPaneEventSink().send('workspace:entry', entry, workspaceJournal.epoch);
  });
  if (duties.housekeeping) archiveCleanupManager.start();

  const { logsManager } = await import('../services/panels/logPanel/logsManager');
  logsManager.setAnalyticsManager(analyticsManager);

  gitStatusManager.startPolling();
  sessionPrMonitor.start();
  // A Session archived anywhere pauses the loops that send to it, so no run brings it back.
  orchestrationSessionManager.on('archived', (sessionId: string) => { loopManager.pauseForArchivedSession(sessionId); });
  loopManager.start();
  autoPauser.sync();
  /** True only when the OS confirms the folder is not there; any other failure cannot tell. */
  const folderGone = (folder: string) => fs.promises.access(folder).then(
    () => false,
    error => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  );
  const paneProtection = (paneId: string) => protectionOf(paneId, {
    pinned: id => !!databaseService.getSession(id)?.is_favorite,
    focusedPaneId: () => (options.getMainWindow()?.isFocused() ? gitStatusManager.getActiveSessionId() ?? undefined : undefined),
    panelIds: id => panelManager.getPanelsForSession(id).map(panel => panel.id),
    agentState: panelId => (panelManager.getPanel(panelId)?.type === 'chat' ? getChatTabManager().agentState(panelId) : terminalPanelManager.getAgentStatus(panelId)),
    hasOpenNotify: panelIds => services.notifyService?.queue.hasOpenFor(panelIds) ?? false,
    hasUncommittedChanges: async id => {
      const session = databaseService.getSession(id);
      const ctx = sessionManager.getProjectContext(id);
      if (!session?.worktree_path || !ctx) throw new Error('No worktree');
      // A folder the OS confirms is gone has nothing left to lose; WSL paths resolve through the project.
      if (await folderGone(ctx.pathResolver.toFileSystem(session.worktree_path))) return false;
      // WSL-aware; a folder it cannot read counts as changed, so "cannot tell" protects the Pane.
      const status = await fastCheckWorkingDirectory(session.worktree_path, ctx.commandRunner.wslContext);
      if (status.hasModified || status.hasStaged || status.hasConflicts) return true;
      return status.hasUntracked && await hasUntrackedWork(session.worktree_path, ctx.commandRunner);
    },
  });
  const machineCleanup = new CleanupEngine({
    now: () => Date.now(),
    inventory: async () => machineHealth.getInventory() ?? machineHealth.scanInventory(),
    recheck: item => recheckItem(item, { now: () => Date.now(), panes: inventoryPanes, listGitWorktrees }),
    protectionOf: paneProtection,
    processCwds,
    freeBytes: async folder => {
      const fsStats = await fs.promises.statfs(folder);
      return Number(fsStats.bavail) * Number(fsStats.bsize);
    },
    settings: () => configManager.getConfig().machineHealth,
    // The folders every reclaimable kind sits in (see scanStorage), plus each open Pane's `.pane` for its scratch.
    trashParents: () => {
      const install = installPath();
      return [
        getAppDirectory(), path.join(getAppDirectory(), 'updates'), appScratchRoot(), ...(install ? [path.dirname(install)] : []),
        ...agentTempRoots(), ...worktreeRoots(),
        ...inventoryPanes().flatMap(pane => (!pane.archived && pane.worktreePath ? [path.join(pane.worktreePath, '.pane')] : [])),
      ];
    },
    moveWorktree: async (item, move) => {
      const ctx = item.sessionId ? sessionManager.getProjectContext(item.sessionId) : null;
      if (!ctx) throw new PaneError('ERR_MACHINE_CLEANUP_NO_PROJECT', 'Pane no longer has this Pane\'s project, so it cannot update git\'s worktree records. Nothing was moved.', 'Remove the folder with git worktree remove from its repository.');
      await withArchiveRepositoryLock(ctx.project.path, ctx.commandRunner, async () => {
        await move();
        await ctx.commandRunner.execFile('git', ['worktree', 'prune'], ctx.project.path, { silent: true, timeout: 30_000 })
          .catch(error => logger.warn(`[MachineHealth] git worktree prune failed in ${ctx.project.path}; git drops the record on its next gc.`, error instanceof Error ? error : undefined));
      });
    },
    log: message => logger.info(message),
  });
  if (duties.housekeeping) {
    // Only the Pane that owns this data folder deletes anything; another one answers cleanup requests with ERR_MACHINE_HEALTH_UNAVAILABLE.
    services.machineCleanup = machineCleanup;
    void machineCleanup.finishPendingDeletes();
    machineHealth.setScheduledCleanup(async () => {
      await machineCleanup.run({ source: 'schedule', tiers: [1, 2] });
      // Tier 1: archive cleanup jobs that failed get one more try a day.
      for (const task of archiveCleanupManager.getTasks()) {
        if (task.status === 'failed' && !task.interruptedScript) {
          try { archiveCleanupManager.retry(task.sessionId, false); } catch { /* not ready; next pass */ }
        }
      }
    });
  }
  const finishedPanes = new FinishedPaneMonitor({
    now: () => Date.now(),
    find: scope => findFinishedPanes({
      now: () => Date.now(),
      // At least 1: 0 would mark every open Pane finished.
      idleDays: Math.max(1, configManager.getConfig().machineHealth?.finishedIdleDays ?? 14),
      panes: () => databaseService.getAllSessions(undefined, { includeHidden: true }).flatMap(session => {
        if (session.archived || session.is_main_repo || !session.worktree_path || !session.project_id) return [];
        if (scope.ids && !scope.ids.includes(session.id)) return [];
        // Stored paths are Linux paths for WSL; without its project Pane cannot resolve one, so it lists nothing.
        const ctx = sessionManager.getProjectContext(session.id);
        if (!ctx) return [];
        const pane = sessionManager.getSession(session.id);
        const inactiveSince = paneInactiveSince(
          { createdAt: pane?.createdAt ?? new Date(session.created_at), lastViewedAt: pane?.lastViewedAt, panels: panelManager.getPanelsForSession(session.id) },
          panelId => terminalPanelManager.getLastActivity(panelId) ?? getChatTabManager().lastActivity(panelId),
        ).getTime();
        const projectName = databaseService.getProject(session.project_id)?.name ?? '';
        return [{ id: session.id, name: session.name, projectName, worktreePath: ctx.pathResolver.toFileSystem(session.worktree_path), inactiveSince }];
      }),
      prStatus: paneId => (scope.offline ? Promise.resolve({ state: 'unknown' as const }) : findPrStatusForPane(services, paneId)),
      folderExists: async folder => !(await folderGone(folder)),
      protectionOf: paneProtection,
      sizeOf: paneId => machineHealth.cachedInventory()?.panes.find(pane => pane.sessionId === paneId)?.worktreeBytes ?? null,
    }),
    archive: async paneId => {
      const result = decodeBoundary(await commandRegistry.invoke('sessions:delete', [paneId]), boundary.object({ success: boundary.boolean, error: boundary.optional(boundary.string) }));
      if (!result.success) throw new Error(result.error ?? 'Archive failed');
    },
    automatic: () => configManager.getConfig().machineHealth?.autoArchiveFinished === true,
    record: run => machineCleanup.note(run),
  });
  services.finishedPanes = finishedPanes;
  if (duties.housekeeping) {
    finishedPanes.start();
    machineHealth.on('level-changed', (change: LevelChange) => {
      if (change.kind === 'disk' && change.level !== 'ok') void finishedPanes.check().catch(() => undefined);
    });
  }
  const latestPaneMemoryMB = (paneId: string) => machineHealth.latestSnapshot()?.panes.find(pane => pane.sessionId === paneId)?.rssMB ?? 0;
  const paneState = (paneId: string): 'archived' | 'paused' | 'open' => {
    const session = databaseService.getSession(paneId);
    if (!session || session.archived) return 'archived';
    return panePausedMark(panelManager.getPanelsForSession(paneId)) ? 'paused' : 'open';
  };
  const memoryRelief = new MemoryRelief({
    now: () => Date.now(),
    paneName: paneId => databaseService.getSession(paneId)?.name ?? paneId,
    stop: identities => stopProcessIdentities(identities),
    idlePanes: hours => autoPauser.idlePanes(hours),
    pauseIdle: (hours, paneIds) => autoPauser.pauseIdleNow(hours, paneIds),
    pinned: paneId => !!databaseService.getSession(paneId)?.is_favorite,
    paneMemoryMB: latestPaneMemoryMB,
    settings: () => configManager.getConfig().machineHealth,
    record: run => machineCleanup.note(run),
  });
  services.memoryRelief = memoryRelief;
  services.otherApps = new OtherApps({
    platform: process.platform,
    selfPid: process.pid,
    now: () => Date.now(),
    read: readAppProcesses,
    paneProcesses: () => new Set(machineHealth.latestSnapshot()?.panes.flatMap(pane => pane.processes.map(proc => proc.pid)) ?? []),
    // macOS answers getFileIcon with a generic placeholder for app bundles; its thumbnail is the real icon.
    iconOf: process.platform === 'linux' ? undefined : async iconPath => {
      const icon = process.platform === 'darwin'
        ? await nativeImage.createThumbnailFromPath(iconPath, { width: 32, height: 32 })
        : await options.app.getFileIcon(iconPath, { size: 'normal' });
      return icon.isEmpty() ? undefined : icon.toDataURL();
    },
    stop: identities => stopProcessIdentities(identities),
    record: run => machineCleanup.note(run),
  });
  if (duties.housekeeping) {
    machineHealth.on('snapshot', snapshot => { void memoryRelief.onSnapshot(snapshot).catch(error => logger.warn('[MachineHealth] memory relief failed', error)); });
    taskQueue.setInstallsOneAtATime(() => machineHealth.latestSnapshot()?.memory.level !== undefined && machineHealth.latestSnapshot()?.memory.level !== 'ok');
  }
  const healthCards = new HealthCardController({
    now: () => Date.now(),
    ask: question => {
      const queue = services.notifyService?.queue;
      if (!queue) return Promise.resolve({ unavailable: 'Approvals are not running.', next: 'Turn on Approvals in Settings.' });
      return queue.ask({
        question: { ui: 'options', title: question.title, context: question.context, choices: question.choices.map((label, index) => ({ label, recommended: index === 0 })), machineHealth: question.card },
        source: { name: 'Pane', agent: 'Pane' },
      });
    },
    inventory: () => machineHealth.cachedInventory(),
    idleOffer: () => memoryRelief.idleOffer(),
    pauseIdleHours: () => configManager.getConfig().machineHealth?.pauseIdleHours ?? 2,
    paneName: paneId => databaseService.getSession(paneId)?.name ?? paneId,
    paneState,
    tabName: panelId => panelManager.getPanel(panelId)?.title ?? null,
    canRestart: leak => canRestartProcess(machineHealth.latestSnapshot(), leak, paneId => logsManager.isRunning(paneId)),
    cleanUp: async itemIds => {
      await machineCleanup.run({ source: 'card', tiers: [1, 2], ids: itemIds });
      // Rescan so Resources and the CLI stop listing what the card removed.
      void machineHealth.scanInventory().catch(() => undefined);
    },
    readKept: () => {
      try {
        return decodeOptionalBoundary(JSON.parse(databaseService.getUserPreference(KEPT_PROCESSES_PREFERENCE) ?? '[]'), boundary.array(boundary.string)) ?? [];
      } catch {
        return [];
      }
    },
    writeKept: identities => databaseService.setUserPreference(KEPT_PROCESSES_PREFERENCE, JSON.stringify(identities)),
    pauseIdle: async () => { await memoryRelief.pauseIdle('card'); },
    stopProcess: async leak => { await commandRegistry.invoke(MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, [{ source: 'card', processes: [{ pid: leak.pid, started: leak.started }] }]); },
    stopProcesses: processes => memoryRelief.stopProcesses(processes, 'card'),
    restartProcess: async leak => { await commandRegistry.invoke(MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, [{ pid: leak.pid, started: leak.started }]); },
    ignoreLeak: leak => machineHealth.ignoreLeak(leak.pid, leak.started),
    archive: async paneIds => { await finishedPanes.archive(paneIds, 'card'); },
    alert: (title, body) => showDesktopAlert(services, services.notifyService?.queue.alertsHere() ?? true, title, body),
    log: message => logger.warn(message),
  });
  if (duties.housekeeping) {
    machineHealth.on('snapshot', snapshot => healthCards.onSnapshot(snapshot));
    machineHealth.on('leak', (leak: LeakWarning) => {
      const snapshot = machineHealth.latestSnapshot();
      if (snapshot) void healthCards.onLeak(leak, snapshot);
    });
    finishedPanes.on('finished', (list: FinishedPane[]) => {
      const snapshot = machineHealth.latestSnapshot();
      if (snapshot) healthCards.onFinished(list, snapshot);
    });
  }
  finishedPanes.on('finished', list => getPaneEventSink().send(MACHINE_HEALTH_FINISHED_CHANGED_EVENT, list));
  machineHealth.start();
  // Delete archived folders past their retention, keeping their agent logs; deferred so startup stays fast.
  let stopArchiveExpiry: (() => void) | undefined;
  const archiveExpiryTimer = setTimeout(() => { stopArchiveExpiry = startArchiveExpiry(); }, ARCHIVE_EXPIRY_START_DELAY_MS);
  archiveExpiryTimer.unref();
  listeningPortMonitor.start();
  if (mode === 'desktop') {
    versionChecker.startPeriodicCheck();
  }
  resourceMonitorService.initialize({
    app: options.app,
    processRoots: () => [
      ...paneProcessManagers().flatMap(manager => manager.getPanelPids()),
      ...databaseService.getAllSessions(undefined, { includeHidden: true }).flatMap(session =>
        runCommandManager.getArchiveProcessPids(session.id).map(pid => ({ pid, sessionId: session.id, panelId: null }))),
    ],
    knownSessionIds: () => new Set(databaseService.getAllSessionsIncludingArchived({ includeHidden: true }).map(session => session.id)),
    getSessionById: (sessionId) => sessionManager.getSession(sessionId),
    getSessionWslDistro: (sessionId) => {
      const projectId = sessionManager.getSession(sessionId)?.projectId;
      if (!projectId) return null;
      const project = databaseService.getProject(projectId);
      return project?.wsl_enabled && project.wsl_distribution ? project.wsl_distribution : null;
    },
  });

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
    duties,
    async shutdown(): Promise<void> {
      prepareNotifyForQuit();
      // First, so no run starts while the services it needs are closing.
      loopManager.stop();
      clearInterval(todoTimer);
      clearTimeout(todoLaunchTimer);
      machineHealth.stop();
      finishedPanes.stop();
      autoPauser.stop();
      clearTimeout(archiveExpiryTimer);
      stopArchiveExpiry?.();
      await archiveCleanupManager.stop();
      // Before terminals stop: their exits during shutdown must not release locks.
      namedLockService.dispose();
      await getChatTabManager().stopAll();
      setPaneMcpEndpoint(undefined);
      paneMcpEndpoint.detachAll();
      await tabListener.stop();
      listeningPortMonitor.stop();
      backgroundActivity?.dispose();
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
      await relayHost?.stop();
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
