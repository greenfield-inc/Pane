// Type definitions for Electron preload API
import type { Session, SessionOutput, GitStatus, VersionInfo, VersionUpdateInfo } from './session';
import type { Project } from './project';
import type { Folder } from './folder';
import type { AppConfig, UpdateConfigRequest } from './config';
import type { SessionCreationPreferences } from '../stores/sessionPreferencesStore';
import type {
  RemoteDaemonClientRecord,
  RemoteDaemonConnectionPair,
  RemoteDaemonClientSettings,
  RemoteDaemonConfig,
  RemoteDaemonHostConfig,
  RemoteDaemonHostRuntimeState,
  RemoteHostConnectionCodeResult,
  RemoteDaemonImportResult,
  RemoteHostSetupRequest,
  RemoteHostSetupResult,
  RemoteHostSetupTerminalCommandResult,
  RemotePaneConnectionState,
  RemotePaneConnectionProfile,
} from '../../../shared/types/remoteDaemon';
import type {
  PanePermissionRequest,
  PanePermissionResolvedEvent,
  PanePermissionResponse,
} from '../../../shared/types/daemon';
import type {
  CreatePanelRequest,
  PanelEventType,
  ResumableSession,
  SessionPanelLayout,
  ToolPanel,
} from '../../../shared/types/panels';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import type { DiffManifest, DiffScope, FileDiffRequest, FileDiffResult } from '../../../shared/types/gitDiff';
import type { AgentUsageSnapshot } from '../../../shared/types/agentUsage';
import type { PaneChatAgent, PaneChatState } from '../../../shared/types/paneChat';
import type {
  OrchestrationAssociationInput,
  OrchestrationSessionCreateInput,
  OrchestrationSessionListResult,
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
  OrchestrationSessionSelector,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import type { UsageIndexStatus, UsageReport, UsageReportRequest } from '../../../shared/types/usage';
import type { LeaderboardResponse, LeaderboardStatus, LeaderboardSubmitResult } from '../../../shared/types/leaderboard';
import type { CreateSessionRequest } from './session';
import type { DetectedProjectConfig } from '../../../shared/types/projectConfig';
import type { RunpanePaneFocusRequestedEvent } from '../../../shared/types/runpaneOrchestration';
import type { UpdateCapabilities } from '../../../shared/types/updater';
import type {
  ProjectDashboardData,
  ProjectDashboardSessionUpdateEvent,
  ProjectDashboardUpdateEvent,
} from './projectDashboard';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

interface RendererDiagnosticPayload {
  kind: 'unhandledrejection' | 'error' | 'error-boundary';
  message: string;
  stack?: string;
  componentStack?: string;
  url?: string;
  line?: number;
  column?: number;
}

// oxlint-disable-next-line typescript/no-explicit-any -- Generic type parameter default for flexible API responses
interface IPCResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  details?: string;
  command?: string;
  code?: string;
}

interface ElectronAPI {
  // Generic invoke method. Daemon-owned channels route through the main-process
  // daemon bridge while adapter-only channels stay on direct Electron IPC.
  invoke: {
    (channel: 'panels:get-layout', sessionId: string): Promise<IPCResponse<SessionPanelLayout | null>>;
    (channel: 'panels:set-layout', sessionId: string, layout: SessionPanelLayout | null): Promise<IPCResponse<void>>;
    (channel: 'panels:emitEvent', panelId: string, eventType: PanelEventType, data: JsonValue): Promise<void>;
    (channel: 'panels:clearUnviewedContent', panelId: string): Promise<IPCResponse<void>>;
    // oxlint-disable-next-line typescript/no-explicit-any -- Generic IPC bridge fallback for channels without dedicated overloads
    (channel: string, ...args: unknown[]): Promise<any>;
  };
  
  // Basic app info
  getAppVersion: () => Promise<string>;
  getPlatform: () => Promise<string>;
  isPackaged: () => Promise<boolean>;

  // Window Controls Overlay (Windows/Linux). `windowControlsOverlayEnabled` is a
  // plain boolean, not a promise: it is resolved in the preload from argv so the
  // first render already knows whether the page owns the title bar.
  windowControlsOverlayEnabled: boolean;
  appearanceSnapshot?: import('../../../shared/types/appearance').AppearanceSnapshot;
  setTitleBarOverlay: (colors: { color: string; symbolColor: string }) => Promise<IPCResponse>;
  setBackgroundColor: (payload: { theme: import('../../../shared/types/appearance').Theme; color: string }) => Promise<IPCResponse>;

  // Version checking
  checkForUpdates: () => Promise<IPCResponse<VersionInfo>>;
  getVersionInfo: () => Promise<IPCResponse>;
  
  // Auto-updater
  updater: {
    getCapabilities: () => Promise<IPCResponse<UpdateCapabilities>>;
    checkAndDownload: () => Promise<IPCResponse>;
    downloadUpdate: () => Promise<IPCResponse>;
    installUpdate: () => Promise<IPCResponse>;
    copyUpdateCommand: () => Promise<IPCResponse<{ command: string }>>;
    openTerminalWithCommand: () => Promise<IPCResponse<{ command: string }>>;
  };

  // System utilities
  openExternal: (url: string) => Promise<IPCResponse>;

  feedback: {
    submit: (request: import('../../../shared/types/feedback').SubmitFeedbackRequest) => Promise<IPCResponse<
      import('../../../shared/types/feedback').SubmitFeedbackSuccess | import('../../../shared/types/feedback').SubmitFeedbackFailure
    >>;
  };

  diagnostics: {
    rendererFatal: (payload: RendererDiagnosticPayload) => Promise<IPCResponse>;
  };

  paneChat: {
    getOrCreate: () => Promise<IPCResponse<PaneChatState<Session>>>;
    setAgent: (agent: PaneChatAgent) => Promise<IPCResponse<PaneChatState<Session>>>;
  };

  orchestrationSessions: {
    list: () => Promise<IPCResponse<OrchestrationSessionListResult>>;
    select: (selector: OrchestrationSessionSelector) => Promise<IPCResponse<OrchestrationSessionListResult>>;
    create: (input: OrchestrationSessionCreateInput) => Promise<IPCResponse<OrchestrationSessionView<Session>>>;
    get: (selector: OrchestrationSessionSelector) => Promise<IPCResponse<OrchestrationSessionView<Session>>>;
    update: (selector: OrchestrationSessionSelector, input: OrchestrationSessionUpdateInput) => Promise<IPCResponse<OrchestrationSessionRecord>>;
    setAgent: (selector: OrchestrationSessionSelector, agent: PaneChatAgent) => Promise<IPCResponse<OrchestrationSessionView<Session>>>;
    associate: (selector: OrchestrationSessionSelector, association: OrchestrationAssociationInput) => Promise<IPCResponse<OrchestrationSessionRecord>>;
    detach: (selector: OrchestrationSessionSelector, paneId?: string) => Promise<IPCResponse<OrchestrationSessionRecord>>;
    overview: (selector: OrchestrationSessionSelector) => Promise<IPCResponse<OrchestrationSessionOverview>>;
  };

  // Token usage, cost and rate-limit reporting
  usage: {
    getReport: (request?: UsageReportRequest) => Promise<IPCResponse<UsageReport>>;
    getStatus: () => Promise<IPCResponse<UsageIndexStatus>>;
    rescan: () => Promise<IPCResponse<UsageIndexStatus>>;
  };

  // Leaderboard opt-in and submission
  leaderboard: {
    getStatus: () => Promise<IPCResponse<LeaderboardStatus>>;
    join: () => Promise<IPCResponse<LeaderboardSubmitResult>>;
    leave: () => Promise<IPCResponse>;
    sendNow: () => Promise<IPCResponse<LeaderboardSubmitResult>>;
    fetch: () => Promise<IPCResponse<LeaderboardResponse>>;
  };

  // Image export (save-to-file / OS share sheet)
  export: {
    saveImage: (data: string, defaultFilename: string) => Promise<IPCResponse<{ filePath: string } | null>>;
    shareImage: (data: string, filename: string) => Promise<IPCResponse<{ method: 'share' | 'clipboard' }>>;
  };

  // Session management
  sessions: {
    getAll: () => Promise<IPCResponse>;
    getAllWithProjects: () => Promise<IPCResponse>;
    getArchivedWithProjects: () => Promise<IPCResponse>;
    restore: (sessionId: string) => Promise<IPCResponse>;
    get: (sessionId: string) => Promise<IPCResponse>;
    create: (request: CreateSessionRequest) => Promise<IPCResponse>;
    delete: (sessionId: string) => Promise<IPCResponse>;
    permanentDelete: (sessionId: string) => Promise<IPCResponse>;
    permanentDeleteArchived: () => Promise<IPCResponse<{ deletedCount: number }>>;
    sendInput: (sessionId: string, input: string) => Promise<IPCResponse>;
    continue: (sessionId: string, prompt?: string, model?: string) => Promise<IPCResponse>;
    getOutput: (sessionId: string, limit?: number) => Promise<IPCResponse>;
    getJsonMessages: (sessionId: string) => Promise<IPCResponse>;
    getStatistics: (sessionId: string) => Promise<IPCResponse>;
    getConversation: (sessionId: string) => Promise<IPCResponse>;
    getConversationMessages: (sessionId: string) => Promise<IPCResponse>;
    getConversationMessageCount: (sessionId: string) => Promise<IPCResponse<number>>;
    generateCompactedContext: (sessionId: string) => Promise<IPCResponse>;
    markViewed: (sessionId: string) => Promise<IPCResponse>;
    stop: (sessionId: string) => Promise<IPCResponse>;
    
    // Execution and Git operations
    getExecutions: (sessionId: string) => Promise<IPCResponse>;
    getExecutionDiff: (sessionId: string, executionId: string) => Promise<IPCResponse>;
    gitCommit: (sessionId: string, message: string) => Promise<IPCResponse>;
    gitDiff: (sessionId: string) => Promise<IPCResponse>;
    getDiffManifest: (sessionId: string, scope: DiffScope) => Promise<IPCResponse<DiffManifest>>;
    getFileDiff: (sessionId: string, scope: DiffScope, request: FileDiffRequest) => Promise<IPCResponse<FileDiffResult>>;

    // Script operations
    hasRunScript: (sessionId: string) => Promise<IPCResponse>;
    getRunningSession: () => Promise<IPCResponse>;
    runScript: (sessionId: string) => Promise<IPCResponse>;
    stopScript: (sessionId?: string) => Promise<IPCResponse>;
    runTerminalCommand: (sessionId: string, command: string) => Promise<IPCResponse>;
    sendTerminalInput: (sessionId: string, data: string) => Promise<IPCResponse>;
    preCreateTerminal: (sessionId: string) => Promise<IPCResponse>;
    resizeTerminal: (sessionId: string, cols: number, rows: number) => Promise<IPCResponse>;
    
    // Prompt operations
    getPrompts: (sessionId: string) => Promise<IPCResponse>;
    
    // Git merge operations
    mergeMainToWorktree: (sessionId: string) => Promise<IPCResponse>;
    mergeWorktreeToMain: (sessionId: string) => Promise<IPCResponse>;
    
    // Git rebase operations
    rebaseMainIntoWorktree: (sessionId: string) => Promise<IPCResponse>;
    abortRebaseAndUseClaude: (sessionId: string) => Promise<IPCResponse>;
    squashAndRebaseToMain: (sessionId: string, commitMessage: string) => Promise<IPCResponse>;
    rebaseToMain: (sessionId: string) => Promise<IPCResponse>;
    hasChangesToRebase: (sessionId: string) => Promise<IPCResponse>;
    getGitCommands: (sessionId: string) => Promise<IPCResponse>;
    generateName: (prompt: string) => Promise<IPCResponse>;
    rename: (sessionId: string, newName: string) => Promise<IPCResponse>;
    toggleFavorite: (sessionId: string) => Promise<IPCResponse>;

    // Main repo session
    getOrCreateMainRepoSession: (projectId: number) => Promise<IPCResponse>;

    // Git pull/push operations
    gitPull: (sessionId: string) => Promise<IPCResponse>;
    gitPush: (sessionId: string) => Promise<IPCResponse>;
    gitFetch: (sessionId: string) => Promise<IPCResponse>;
    gitStash: (sessionId: string, message?: string) => Promise<IPCResponse>;
    gitStashPop: (sessionId: string) => Promise<IPCResponse>;
    gitSoftReset: (sessionId: string) => Promise<IPCResponse>;
    gitStageAndCommit: (sessionId: string, message: string) => Promise<IPCResponse>;
    hasStash: (sessionId: string) => Promise<IPCResponse>;
    setUpstream: (sessionId: string, remoteBranch: string) => Promise<IPCResponse>;
    getUpstream: (sessionId: string) => Promise<IPCResponse>;
    getRemoteBranches: (sessionId: string) => Promise<IPCResponse>;
    getGitStatus: (sessionId: string, nonBlocking?: boolean, isInitialLoad?: boolean) => Promise<IPCResponse>;
    getLastCommits: (sessionId: string, count: number) => Promise<IPCResponse>;
    getGitGraph: (sessionId: string) => Promise<IPCResponse>;

    // IDE operations
    openIDE: (sessionId: string, ideKey?: string) => Promise<IPCResponse>;
    
    // Reorder operations
    reorder: (sessionOrders: Array<{ id: string; displayOrder: number }>) => Promise<IPCResponse>;
    
    // Image operations
    saveImages: (sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>) => Promise<string[]>;
    
    // Log operations
    getLogs: (sessionId: string) => Promise<IPCResponse>;
    clearLogs: (sessionId: string) => Promise<IPCResponse>;
    
    // Large text operations
    saveLargeText: (sessionId: string, text: string) => Promise<string>;

    // Resume session operations
    getResumable: () => Promise<IPCResponse<ResumableSession[]>>;
    resumeInterrupted: (sessionIds: string[]) => Promise<IPCResponse>;
    dismissInterrupted: (sessionIds: string[]) => Promise<IPCResponse>;
  };

  // Project management
  projects: {
    getAll: () => Promise<IPCResponse>;
    getActive: () => Promise<IPCResponse>;
    create: (projectData: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => Promise<IPCResponse>;
    activate: (projectId: string) => Promise<IPCResponse>;
    update: (projectId: string, updates: Partial<Project>) => Promise<IPCResponse>;
    delete: (projectId: string) => Promise<IPCResponse>;
    detectBranch: (path: string) => Promise<IPCResponse<string>>;
    reorder: (projectOrders: Array<{ id: number; displayOrder: number }>) => Promise<IPCResponse>;
    listBranches: (projectId: string) => Promise<IPCResponse>;
    refreshGitStatus: (projectId: number) => Promise<IPCResponse>;
    runScript: (projectId: number) => Promise<IPCResponse>;
    getRunningScript: () => Promise<IPCResponse>;
    stopScript: (projectId?: number) => Promise<IPCResponse>;
    /** Detect pane.json / conductor.json / .gitpod.yml / devcontainer.json at project root. Used by ProjectSettings for "From X" badges. */
    detectConfig: (projectId: string) => Promise<IPCResponse<DetectedProjectConfig | null>>;
    /** Resolve which run script to execute for a session (DB > config files > scripts/pane-run-script.js). Used by PanelTabBar Play button. */
    resolveRunScript: (sessionId: string) => Promise<IPCResponse<{ command: string; source: string } | null>>;
  };

  // Git operations
  git: {
    detectBranch: (path: string) => Promise<IPCResponse<string>>;
    cancelStatusForProject: (projectId: number) => Promise<{ success: boolean; error?: string }>;
    executeProject: (projectId: number, args: string[]) => Promise<IPCResponse>;
    cloneRepo: (url: string, destDir: string) => Promise<IPCResponse<{ clonedPath: string; repoName: string }>>;
  };

  // Folders
  folders: {
    getByProject: (projectId: number) => Promise<IPCResponse>;
    create: (name: string, projectId: number, parentFolderId?: string | null) => Promise<IPCResponse>;
    update: (folderId: string, updates: { name?: string; display_order?: number; parent_folder_id?: string | null }) => Promise<IPCResponse>;
    delete: (folderId: string) => Promise<IPCResponse>;
    reorder: (projectId: number, folderOrders: Array<{ id: string; displayOrder: number }>) => Promise<IPCResponse>;
    moveSession: (sessionId: string, folderId: string | null) => Promise<IPCResponse>;
    move: (folderId: string, parentFolderId: string | null) => Promise<IPCResponse>;
  };

  // Configuration
  config: {
    get: () => Promise<IPCResponse<AppConfig>>;
    update: (updates: UpdateConfigRequest) => Promise<IPCResponse<AppConfig>>;
    getSessionPreferences: () => Promise<IPCResponse>;
    updateSessionPreferences: (preferences: SessionCreationPreferences) => Promise<IPCResponse>;
    getAvailableShells: () => Promise<IPCResponse>;
    getMonospaceFonts: () => Promise<IPCResponse>;
  };

  remoteDaemon: {
    getConfig: () => Promise<IPCResponse<RemoteDaemonConfig>>;
    getConnectionState: () => Promise<IPCResponse<RemotePaneConnectionState>>;
    getHostState: () => Promise<IPCResponse<RemoteDaemonHostRuntimeState>>;
    setupHost: (input: RemoteHostSetupRequest) => Promise<IPCResponse<RemoteHostSetupResult>>;
    getInteractiveSetupCommand: (input: RemoteHostSetupRequest) => Promise<IPCResponse<RemoteHostSetupTerminalCommandResult>>;
    getInteractiveClientSetupCommand: () => Promise<IPCResponse<RemoteHostSetupTerminalCommandResult>>;
    createConnectionPair: (input: { label: string; baseUrl: string }) => Promise<IPCResponse<RemoteDaemonConnectionPair>>;
    createHostConnectionCode: (input?: { label?: string }) => Promise<IPCResponse<RemoteHostConnectionCodeResult>>;
    updateHostConfig: (updates: Partial<RemoteDaemonHostConfig>) => Promise<IPCResponse<RemoteDaemonHostConfig>>;
    clearHostAccess: () => Promise<IPCResponse<RemoteDaemonConfig['host']>>;
    disconnectHostClients: (clientIds?: string[]) => Promise<IPCResponse<{ disconnectedCount: number }>>;
    upsertClientRecord: (record: RemoteDaemonClientRecord) => Promise<IPCResponse<RemoteDaemonClientRecord[]>>;
    deleteClientRecord: (clientId: string) => Promise<IPCResponse<RemoteDaemonClientRecord[]>>;
    upsertConnectionProfile: (profile: RemotePaneConnectionProfile) => Promise<IPCResponse<RemotePaneConnectionProfile[]>>;
    importConnectionCode: (code: string, options?: { connect?: boolean }) => Promise<IPCResponse<RemoteDaemonImportResult>>;
    deleteConnectionProfile: (profileId: string) => Promise<IPCResponse<RemoteDaemonClientSettings>>;
    updateClientState: (updates: Partial<Pick<RemoteDaemonClientSettings, 'activeProfileId' | 'mode'>>) => Promise<IPCResponse<RemoteDaemonClientSettings>>;
    onConnectionStateChanged: (callback: (state: RemotePaneConnectionState) => void) => () => void;
    onHostStateChanged: (callback: (state: RemoteDaemonHostRuntimeState) => void) => () => void;
  };

  // Prompts
  prompts: {
    getAll: () => Promise<IPCResponse>;
    getByPromptId: (promptId: string) => Promise<IPCResponse>;
  };

  // File operations
  file: {
    listProject: (projectId: number, path?: string) => Promise<IPCResponse>;
    readProject: (projectId: number, filePath: string) => Promise<IPCResponse>;
    writeProject: (projectId: number, filePath: string, content: string) => Promise<IPCResponse>;
  };

  // Dialog
  dialog: {
    openFile: (options?: Electron.OpenDialogOptions) => Promise<IPCResponse<string | null>>;
    openDirectory: (options?: Electron.OpenDialogOptions) => Promise<IPCResponse<string | null>>;
  };

  // Permissions
  permissions: {
    respond: (requestId: string, response: PanePermissionResponse) => Promise<IPCResponse>;
    getPending: () => Promise<IPCResponse<PanePermissionRequest[]>>;
  };

  // Dashboard
  dashboard: {
    getProjectStatus: (projectId: number) => Promise<IPCResponse<ProjectDashboardData>>;
    getProjectStatusProgressive: (projectId: number) => Promise<IPCResponse<ProjectDashboardData>>;
    onUpdate: (callback: (data: ProjectDashboardUpdateEvent) => void) => () => void;
    onSessionUpdate: (callback: (data: ProjectDashboardSessionUpdateEvent) => void) => () => void;
  };

  // UI State management
  uiState: {
    getExpanded: () => Promise<IPCResponse<{
      expandedProjects: number[];
      expandedFolders: string[];
      sessionSortAscending: boolean;
      pinnedSectionExpanded: boolean;
      repositoriesSectionExpanded: boolean;
    }>>;
    saveExpanded: (projectIds: number[], folderIds: string[]) => Promise<IPCResponse>;
    saveExpandedProjects: (projectIds: number[]) => Promise<IPCResponse>;
    saveExpandedFolders: (folderIds: string[]) => Promise<IPCResponse>;
    saveSessionSortAscending: (ascending: boolean) => Promise<IPCResponse>;
    saveSidebarSectionExpanded: (section: 'pinned' | 'repositories', expanded: boolean) => Promise<IPCResponse>;
  };

  // Event listeners for real-time updates
  events: {
    onPermissionRequest: (callback: (request: PanePermissionRequest) => void) => () => void;
    onPermissionResolved: (callback: (event: PanePermissionResolvedEvent) => void) => () => void;
    onSessionCreationFailed: (callback: (failure: { name: string; error: string }) => void) => () => void;
    onSessionCreated: (callback: (session: Session) => void) => () => void;
    onSessionUpdated: (callback: (session: Session) => void) => () => void;
    onPaneFocusRequested: (callback: (data: RunpanePaneFocusRequestedEvent) => void) => () => void;
    onSessionDeleted: (callback: (session: Pick<Session, 'id'>) => void) => () => void;
    onSessionsLoaded: (callback: (sessions: Session[]) => void) => () => void;
    onSessionOutput: (callback: (output: SessionOutput) => void) => () => void;
    onSessionLog: (callback: (data: { sessionId: string; entry: LogEntry }) => void) => () => void;
    onSessionLogsCleared: (callback: (data: { sessionId: string }) => void) => () => void;
    onSessionOutputAvailable: (callback: (info: { sessionId: string; hasNewOutput: boolean }) => void) => () => void;
    onOrchestrationSessionsChanged?: (callback: (change: { sessionId: string; kind: string; selectionChanged?: boolean }) => void) => () => void;
    onOrchestrationSessionsOverviewUpdated?: (callback: (change: { panelId: string; sessionId?: string; state: string }) => void) => () => void;
    onGitStatusUpdated: (callback: (data: { sessionId: string; gitStatus: GitStatus }) => void) => () => void;
    onGitStatusLoading: (callback: (data: { sessionId: string }) => void) => () => void;
    onGitStatusLoadingBatch?: (callback: (sessionIds: string[]) => void) => () => void;
    onGitStatusUpdatedBatch?: (callback: (updates: Array<{ sessionId: string; status: GitStatus }>) => void) => () => void;
    
    // Project events
    onProjectUpdated: (callback: (project: Project) => void) => () => void;
    
    // Folder events
    onFolderCreated: (callback: (folder: Folder) => void) => () => void;
    onFolderUpdated: (callback: (folder: Folder) => void) => () => void;
    onFolderDeleted: (callback: (folderId: string) => void) => () => void;
    
    // Panel events
    onPanelCreated: (callback: (panel: ToolPanel) => void) => () => void;
    onPanelUpdated: (callback: (panel: ToolPanel) => void) => () => void;
    onPanelDeleted: (callback: (data: { panelId: string; sessionId: string }) => void) => () => void;
    onPanelActivityStatus: (callback: (data: { panelId: string; sessionId: string; status: 'active' | 'idle'; lastActivityAt?: string }) => void) => () => void;
    onPanelAgentStatus: (callback: (data: PanelAgentStatusEvent) => void) => () => void;
    onPanelPromptAdded: (callback: (data: { panelId: string; content: string }) => void) => () => void;
    onPanelResponseAdded: (callback: (data: { panelId: string; content: string }) => void) => () => void;
    
    onTerminalOutput: (callback: (output: import('../../../shared/types/panels').TerminalOutputEvent) => void) => () => void;
    onTerminalCliReady: (callback: (data: { panelId: string }) => void) => () => void;
    onTerminalExited: (callback: (data: { sessionId: string; panelId: string; exitCode: number; signal: number | null }) => void) => () => void;
    onTerminalAlternateScreen: (callback: (data: { panelId: string; active: boolean }) => void) => () => void;
    /**
     * Fired when a terminal panel is spawned via the ptyHost UtilityProcess.
     * Carries the host-allocated `ptyId` so TerminalPanel.tsx can ack
     * flow-control bytes over `electronAPI.ptyHost.ack` when `usePtyHost` is on.
     * Re-fires on auto-reattach after a supervisor restart with a new ptyId.
     */
    onTerminalPtyReady: (callback: (data: { sessionId: string; panelId: string; ptyId: string }) => void) => () => void;
    onUncleanShutdownDetected: (callback: () => void) => () => void;
    onMainLog: (callback: (level: string, message: string) => void) => () => void;
    onVersionUpdateAvailable: (callback: (versionInfo: VersionUpdateInfo) => void) => () => void;
    
    // Auto-updater events
    onUpdaterCheckingForUpdate: (callback: () => void) => () => void;
    onUpdaterUpdateAvailable: (callback: (info: { version: string; releaseDate: string; releaseName?: string; releaseNotes?: string }) => void) => () => void;
    onUpdaterUpdateNotAvailable: (callback: (info: { version: string }) => void) => () => void;
    onUpdaterDownloadProgress: (callback: (progressInfo: { bytesPerSecond: number; percent: number; transferred: number; total: number }) => void) => () => void;
    onUpdaterUpdateDownloaded: (callback: (info: { version: string; files: string[]; path: string; sha512: string; releaseDate: string }) => void) => () => void;
    onUpdaterError: (callback: (error: Error) => void) => () => void;
    
    // Process management events
    onZombieProcessesDetected: (callback: (data: { sessionId?: string | null; pids?: number[]; message: string }) => void) => () => void;

    // Window focus state from BrowserWindow (more reliable than document.hasFocus())
    onWindowFocusChanged: (callback: (focused: boolean) => void) => () => void;
    onRemoteDaemonResyncRequested: (callback: () => void) => () => void;

    // Spotlight events
    onSpotlightStatusChanged?: (callback: (data: { sessionId: string; projectId: number; active: boolean }) => void) => () => void;
    onSpotlightSyncError?: (callback: (data: { sessionId: string; projectId: number; error: string }) => void) => () => void;
    onSpotlightTamperDetected?: (callback: (data: { sessionId: string; projectId: number; message: string }) => void) => () => void;

    // Terminal font config events
    onTerminalFontUpdated: (callback: (data: { terminalFontFamily: string; terminalFontSize: number }) => void) => () => void;
    onNativeAppearanceUpdated: (callback: (data: { prefersDark: boolean }) => void) => () => void;

    removeAllListeners: (channel: string) => void;
  };

  // Panel operations
  panels: {
    getSessionPanels: (sessionId: string) => Promise<IPCResponse<ToolPanel[]>>;
    createPanel: (sessionId: string, type: string, name: string, config?: CreatePanelRequest['initialState']) => Promise<IPCResponse<ToolPanel>>;
    deletePanel: (panelId: string) => Promise<IPCResponse>;
    renamePanel: (panelId: string, name: string) => Promise<IPCResponse>;
    setActivePanel: (sessionId: string, panelId: string) => Promise<IPCResponse>;
    sendInput: (panelId: string, input: string, images?: Array<{ name: string; dataUrl: string; type: string }>) => Promise<IPCResponse>;
    getOutput: (panelId: string, limit?: number) => Promise<IPCResponse>;
    getConversationMessages: (panelId: string) => Promise<IPCResponse>;
    getJsonMessages: (panelId: string) => Promise<IPCResponse>;
    getPrompts: (panelId: string) => Promise<IPCResponse>;
    continue: (panelId: string, input: string, model?: string) => Promise<IPCResponse>;
    stop: (panelId: string) => Promise<IPCResponse>;
    resizeTerminal: (panelId: string, cols: number, rows: number) => Promise<IPCResponse>;
    sendTerminalInput: (panelId: string, data: string) => Promise<IPCResponse>;
  };

  // Logs panel operations
  logs: {
    runScript: (sessionId: string, command: string, cwd: string) => Promise<IPCResponse>;
    stopScript: (panelId: string) => Promise<IPCResponse>;
    isRunning: (sessionId: string) => Promise<IPCResponse>;
  };

  // Debug utilities
  debug: {
    getTableStructure: (tableName: 'folders' | 'sessions') => Promise<IPCResponse<{
      columns: Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | number | boolean | null;
        pk: number;
      }>;
      foreignKeys: Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>;
      indexes: Array<{
        name: string;
        tbl_name: string;
        sql: string;
      }>;
    }>>;
  };

  // Analytics tracking
  analytics: {
    getIdentity: () => Promise<IPCResponse<import('./config').AnalyticsIdentity>>;
    onMainEvent: (callback: (event: { eventName: string; properties: import('../../../shared/validation/boundaryDecoder').JsonObject }) => void) => () => void;
    syncDistinctId: (distinctId: string) => void;
    redeemAttribution: () => Promise<IPCResponse<void>>;
  };

  // Onboarding
  onboarding: {
    detectEnvironment: () => Promise<IPCResponse<{ ghReady?: boolean }>>;
    getGitHubAuthCommand: () => Promise<IPCResponse<{ command: string; reason: 'login' | 'refresh' | 'install-gh' | 'ready' }>>;
    openGitHubAuthTerminal: () => Promise<IPCResponse<{
      command: string;
      reason: 'login' | 'refresh' | 'install-gh' | 'ready';
      copied: boolean;
      openedTerminal: boolean;
      platform: NodeJS.Platform;
    }>>;
    startGitHubAuthTerminal: (cols?: number, rows?: number) => Promise<IPCResponse<{
      terminalId: string;
      command: string;
      reason: 'login' | 'refresh' | 'install-gh' | 'ready';
      cols: number;
      rows: number;
    }>>;
    writeGitHubAuthTerminal: (terminalId: string, data: string) => Promise<IPCResponse>;
    resizeGitHubAuthTerminal: (terminalId: string, cols: number, rows: number) => Promise<IPCResponse>;
    killGitHubAuthTerminal: (terminalId: string) => Promise<IPCResponse>;
    onGitHubAuthTerminalOutput: (callback: (data: { terminalId: string; data: string }) => void) => () => void;
    onGitHubAuthTerminalExit: (callback: (data: { terminalId: string; exitCode: number; signal: number | null }) => void) => () => void;
    setupDefaultRepo: () => Promise<IPCResponse>;
    supportProject: () => Promise<IPCResponse>;
  };

  // Spotlight
  spotlight: {
    enable: (sessionId: string) => Promise<IPCResponse>;
    disable: (sessionId: string) => Promise<IPCResponse>;
    getStatus: (projectId: number) => Promise<IPCResponse>;
  };

  // Resource monitor
  resourceMonitor: {
    getSnapshot: () => Promise<IPCResponse>;
    startActive: () => Promise<IPCResponse>;
    stopActive: () => Promise<IPCResponse>;
  };

  // Agent subscription usage
  agentUsage: {
    get: (force?: boolean) => Promise<IPCResponse<AgentUsageSnapshot>>;
  };

  // Window state queries (invoke, not event subscriptions)
  window: {
    isFocused: () => Promise<boolean>;
  };

  // ptyHost: typed wrapper over the per-window MessagePort installed by the
  // preload script. The raw port never crosses contextBridge — these
  // functions are the only surface. Terminal bytes arrive on
  // `events.onTerminalOutput`, not here.
  ptyHost: {
    /** Subscribe to PTY exit for a given ptyId. Returns unsubscribe. */
    onExit: (
      ptyId: string,
      cb: (exitCode: number | null, signal: number | null) => void,
    ) => () => void;
    /** Ack `bytes` bytes back over the port for flow-control bookkeeping. */
    ack: (ptyId: string, bytes: number) => void;
    /** Write `data` over the port without round-tripping through IPC invoke. */
    write: (ptyId: string, data: string) => void;
  };
}

// Additional electron interface for IPC event listeners
interface ElectronInterface {
  openExternal: (url: string) => Promise<IPCResponse>;
  // Generic invoke method. Daemon-owned channels route through the main-process
  // daemon bridge while adapter-only channels stay on direct Electron IPC.
  // oxlint-disable-next-line typescript/no-explicit-any -- Generic IPC bridge that returns different types based on channel
  invoke: (channel: string, ...args: unknown[]) => Promise<any>;
  // oxlint-disable-next-line typescript/no-explicit-any -- Generic IPC event callback that receives different argument types
  on: (channel: string, callback: (...args: any[]) => void) => void;
  // oxlint-disable-next-line typescript/no-explicit-any -- Generic IPC event callback that receives different argument types
  off: (channel: string, callback: (...args: any[]) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    electron?: ElectronInterface;
  }
}

export {};
