import { contextBridge, ipcRenderer } from 'electron';
import { isDaemonOwnedChannel } from '../../shared/types/daemon';
import {
  WINDOW_CONTROLS_OVERLAY_ARG,
  type WindowControlsOverlayColors,
} from './utils/windowControlsOverlay';
import type { CreateSessionRequest, Session } from './types/session';
import type { AppConfig, UpdateConfigRequest } from './types/config';
import type { CreateProjectRequest, UpdateProjectRequest, Project } from '../../frontend/src/types/project';
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
} from '../../shared/types/remoteDaemon';
import type { ToolPanel } from '../../shared/types/panels';
import type { DiffScope, FileDiffRequest } from '../../shared/types/gitDiff';
import type { PanelAgentStatusEvent } from '../../shared/types/agentStatus';
import type {
  OrchestrationAssociationInput,
  OrchestrationSessionCreateInput,
  OrchestrationSessionSelector,
  OrchestrationSessionUpdateInput,
} from '../../shared/types/orchestrationSession';
import type { AgentUsageSnapshot } from '../../shared/types/agentUsage';
import type { ResourceSnapshot } from '../../shared/types/resourceMonitor';
import type { SubmitFeedbackRequest } from '../../shared/types/feedback';
import type { RunpanePaneFocusRequestedEvent } from '../../shared/types/runpaneOrchestration';
import type {
  PanePermissionRequest as PermissionRequest,
  PanePermissionResponse as PermissionResponse,
  PanePermissionResolvedEvent as PermissionResolvedEvent,
} from '../../shared/types/permissions';
// The main build bundles this runtime dependency into preload.js; the sandbox
// verification step rejects any remaining require other than Electron itself.
import { boundary, decodeBoundary, type JsonObject } from '../../shared/validation/boundaryDecoder';
import { decodeAppearanceSnapshotArg, type Theme } from '../../shared/types/appearance';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

// Buffer analytics events that arrive before the renderer registers its callback.
// This prevents race conditions where main-process events (e.g. app_opened) are
// sent before the React useEffect listener is attached.
type AnalyticsEvent = { eventName: string; properties: JsonObject };
const analyticsEventBuffer: AnalyticsEvent[] = [];
let analyticsForwardCallback: ((event: AnalyticsEvent) => void) | null = null;

ipcRenderer.on('analytics:main-event', (_event: Electron.IpcRendererEvent, data: AnalyticsEvent) => {
  if (analyticsForwardCallback) {
    analyticsForwardCallback(data);
  } else {
    analyticsEventBuffer.push(data);
  }
});

interface DialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: string[];
}

interface DashboardUpdateData {
  type: 'status' | 'session' | 'project';
  projectId?: number;
  sessionId?: string;
  data: unknown;
}

interface GitStatusUpdateData {
  sessionId: string;
  gitStatus: {
    state: string;
    ahead?: number;
    behind?: number;
    additions?: number;
    deletions?: number;
    filesChanged?: number;
  };
}

interface SessionOutputData {
  sessionId: string;
  type: 'stdout' | 'stderr' | 'json' | 'error';
  data: unknown;
  timestamp: string;
  panelId?: string;
}

type TerminalOutputEvent = import('../../shared/types/panels').TerminalOutputEvent;

interface Folder {
  id: string;
  name: string;
  project_id: number;
  parent_folder_id?: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  releaseNotes?: string;
}

interface UpdaterInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
  path?: string;
  sha512?: string;
  size?: number;
}

// Increase max listeners for ipcRenderer to prevent warnings when many components listen to events
ipcRenderer.setMaxListeners(50);

// ptyHost renderer port wiring.
//
// Main posts `webContents.postMessage('ptyHost-port', null, [rendererPort])`
// after `did-finish-load`. The renderer end is a DOM-style `MessagePort` —
// use `.onmessage`, not `.on('message')`. The port CANNOT cross contextBridge
// directly, so we keep it in this preload-scoped closure and expose a typed
// function surface on `window.electronAPI.ptyHost` below.
//
// Terminal bytes do not use this port: they reach the renderer once, over the
// `terminal:output` channel, for ptyHost and legacy PTYs alike.
const ptyHostInboundSchema = boundary.object({
  type: boundary.literal('exit'),
  ptyId: boundary.string,
  exitCode: boundary.nullable(boundary.number),
  signal: boundary.nullable(boundary.number),
});

type PtyExitCallback = (exitCode: number | null, signal: number | null) => void;

let ptyHostPort: MessagePort | null = null;
const ptyExitSubscribers = new Map<string, Set<PtyExitCallback>>();

ipcRenderer.on('ptyHost-port', (event) => {
  const [port] = event.ports;
  if (!port) {
    console.error('[ptyHost] ptyHost-port IPC arrived with no port');
    return;
  }
  // Renderer-world MessagePort is DOM-style: use .start() + .onmessage.
  port.start();
  port.onmessage = (e: MessageEvent) => {
    let frame;
    try {
      frame = decodeBoundary(e.data, ptyHostInboundSchema);
    } catch {
      return;
    }
    const subs = ptyExitSubscribers.get(frame.ptyId);
    if (subs) {
      for (const cb of subs) {
        try {
          cb(frame.exitCode, frame.signal);
        } catch (err) {
          console.error('[ptyHost] exit subscriber threw', err);
        }
      }
    }
  };
  ptyHostPort = port;
});

// Bridge panel events from main process to renderer window as DOM CustomEvents
// This allows React components to listen with `window.addEventListener('panel:event', ...)`
try {
  ipcRenderer.on('panel:event', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('panel:event', { detail: data }));
    } catch (e) {
      // Do not let event dispatch failures break the app
      console.error('Failed to dispatch panel:event to window:', e);
    }
  });

  // Bridge project script events
  ipcRenderer.on('project-script-changed', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('project-script-changed', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch project-script-changed to window:', e);
    }
  });

  ipcRenderer.on('project-script-closing', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('project-script-closing', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch project-script-closing to window:', e);
    }
  });

  // Bridge session script events (for consistency)
  ipcRenderer.on('script-session-changed', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('script-session-changed', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch script-session-changed to window:', e);
    }
  });

  ipcRenderer.on('script-closing', (_event, data) => {
    try {
      window.dispatchEvent(new CustomEvent('script-closing', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch script-closing to window:', e);
    }
  });

  ipcRenderer.on('resource-monitor:update', (_event: Electron.IpcRendererEvent, data: ResourceSnapshot) => {
    try {
      window.dispatchEvent(new CustomEvent('resource-monitor:update', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch resource-monitor:update to window:', e);
    }
  });

  // Bridge synthetic keydown events from main process (used for Ctrl+W interception
  // and forwarding app hotkeys from webview panels whose keyboard events don't reach
  // the renderer's window listener).
  ipcRenderer.on('synthetic-keydown', (_event: Electron.IpcRendererEvent, data: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) => {
    try {
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: data.key,
        code: data.code,
        ctrlKey: data.ctrlKey,
        metaKey: data.metaKey,
        shiftKey: data.shiftKey,
        altKey: data.altKey,
        bubbles: true,
        cancelable: true,
      }));
    } catch (e) {
      console.error('Failed to dispatch synthetic-keydown to window:', e);
    }
  });
  ipcRenderer.on('browser-panel:popup-requested', (_event: Electron.IpcRendererEvent, data: { url: string; sourceSessionId: string; sourcePanelId: string }) => {
    try {
      window.dispatchEvent(new CustomEvent('browser-panel:popup-requested', { detail: data }));
    } catch (e) {
      console.error('Failed to dispatch browser-panel:popup-requested to window:', e);
    }
  });
} catch {
  // Ignore if IPC is not available for some reason
}

// In development mode, capture console logs and send them to main process for Claude Code debugging
if (process.env.NODE_ENV !== 'production') {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug
  };

  // Override console methods to capture frontend logs
  (['log', 'warn', 'error', 'info', 'debug'] as const).forEach(level => {
    console[level] = (...args: Parameters<typeof console.log>) => {
      // Call original console first so they still appear in DevTools
      originalConsole[level](...args);
      
      // Send to main process for file logging
      try {
        invokeIpc('console:log', {
          level,
          args: args.map(arg => serializeConsoleArg(arg)),
          timestamp: new Date().toISOString(),
          source: 'renderer'
        });
      } catch (error) {
        // Don't break if IPC fails
        originalConsole.error('Failed to send console log to main process:', error);
      }
    };
  });
}

function serializeConsoleArg(arg: Parameters<typeof console.log>[number]): string {
  try {
    return decodeBoundary(arg, boundary.string);
  } catch {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }
}

// Response type for IPC calls
interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

function invokeIpc(channel: string, ...args: unknown[]) {
  if (isDaemonOwnedChannel(channel)) {
    return ipcRenderer.invoke('daemon:invoke', channel, ...args);
  }

  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Generic invoke method for direct IPC calls
  invoke: (channel: string, ...args: unknown[]) => invokeIpc(channel, ...args),
  
  // Basic app info
  getAppVersion: () => invokeIpc('get-app-version'),
  getPlatform: () => invokeIpc('get-platform'),
  isPackaged: () => invokeIpc('is-packaged'),

  // Window Controls Overlay: whether this window handed its title bar to the
  // page. Main decides (see shouldEnableWindowControlsOverlay) and passes the
  // answer through additionalArguments, so the renderer can branch on it during
  // its first render instead of awaiting IPC and flashing the wrong layout.
  windowControlsOverlayEnabled: process.argv.includes(WINDOW_CONTROLS_OVERLAY_ARG),
  appearanceSnapshot: decodeAppearanceSnapshotArg(process.argv),
  setTitleBarOverlay: (colors: WindowControlsOverlayColors): Promise<IPCResponse> =>
    invokeIpc('window:set-title-bar-overlay', colors),
  setBackgroundColor: (payload: { theme: Theme; color: string }): Promise<IPCResponse> =>
    invokeIpc('window:set-background-color', payload),

  // Version checking
  checkForUpdates: (): Promise<IPCResponse> => invokeIpc('version:check-for-updates'),
  getVersionInfo: (): Promise<IPCResponse> => invokeIpc('version:get-info'),
  
  // Auto-updater
  updater: {
    getCapabilities: (): Promise<IPCResponse> => invokeIpc('updater:get-capabilities'),
    checkAndDownload: (): Promise<IPCResponse> => invokeIpc('updater:check-and-download'),
    downloadUpdate: (): Promise<IPCResponse> => invokeIpc('updater:download-update'),
    installUpdate: (): Promise<IPCResponse> => invokeIpc('updater:install-update'),
    copyUpdateCommand: (): Promise<IPCResponse> => invokeIpc('updater:copy-update-command'),
    openTerminalWithCommand: (): Promise<IPCResponse> => invokeIpc('updater:open-terminal-with-command'),
  },

  // System utilities
  openExternal: (url: string): Promise<IPCResponse> => invokeIpc('openExternal', url),

  feedback: {
    submit: (request: SubmitFeedbackRequest): Promise<IPCResponse> => invokeIpc('feedback:submit', request),
  },

  diagnostics: {
    rendererFatal: (payload: {
      kind: string;
      message: string;
      stack?: string;
      componentStack?: string;
      url?: string;
      line?: number;
      column?: number;
    }): Promise<IPCResponse> => invokeIpc('diagnostics:renderer-fatal', payload),
  },

  paneChat: {
    getOrCreate: (): Promise<IPCResponse> => invokeIpc('pane-chat:get-or-create'),
    setAgent: (agent: 'claude' | 'codex' | 'cursor'): Promise<IPCResponse> => invokeIpc('pane-chat:set-agent', agent),
  },

  orchestrationSessions: {
    list: (): Promise<IPCResponse> => invokeIpc('orchestration-sessions:list'),
    select: (selector: OrchestrationSessionSelector): Promise<IPCResponse> => invokeIpc('orchestration-sessions:select', selector),
    create: (input: OrchestrationSessionCreateInput): Promise<IPCResponse> => invokeIpc('orchestration-sessions:create', input),
    get: (selector: OrchestrationSessionSelector): Promise<IPCResponse> => invokeIpc('orchestration-sessions:get', selector),
    update: (selector: OrchestrationSessionSelector, input: OrchestrationSessionUpdateInput): Promise<IPCResponse> => invokeIpc('orchestration-sessions:update', selector, input),
    setAgent: (selector: OrchestrationSessionSelector, agent: 'claude' | 'codex' | 'cursor'): Promise<IPCResponse> => invokeIpc('orchestration-sessions:set-agent', selector, agent),
    associate: (selector: OrchestrationSessionSelector, association: OrchestrationAssociationInput): Promise<IPCResponse> => invokeIpc('orchestration-sessions:associate', selector, association),
    detach: (selector: OrchestrationSessionSelector, paneId?: string): Promise<IPCResponse> => invokeIpc('orchestration-sessions:detach', selector, paneId),
    overview: (selector: OrchestrationSessionSelector): Promise<IPCResponse> => invokeIpc('orchestration-sessions:overview', selector),
  },

  // Token usage, cost and rate-limit reporting
  usage: {
    getReport: (request?: { fromMs?: number; toMs?: number; bucket?: 'hour' | 'day' }): Promise<IPCResponse> => invokeIpc('usage:get-report', request),
    getStatus: (): Promise<IPCResponse> => invokeIpc('usage:get-status'),
    rescan: (): Promise<IPCResponse> => invokeIpc('usage:rescan'),
  },

  // Leaderboard opt-in and submission
  leaderboard: {
    getStatus: (): Promise<IPCResponse> => invokeIpc('leaderboard:get-status'),
    join: (): Promise<IPCResponse> => invokeIpc('leaderboard:join'),
    leave: (): Promise<IPCResponse> => invokeIpc('leaderboard:leave'),
    sendNow: (): Promise<IPCResponse> => invokeIpc('leaderboard:send-now'),
    fetch: (): Promise<IPCResponse> => invokeIpc('leaderboard:fetch'),
  },

  // Image export (save-to-file / OS share sheet)
  export: {
    saveImage: (data: string, defaultFilename: string): Promise<IPCResponse> =>
      invokeIpc('export:save-image', data, defaultFilename),
    shareImage: (data: string, filename: string): Promise<IPCResponse> =>
      invokeIpc('export:share-image', data, filename),
  },

  // Session management
  sessions: {
    getAll: (): Promise<IPCResponse> => invokeIpc('sessions:get-all'),
    getAllWithProjects: (): Promise<IPCResponse> => invokeIpc('sessions:get-all-with-projects'),
    getArchivedWithProjects: (): Promise<IPCResponse> => invokeIpc('sessions:get-archived-with-projects'),
    restore: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:restore', sessionId),
    get: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get', sessionId),
    create: (request: CreateSessionRequest): Promise<IPCResponse> => invokeIpc('sessions:create', request),
    delete: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:delete', sessionId),
    permanentDelete: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:permanent-delete', sessionId),
    permanentDeleteArchived: (): Promise<IPCResponse> => invokeIpc('sessions:permanent-delete-archived'),
    sendInput: (sessionId: string, input: string): Promise<IPCResponse> => invokeIpc('sessions:input', sessionId, input),
    continue: (sessionId: string, prompt?: string, model?: string): Promise<IPCResponse> => invokeIpc('sessions:continue', sessionId, prompt, model),
    getOutput: (sessionId: string, limit?: number): Promise<IPCResponse> => invokeIpc('sessions:get-output', sessionId, limit),
    getJsonMessages: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-json-messages', sessionId),
    getStatistics: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-statistics', sessionId),
    getConversation: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-conversation', sessionId),
    getConversationMessages: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-conversation-messages', sessionId),
    getConversationMessageCount: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-conversation-message-count', sessionId),
    generateCompactedContext: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:generate-compacted-context', sessionId),
    markViewed: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:mark-viewed', sessionId),
    stop: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:stop', sessionId),
    
    // Execution and Git operations
    getExecutions: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-executions', sessionId),
    getExecutionDiff: (sessionId: string, executionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-execution-diff', sessionId, executionId),
    gitCommit: (sessionId: string, message: string): Promise<IPCResponse> => invokeIpc('sessions:git-commit', sessionId, message),
    gitDiff: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:git-diff', sessionId),
    getDiffManifest: (sessionId: string, scope: DiffScope): Promise<IPCResponse> => invokeIpc('sessions:get-diff-manifest', sessionId, scope),
    getFileDiff: (sessionId: string, scope: DiffScope, request: FileDiffRequest): Promise<IPCResponse> => invokeIpc('sessions:get-file-diff', sessionId, scope, request),

    // Main repo session
    getOrCreateMainRepoSession: (projectId: number): Promise<IPCResponse> => invokeIpc('sessions:get-or-create-main-repo', projectId),
    
    // Script operations
    hasRunScript: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:has-run-script', sessionId),
    runScript: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:run-script', sessionId),
    stopScript: (sessionId?: string): Promise<IPCResponse> => invokeIpc('sessions:stop-script', sessionId),
    runTerminalCommand: (sessionId: string, command: string): Promise<IPCResponse> => invokeIpc('sessions:run-terminal-command', sessionId, command),
    sendTerminalInput: (sessionId: string, data: string): Promise<IPCResponse> => invokeIpc('sessions:send-terminal-input', sessionId, data),
    preCreateTerminal: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:pre-create-terminal', sessionId),
    resizeTerminal: (sessionId: string, cols: number, rows: number): Promise<IPCResponse> => invokeIpc('sessions:resize-terminal', sessionId, cols, rows),
    
    // Prompt operations
    getPrompts: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-prompts', sessionId),
    
    // Git rebase operations
    rebaseMainIntoWorktree: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:rebase-main-into-worktree', sessionId),
    abortRebaseAndUseClaude: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:abort-rebase-and-use-claude', sessionId),
    squashAndRebaseToMain: (sessionId: string, commitMessage: string): Promise<IPCResponse> => invokeIpc('sessions:squash-and-rebase-to-main', sessionId, commitMessage),
    rebaseToMain: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:rebase-to-main', sessionId),
    
    // Git pull/push operations
    gitPull: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:git-pull', sessionId),
    gitPush: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:git-push', sessionId),
    gitFetch: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:git-fetch', sessionId),
    gitStash: (sessionId: string, message?: string): Promise<IPCResponse> => invokeIpc('sessions:git-stash', sessionId, message),
    gitStashPop: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:git-stash-pop', sessionId),
    gitSoftReset: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:git-soft-reset', sessionId),
    gitStageAndCommit: (sessionId: string, message: string): Promise<IPCResponse> => invokeIpc('sessions:git-stage-and-commit', sessionId, message),
    hasStash: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:has-stash', sessionId),
    setUpstream: (sessionId: string, remoteBranch: string): Promise<IPCResponse> => invokeIpc('sessions:set-upstream', sessionId, remoteBranch),
    getUpstream: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-upstream', sessionId),
    getRemoteBranches: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-remote-branches', sessionId),
    getGitStatus: (sessionId: string, nonBlocking?: boolean, isInitialLoad?: boolean): Promise<IPCResponse> => invokeIpc('sessions:get-git-status', sessionId, nonBlocking, isInitialLoad),
    getLastCommits: (sessionId: string, count: number): Promise<IPCResponse> => invokeIpc('sessions:get-last-commits', sessionId, count),
    getGitGraph: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-git-graph', sessionId),

    // Git operation helpers
    hasChangesToRebase: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:has-changes-to-rebase', sessionId),
    getGitCommands: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-git-commands', sessionId),
    generateName: (prompt: string): Promise<IPCResponse> => invokeIpc('sessions:generate-name', prompt),
    rename: (sessionId: string, newName: string): Promise<IPCResponse> => invokeIpc('sessions:rename', sessionId, newName),
    toggleFavorite: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:toggle-favorite', sessionId),

    // Resume session operations
    getResumable: (): Promise<IPCResponse> => invokeIpc('sessions:get-resumable'),
    resumeInterrupted: (sessionIds: string[]): Promise<IPCResponse> => invokeIpc('sessions:resume-interrupted', sessionIds),
    dismissInterrupted: (sessionIds: string[]): Promise<IPCResponse> => invokeIpc('sessions:dismiss-interrupted', sessionIds),
    
    // IDE operations
    openIDE: (sessionId: string, ideKey?: string): Promise<IPCResponse> => invokeIpc('sessions:open-ide', sessionId, ideKey),
    
    // Reorder operations
    reorder: (sessionOrders: Array<{ id: string; displayOrder: number }>): Promise<IPCResponse> => invokeIpc('sessions:reorder', sessionOrders),
    
    // Image operations
    saveImages: (sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>): Promise<string[]> => invokeIpc('sessions:save-images', sessionId, images),
    
    // Text file operations
    saveLargeText: (sessionId: string, text: string): Promise<string> => invokeIpc('sessions:save-large-text', sessionId, text),
    
    // Log operations
    getLogs: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:get-logs', sessionId),
    clearLogs: (sessionId: string): Promise<IPCResponse> => invokeIpc('sessions:clear-logs', sessionId),
    addLog: (sessionId: string, entry: LogEntry): Promise<IPCResponse> => invokeIpc('sessions:add-log', sessionId, entry),
  },

  // Project management
  projects: {
    getAll: (): Promise<IPCResponse> => invokeIpc('projects:get-all'),
    getActive: (): Promise<IPCResponse> => invokeIpc('projects:get-active'),
    create: (projectData: CreateProjectRequest): Promise<IPCResponse> => invokeIpc('projects:create', projectData),
    activate: (projectId: string): Promise<IPCResponse> => invokeIpc('projects:activate', projectId),
    update: (projectId: string, updates: UpdateProjectRequest): Promise<IPCResponse> => invokeIpc('projects:update', projectId, updates),
    delete: (projectId: string): Promise<IPCResponse> => invokeIpc('projects:delete', projectId),
    detectBranch: (path: string): Promise<IPCResponse> => invokeIpc('projects:detect-branch', path),
    reorder: (projectOrders: Array<{ id: number; displayOrder: number }>): Promise<IPCResponse> => invokeIpc('projects:reorder', projectOrders),
    listBranches: (projectId: string): Promise<IPCResponse> => invokeIpc('projects:list-branches', projectId),
    refreshGitStatus: (projectId: number): Promise<IPCResponse> => invokeIpc('projects:refresh-git-status', projectId),
    runScript: (projectId: number): Promise<IPCResponse> => invokeIpc('projects:run-script', projectId),
    getRunningScript: (): Promise<IPCResponse> => invokeIpc('projects:get-running-script'),
    stopScript: (projectId?: number): Promise<IPCResponse> => invokeIpc('projects:stop-script', projectId),
    /**
     * Detects the project's config file (pane.json, conductor.json, .gitpod.yml, or
     * devcontainer.json) and returns a `DetectedProjectConfig` with `setup`, `run`,
     * and `archive` script strings plus a `source` label (e.g. "pane.json").
     * Used by ProjectSettings to show "From <source>" badges on script fields.
     * Reads from the project's main working directory, not a session worktree.
     */
    detectConfig: (projectId: string): Promise<IPCResponse> => invokeIpc('projects:detect-config', projectId),
    /**
     * Resolves which run script should execute for a specific session.
     * Checks (in order): DB `project.run_script`, then config-file detection from the
     * session's worktree path (so branch-local pane.json changes are honoured), then
     * a `scripts/pane-run-script.js` file in the worktree.
     * Returns `{ command, source }` or null if nothing is configured.
     * Used by `PanelTabBar` to start/stop the dev server for a session.
     */
    resolveRunScript: (sessionId: string): Promise<IPCResponse> => invokeIpc('projects:resolve-run-script', sessionId),
  },

  // Git operations
  git: {
    detectBranch: (path: string): Promise<IPCResponse<string>> => invokeIpc('projects:detect-branch', path),
    cancelStatusForProject: (projectId: number): Promise<{ success: boolean; error?: string }> => invokeIpc('git:cancel-status-for-project', projectId),
    executeProject: (projectId: number, args: string[]): Promise<IPCResponse> => invokeIpc('git:execute-project', { projectId, args }),
    cloneRepo: (url: string, destDir: string): Promise<IPCResponse> => invokeIpc('git:clone-repo', url, destDir),
  },

  // Folders
  folders: {
    getByProject: (projectId: number): Promise<IPCResponse> => invokeIpc('folders:get-by-project', projectId),
    create: (name: string, projectId: number, parentFolderId?: string | null): Promise<IPCResponse> => invokeIpc('folders:create', name, projectId, parentFolderId),
    update: (folderId: string, updates: { name?: string; display_order?: number; parent_folder_id?: string | null }): Promise<IPCResponse> => invokeIpc('folders:update', folderId, updates),
    delete: (folderId: string): Promise<IPCResponse> => invokeIpc('folders:delete', folderId),
    reorder: (projectId: number, folderOrders: Array<{ id: string; displayOrder: number }>): Promise<IPCResponse> => invokeIpc('folders:reorder', projectId, folderOrders),
    moveSession: (sessionId: string, folderId: string | null): Promise<IPCResponse> => invokeIpc('folders:move-session', sessionId, folderId),
    move: (folderId: string, parentFolderId: string | null): Promise<IPCResponse> => invokeIpc('folders:move', folderId, parentFolderId),
  },

  // Configuration
  config: {
    get: (): Promise<IPCResponse<AppConfig>> => invokeIpc('config:get'),
    update: (updates: UpdateConfigRequest): Promise<IPCResponse> => invokeIpc('config:update', updates),
    getSessionPreferences: (): Promise<IPCResponse> => invokeIpc('config:get-session-preferences'),
    updateSessionPreferences: (preferences: AppConfig['sessionCreationPreferences']): Promise<IPCResponse> => invokeIpc('config:update-session-preferences', preferences),
    getAvailableShells: (): Promise<IPCResponse> => invokeIpc('config:get-available-shells'),
    getMonospaceFonts: (): Promise<IPCResponse> => invokeIpc('config:get-monospace-fonts'),
  },

  remoteDaemon: {
    getConfig: (): Promise<IPCResponse<RemoteDaemonConfig>> => invokeIpc('remote-daemon:get-config'),
    getConnectionState: (): Promise<IPCResponse<RemotePaneConnectionState>> => invokeIpc('remote-daemon:get-connection-state'),
    getHostState: (): Promise<IPCResponse<RemoteDaemonHostRuntimeState>> => invokeIpc('remote-daemon:get-host-state'),
    setupHost: (input: RemoteHostSetupRequest): Promise<IPCResponse<RemoteHostSetupResult>> =>
      invokeIpc('remote-daemon:setup-host', input),
    getInteractiveSetupCommand: (input: RemoteHostSetupRequest): Promise<IPCResponse<RemoteHostSetupTerminalCommandResult>> =>
      invokeIpc('remote-daemon:get-interactive-setup-command', input),
    getInteractiveClientSetupCommand: (): Promise<IPCResponse<RemoteHostSetupTerminalCommandResult>> =>
      invokeIpc('remote-daemon:get-interactive-client-setup-command'),
    createConnectionPair: (input: { label: string; baseUrl: string }): Promise<IPCResponse<RemoteDaemonConnectionPair>> =>
      invokeIpc('remote-daemon:create-connection-pair', input),
    createHostConnectionCode: (input?: { label?: string }): Promise<IPCResponse<RemoteHostConnectionCodeResult>> =>
      invokeIpc('remote-daemon:create-host-connection-code', input),
    updateHostConfig: (updates: Partial<RemoteDaemonHostConfig>): Promise<IPCResponse<RemoteDaemonHostConfig>> =>
      invokeIpc('remote-daemon:update-host-config', updates),
    clearHostAccess: (): Promise<IPCResponse<RemoteDaemonConfig['host']>> =>
      invokeIpc('remote-daemon:clear-host-access'),
    disconnectHostClients: (clientIds?: string[]): Promise<IPCResponse<{ disconnectedCount: number }>> =>
      invokeIpc('remote-daemon:disconnect-host-clients', clientIds),
    upsertClientRecord: (record: RemoteDaemonClientRecord): Promise<IPCResponse<RemoteDaemonClientRecord[]>> =>
      invokeIpc('remote-daemon:upsert-client-record', record),
    deleteClientRecord: (clientId: string): Promise<IPCResponse<RemoteDaemonClientRecord[]>> =>
      invokeIpc('remote-daemon:delete-client-record', clientId),
    upsertConnectionProfile: (profile: RemotePaneConnectionProfile): Promise<IPCResponse<RemotePaneConnectionProfile[]>> =>
      invokeIpc('remote-daemon:upsert-connection-profile', profile),
    importConnectionCode: (code: string, options?: { connect?: boolean }): Promise<IPCResponse<RemoteDaemonImportResult>> =>
      invokeIpc('remote-daemon:import-connection-code', {
        code,
        connect: options?.connect,
      }),
    deleteConnectionProfile: (profileId: string): Promise<IPCResponse<RemoteDaemonClientSettings>> =>
      invokeIpc('remote-daemon:delete-connection-profile', profileId),
    updateClientState: (updates: Partial<Pick<RemoteDaemonClientSettings, 'activeProfileId' | 'mode'>>): Promise<IPCResponse<RemoteDaemonClientSettings>> =>
      invokeIpc('remote-daemon:update-client-state', updates),
    onConnectionStateChanged: (callback: (state: RemotePaneConnectionState) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, state: RemotePaneConnectionState) => callback(state);
      ipcRenderer.on('remote-daemon:connection-state-changed', wrappedCallback);
      return () => ipcRenderer.removeListener('remote-daemon:connection-state-changed', wrappedCallback);
    },
    onHostStateChanged: (callback: (state: RemoteDaemonHostRuntimeState) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, state: RemoteDaemonHostRuntimeState) => callback(state);
      ipcRenderer.on('remote-daemon:host-state-changed', wrappedCallback);
      return () => ipcRenderer.removeListener('remote-daemon:host-state-changed', wrappedCallback);
    },
  },

  // Prompts
  prompts: {
    getAll: (): Promise<IPCResponse> => invokeIpc('prompts:get-all'),
    getByPromptId: (promptId: string): Promise<IPCResponse> => invokeIpc('prompts:get-by-id', promptId),
  },

  // File operations
  file: {
    listProject: (projectId: number, path?: string): Promise<IPCResponse> => invokeIpc('file:list-project', { projectId, path }),
    readProject: (projectId: number, filePath: string): Promise<IPCResponse> => invokeIpc('file:read-project', { projectId, filePath }),
    writeProject: (projectId: number, filePath: string, content: string): Promise<IPCResponse> => invokeIpc('file:write-project', { projectId, filePath, content }),
  },

  // Dialog
  dialog: {
    openFile: (options?: DialogOptions): Promise<IPCResponse<string | null>> => invokeIpc('dialog:open-file', options),
    openDirectory: (options?: DialogOptions): Promise<IPCResponse<string | null>> => invokeIpc('dialog:open-directory', options),
  },

  // Permissions
  permissions: {
    respond: (requestId: string, response: PermissionResponse): Promise<IPCResponse> => invokeIpc('permission:respond', requestId, response),
    getPending: (): Promise<IPCResponse<PermissionRequest[]>> => invokeIpc('permission:getPending'),
  },

  // Stravu OAuth integration
  stravu: {
    getConnectionStatus: (): Promise<IPCResponse> => invokeIpc('stravu:get-connection-status'),
    initiateAuth: (): Promise<IPCResponse> => invokeIpc('stravu:initiate-auth'),
    checkAuthStatus: (sessionId: string): Promise<IPCResponse> => invokeIpc('stravu:check-auth-status', sessionId),
    disconnect: (): Promise<IPCResponse> => invokeIpc('stravu:disconnect'),
    getNotebooks: (): Promise<IPCResponse> => invokeIpc('stravu:get-notebooks'),
    getNotebook: (notebookId: string): Promise<IPCResponse> => invokeIpc('stravu:get-notebook', notebookId),
    searchNotebooks: (query: string, limit?: number): Promise<IPCResponse> => invokeIpc('stravu:search-notebooks', query, limit),
  },

  // Dashboard
  dashboard: {
    getProjectStatus: (projectId: number): Promise<IPCResponse> => invokeIpc('dashboard:get-project-status', projectId),
    getProjectStatusProgressive: (projectId: number): Promise<IPCResponse> => invokeIpc('dashboard:get-project-status-progressive', projectId),
    onUpdate: (callback: (data: DashboardUpdateData) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, data: DashboardUpdateData) => callback(data);
      ipcRenderer.on('dashboard:update', subscription);
      return () => ipcRenderer.removeListener('dashboard:update', subscription);
    },
    onSessionUpdate: (callback: (data: DashboardUpdateData) => void) => {
      const subscription = (_event: Electron.IpcRendererEvent, data: DashboardUpdateData) => callback(data);
      ipcRenderer.on('dashboard:session-update', subscription);
      return () => ipcRenderer.removeListener('dashboard:session-update', subscription);
    },
  },

  // Onboarding
  onboarding: {
    detectEnvironment: (): Promise<IPCResponse> => invokeIpc('onboarding:detect-environment'),
    getGitHubAuthCommand: (): Promise<IPCResponse> => invokeIpc('onboarding:get-github-auth-command'),
    openGitHubAuthTerminal: (): Promise<IPCResponse> => invokeIpc('onboarding:open-github-auth-terminal'),
    startGitHubAuthTerminal: (cols?: number, rows?: number): Promise<IPCResponse> => invokeIpc('onboarding:start-github-auth-pty', cols, rows),
    writeGitHubAuthTerminal: (terminalId: string, data: string): Promise<IPCResponse> => invokeIpc('onboarding:write-github-auth-pty', terminalId, data),
    resizeGitHubAuthTerminal: (terminalId: string, cols: number, rows: number): Promise<IPCResponse> => invokeIpc('onboarding:resize-github-auth-pty', terminalId, cols, rows),
    killGitHubAuthTerminal: (terminalId: string): Promise<IPCResponse> => invokeIpc('onboarding:kill-github-auth-pty', terminalId),
    onGitHubAuthTerminalOutput: (callback: (data: { terminalId: string; data: string }) => void): (() => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { terminalId: string; data: string }) => callback(data);
      ipcRenderer.on('onboarding:github-auth-pty-output', wrappedCallback);
      return () => ipcRenderer.removeListener('onboarding:github-auth-pty-output', wrappedCallback);
    },
    onGitHubAuthTerminalExit: (callback: (data: { terminalId: string; exitCode: number; signal: number | null }) => void): (() => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { terminalId: string; exitCode: number; signal: number | null }) => callback(data);
      ipcRenderer.on('onboarding:github-auth-pty-exit', wrappedCallback);
      return () => ipcRenderer.removeListener('onboarding:github-auth-pty-exit', wrappedCallback);
    },
    setupDefaultRepo: (): Promise<IPCResponse> => invokeIpc('onboarding:setup-default-repo'),
    supportProject: (): Promise<IPCResponse> => invokeIpc('onboarding:support-project'),
  },

  // UI State management
  uiState: {
    getExpanded: (): Promise<IPCResponse> => invokeIpc('ui-state:get-expanded'),
    saveExpanded: (projectIds: number[], folderIds: string[]): Promise<IPCResponse> => invokeIpc('ui-state:save-expanded', projectIds, folderIds),
    saveExpandedProjects: (projectIds: number[]): Promise<IPCResponse> => invokeIpc('ui-state:save-expanded-projects', projectIds),
    saveExpandedFolders: (folderIds: string[]): Promise<IPCResponse> => invokeIpc('ui-state:save-expanded-folders', folderIds),
    saveSessionSortAscending: (ascending: boolean): Promise<IPCResponse> => invokeIpc('ui-state:save-session-sort-ascending', ascending),
    saveSidebarSectionExpanded: (section: 'pinned' | 'repositories', expanded: boolean): Promise<IPCResponse> => invokeIpc('ui-state:save-sidebar-section-expanded', section, expanded),
  },

  // Event listeners for real-time updates
  events: {
    onPermissionRequest: (callback: (request: PermissionRequest) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, request: PermissionRequest) => callback(request);
      ipcRenderer.on('permission:request', wrappedCallback);
      return () => ipcRenderer.removeListener('permission:request', wrappedCallback);
    },
    onPermissionResolved: (callback: (event: PermissionResolvedEvent) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, event: PermissionResolvedEvent) => callback(event);
      ipcRenderer.on('permission:resolved', wrappedCallback);
      return () => ipcRenderer.removeListener('permission:resolved', wrappedCallback);
    },
    // Session events
    onSessionCreationFailed: (callback: (failure: { name: string; error: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, failure: { name: string; error: string }) => callback(failure);
      ipcRenderer.on('session:creation-failed', wrappedCallback);
      return () => ipcRenderer.removeListener('session:creation-failed', wrappedCallback);
    },
    onSessionCreated: (callback: (session: Session) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on('session:created', wrappedCallback);
      return () => ipcRenderer.removeListener('session:created', wrappedCallback);
    },
    onSessionUpdated: (callback: (session: Session) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, session: Session) => callback(session);
      ipcRenderer.on('session:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('session:updated', wrappedCallback);
    },
    onPaneFocusRequested: (callback: (data: RunpanePaneFocusRequestedEvent) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: RunpanePaneFocusRequestedEvent) => callback(data);
      ipcRenderer.on('pane:focus-requested', wrappedCallback);
      return () => ipcRenderer.removeListener('pane:focus-requested', wrappedCallback);
    },
    onSessionDeleted: (callback: (session: Pick<Session, 'id'>) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, session: Pick<Session, 'id'>) => callback(session);
      ipcRenderer.on('session:deleted', wrappedCallback);
      return () => ipcRenderer.removeListener('session:deleted', wrappedCallback);
    },
    onSessionsLoaded: (callback: (sessions: Session[]) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, sessions: Session[]) => callback(sessions);
      ipcRenderer.on('sessions:loaded', wrappedCallback);
      return () => ipcRenderer.removeListener('sessions:loaded', wrappedCallback);
    },
    onGitStatusUpdated: (callback: (data: GitStatusUpdateData) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: GitStatusUpdateData) => callback(data);
      ipcRenderer.on('git-status-updated', wrappedCallback);
      return () => ipcRenderer.removeListener('git-status-updated', wrappedCallback);
    },
    onGitStatusLoading: (callback: (data: { sessionId: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on('git-status-loading', wrappedCallback);
      return () => ipcRenderer.removeListener('git-status-loading', wrappedCallback);
    },
    onSessionOutput: (callback: (output: SessionOutputData) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, output: SessionOutputData) => callback(output);
      ipcRenderer.on('session:output', wrappedCallback);
      return () => ipcRenderer.removeListener('session:output', wrappedCallback);
    },
    onSessionLog: (callback: (data: LogEntry) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: LogEntry) => callback(data);
      ipcRenderer.on('session-log', wrappedCallback);
      return () => ipcRenderer.removeListener('session-log', wrappedCallback);
    },
    onSessionLogsCleared: (callback: (data: { sessionId: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data);
      ipcRenderer.on('session-logs-cleared', wrappedCallback);
      return () => ipcRenderer.removeListener('session-logs-cleared', wrappedCallback);
    },
    onSessionOutputAvailable: (callback: (info: { sessionId: string; hasNewOutput: boolean }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, info: { sessionId: string; hasNewOutput: boolean }) => callback(info);
      ipcRenderer.on('session:output-available', wrappedCallback);
      return () => ipcRenderer.removeListener('session:output-available', wrappedCallback);
    },
    onOrchestrationSessionsChanged: (callback: (change: { sessionId: string; kind: string; selectionChanged?: boolean }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, change: { sessionId: string; kind: string; selectionChanged?: boolean }) => callback(change);
      ipcRenderer.on('orchestration-sessions:changed', wrappedCallback);
      return () => ipcRenderer.removeListener('orchestration-sessions:changed', wrappedCallback);
    },
    onOrchestrationSessionsOverviewUpdated: (callback: (change: { panelId: string; sessionId?: string; state: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, change: { panelId: string; sessionId?: string; state: string }) => callback(change);
      ipcRenderer.on('orchestration-sessions:overview-updated', wrappedCallback);
      return () => ipcRenderer.removeListener('orchestration-sessions:overview-updated', wrappedCallback);
    },
    
    // Project events
    onProjectUpdated: (callback: (project: Project) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, project: Project) => callback(project);
      ipcRenderer.on('project:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('project:updated', wrappedCallback);
    },
    
    // Panel events
    onPanelCreated: (callback: (panel: ToolPanel) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, panel: ToolPanel) => callback(panel);
      ipcRenderer.on('panel:created', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:created', wrappedCallback);
    },
    onPanelUpdated: (callback: (panel: ToolPanel) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, panel: ToolPanel) => callback(panel);
      ipcRenderer.on('panel:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:updated', wrappedCallback);
    },
    onPanelDeleted: (callback: (data: { panelId: string; sessionId: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string; sessionId: string }) => callback(data);
      ipcRenderer.on('panel:deleted', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:deleted', wrappedCallback);
    },
    onPanelActivityStatus: (callback: (data: { panelId: string; sessionId: string; status: 'active' | 'idle'; lastActivityAt?: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string; sessionId: string; status: 'active' | 'idle'; lastActivityAt?: string }) => callback(data);
      ipcRenderer.on('panel:activityStatus', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:activityStatus', wrappedCallback);
    },
    onPanelAgentStatus: (callback: (data: PanelAgentStatusEvent) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: PanelAgentStatusEvent) => callback(data);
      ipcRenderer.on('panel:agentStatus', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:agentStatus', wrappedCallback);
    },
    
    // Folder events
    onFolderCreated: (callback: (folder: Folder) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, folder: Folder) => callback(folder);
      ipcRenderer.on('folder:created', wrappedCallback);
      return () => ipcRenderer.removeListener('folder:created', wrappedCallback);
    },
    onFolderUpdated: (callback: (folder: Folder) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, folder: Folder) => callback(folder);
      ipcRenderer.on('folder:updated', wrappedCallback);
      return () => ipcRenderer.removeListener('folder:updated', wrappedCallback);
    },
    onFolderDeleted: (callback: (folderId: string) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, folderId: string) => callback(folderId);
      ipcRenderer.on('folder:deleted', wrappedCallback);
      return () => ipcRenderer.removeListener('folder:deleted', wrappedCallback);
    },
    
    // Panel events
    onPanelPromptAdded: (callback: (data: { panelId: string; content: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string; content: string }) => callback(data);
      ipcRenderer.on('panel:prompt-added', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:prompt-added', wrappedCallback);
    },
    
    onPanelResponseAdded: (callback: (data: { panelId: string; content: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string; content: string }) => callback(data);
      ipcRenderer.on('panel:response-added', wrappedCallback);
      return () => ipcRenderer.removeListener('panel:response-added', wrappedCallback);
    },
    
    onTerminalOutput: (callback: (output: TerminalOutputEvent) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, output: TerminalOutputEvent) => callback(output);
      ipcRenderer.on('terminal:output', wrappedCallback);
      return () => ipcRenderer.removeListener('terminal:output', wrappedCallback);
    },

    onTerminalCliReady: (callback: (data: { panelId: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string }) => callback(data);
      ipcRenderer.on('terminal:cliReady', wrappedCallback);
      return () => ipcRenderer.removeListener('terminal:cliReady', wrappedCallback);
    },

    onTerminalExited: (callback: (data: { sessionId: string; panelId: string; exitCode: number; signal: number | null }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string; panelId: string; exitCode: number; signal: number | null }) => callback(data);
      ipcRenderer.on('terminal:exited', wrappedCallback);
      return () => ipcRenderer.removeListener('terminal:exited', wrappedCallback);
    },

    onTerminalAlternateScreen: (callback: (data: { panelId: string; active: boolean }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { panelId: string; active: boolean }) => callback(data);
      ipcRenderer.on('terminal:alternateScreen', wrappedCallback);
      return () => ipcRenderer.removeListener('terminal:alternateScreen', wrappedCallback);
    },

    // Fired once per terminal spawn when the `usePtyHost` setting is on and
    // the ptyHost supervisor is live. Carries the host-allocated `ptyId` so
    // `TerminalPanel.tsx` can ack flow-control bytes over the ptyHost port.
    // Fires again on auto-reattach after a supervisor restart with the new ptyId.
    onTerminalPtyReady: (callback: (data: { sessionId: string; panelId: string; ptyId: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string; panelId: string; ptyId: string }) => callback(data);
      ipcRenderer.on('terminal:ptyReady', wrappedCallback);
      return () => ipcRenderer.removeListener('terminal:ptyReady', wrappedCallback);
    },

    // Spotlight events
    onSpotlightStatusChanged: (callback: (data: { sessionId: string; projectId: number; active: boolean }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string; projectId: number; active: boolean }) => callback(data);
      ipcRenderer.on('spotlight:status-changed', wrappedCallback);
      return () => ipcRenderer.removeListener('spotlight:status-changed', wrappedCallback);
    },
    onSpotlightSyncError: (callback: (data: { sessionId: string; projectId: number; error: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string; projectId: number; error: string }) => callback(data);
      ipcRenderer.on('spotlight:sync-error', wrappedCallback);
      return () => ipcRenderer.removeListener('spotlight:sync-error', wrappedCallback);
    },
    onSpotlightTamperDetected: (callback: (data: { sessionId: string; projectId: number; message: string }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { sessionId: string; projectId: number; message: string }) => callback(data);
      ipcRenderer.on('spotlight:tamper-detected', wrappedCallback);
      return () => ipcRenderer.removeListener('spotlight:tamper-detected', wrappedCallback);
    },

    // Generic event cleanup
    removeAllListeners: (channel: string) => {
      ipcRenderer.removeAllListeners(channel);
    },
    
    // Unclean shutdown detection (crash sentinel)
    onUncleanShutdownDetected: (callback: () => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('app:unclean-shutdown-detected', wrappedCallback);
      return () => ipcRenderer.removeListener('app:unclean-shutdown-detected', wrappedCallback);
    },

    // Main process logging
    onMainLog: (callback: (level: string, message: string) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, level: string, message: string) => callback(level, message);
      ipcRenderer.on('main-log', wrappedCallback);
      return () => ipcRenderer.removeListener('main-log', wrappedCallback);
    },

    // Version updates
    onVersionUpdateAvailable: (callback: (versionInfo: VersionInfo) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, versionInfo: VersionInfo) => callback(versionInfo);
      ipcRenderer.on('version:update-available', wrappedCallback);
      return () => ipcRenderer.removeListener('version:update-available', wrappedCallback);
    },
    
    // Auto-updater events
    onUpdaterCheckingForUpdate: (callback: () => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('updater:checking-for-update', wrappedCallback);
      return () => ipcRenderer.removeListener('updater:checking-for-update', wrappedCallback);
    },
    onUpdaterUpdateAvailable: (callback: (info: UpdaterInfo) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, info: UpdaterInfo) => callback(info);
      ipcRenderer.on('updater:update-available', wrappedCallback);
      return () => ipcRenderer.removeListener('updater:update-available', wrappedCallback);
    },
    onUpdaterUpdateNotAvailable: (callback: (info: UpdaterInfo) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, info: UpdaterInfo) => callback(info);
      ipcRenderer.on('updater:update-not-available', wrappedCallback);
      return () => ipcRenderer.removeListener('updater:update-not-available', wrappedCallback);
    },
    onUpdaterDownloadProgress: (callback: (progressInfo: { percent: number; bytesPerSecond: number; total: number; transferred: number }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, progressInfo: { percent: number; bytesPerSecond: number; total: number; transferred: number }) => callback(progressInfo);
      ipcRenderer.on('updater:download-progress', wrappedCallback);
      return () => ipcRenderer.removeListener('updater:download-progress', wrappedCallback);
    },
    onUpdaterUpdateDownloaded: (callback: (info: UpdaterInfo) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, info: UpdaterInfo) => callback(info);
      ipcRenderer.on('updater:update-downloaded', wrappedCallback);
      return () => ipcRenderer.removeListener('updater:update-downloaded', wrappedCallback);
    },
    onUpdaterError: (callback: (error: Error) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, error: Error) => callback(error);
      ipcRenderer.on('updater:error', wrappedCallback);
      return () => ipcRenderer.removeListener('updater:error', wrappedCallback);
    },
    
    onTerminalFontUpdated: (callback: (data: { terminalFontFamily: string; terminalFontSize: number }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { terminalFontFamily: string; terminalFontSize: number }) => callback(data);
      ipcRenderer.on('config:terminal-font-updated', wrappedCallback);
      return () => ipcRenderer.removeListener('config:terminal-font-updated', wrappedCallback);
    },
    onNativeAppearanceUpdated: (callback: (data: { prefersDark: boolean }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { prefersDark: boolean }) => callback(data);
      ipcRenderer.on('window:appearance-native-updated', wrappedCallback);
      return () => ipcRenderer.removeListener('window:appearance-native-updated', wrappedCallback);
    },

    // Process management events
    onZombieProcessesDetected: (callback: (data: { count: number; processes: string[] }) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, data: { count: number; processes: string[] }) => callback(data);
      ipcRenderer.on('zombie-processes-detected', wrappedCallback);
      return () => ipcRenderer.removeListener('zombie-processes-detected', wrappedCallback);
    },

    // Window focus state from BrowserWindow (more reliable than document.hasFocus())
    onWindowFocusChanged: (callback: (focused: boolean) => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent, focused: boolean) => callback(focused);
      ipcRenderer.on('window:focus-changed', wrappedCallback);
      return () => ipcRenderer.removeListener('window:focus-changed', wrappedCallback);
    },
    onRemoteDaemonResyncRequested: (callback: () => void) => {
      const wrappedCallback = (_event: Electron.IpcRendererEvent) => callback();
      ipcRenderer.on('remote-daemon:resync-required', wrappedCallback);
      return () => ipcRenderer.removeListener('remote-daemon:resync-required', wrappedCallback);
    },
  },

  // Panels API for Claude panels and other panel types
  panels: {
    createPanel: (sessionId: string, type: string, name: string, config?: JsonObject): Promise<IPCResponse> =>
      invokeIpc('panels:create', { sessionId, type, title: name, initialState: config }),
    getSessionPanels: (sessionId: string): Promise<IPCResponse> => invokeIpc('panels:list', sessionId),
    deletePanel: (panelId: string): Promise<IPCResponse> => invokeIpc('panels:delete', panelId),
    renamePanel: (panelId: string, name: string): Promise<IPCResponse> => invokeIpc('panels:update', panelId, { title: name }),
    setActivePanel: (sessionId: string, panelId: string): Promise<IPCResponse> => invokeIpc('panels:set-active', sessionId, panelId),
    resizeTerminal: (panelId: string, cols: number, rows: number): Promise<IPCResponse> => invokeIpc('panels:resize-terminal', panelId, cols, rows),
    sendTerminalInput: (panelId: string, data: string): Promise<IPCResponse> => invokeIpc('panels:send-terminal-input', panelId, data),
    getOutput: (panelId: string, limit?: number): Promise<IPCResponse> => invokeIpc('panels:get-output', panelId, limit),
    getConversationMessages: (panelId: string): Promise<IPCResponse> => invokeIpc('panels:get-conversation-messages', panelId),
    getJsonMessages: (panelId: string): Promise<IPCResponse> => invokeIpc('panels:get-json-messages', panelId),
    getPrompts: (panelId: string): Promise<IPCResponse> => invokeIpc('panels:get-prompts', panelId),
    sendInput: (panelId: string, input: string): Promise<IPCResponse> => invokeIpc('panels:send-input', panelId, input),
    continue: (panelId: string, input: string, model?: string): Promise<IPCResponse> => invokeIpc('panels:continue', panelId, input, model),
  },

  // Logs panel operations
  logs: {
    runScript: (sessionId: string, command: string, cwd: string): Promise<IPCResponse> => invokeIpc('logs:runScript', sessionId, command, cwd),
    stopScript: (panelId: string): Promise<IPCResponse> => invokeIpc('logs:stopScript', panelId),
    isRunning: (sessionId: string): Promise<IPCResponse> => invokeIpc('logs:isRunning', sessionId),
  },

  // Debug utilities
  debug: {
    getTableStructure: (tableName: 'folders' | 'sessions'): Promise<IPCResponse> => invokeIpc('debug:get-table-structure', tableName),
  },

  // Nimbalyst integration
  nimbalyst: {
    checkInstalled: (): Promise<IPCResponse> => invokeIpc('nimbalyst:check-installed'),
    openWorktree: (worktreePath: string): Promise<IPCResponse> => invokeIpc('nimbalyst:open-worktree', worktreePath),
  },

  // Analytics tracking
  analytics: {
    getIdentity: () => invokeIpc('analytics:get-identity'),
    onMainEvent: (callback: (event: AnalyticsEvent) => void) => {
      // Replay any events that arrived before this callback was registered
      for (const buffered of analyticsEventBuffer) {
        callback(buffered);
      }
      analyticsEventBuffer.length = 0;
      analyticsForwardCallback = callback;
      return () => {
        analyticsForwardCallback = null;
      };
    },
    syncDistinctId: (distinctId: string): void => {
      ipcRenderer.send('analytics:sync-distinct-id', distinctId);
    },
    redeemAttribution: (): Promise<IPCResponse<void>> => invokeIpc('analytics:redeem-attribution'),
  },

  // Spotlight
  spotlight: {
    enable: (sessionId: string): Promise<IPCResponse> => invokeIpc('spotlight:enable', sessionId),
    disable: (sessionId: string): Promise<IPCResponse> => invokeIpc('spotlight:disable', sessionId),
    getStatus: (projectId: number): Promise<IPCResponse> => invokeIpc('spotlight:get-status', projectId),
  },

  // Resource monitor
  resourceMonitor: {
    getSnapshot: (): Promise<IPCResponse> => invokeIpc('resource-monitor:get-snapshot'),
    startActive: (): Promise<IPCResponse> => invokeIpc('resource-monitor:start-active'),
    stopActive: (): Promise<IPCResponse> => invokeIpc('resource-monitor:stop-active'),
  },

  // Agent subscription usage
  agentUsage: {
    get: (force = false): Promise<IPCResponse<AgentUsageSnapshot>> =>
      invokeIpc('agent-usage:get', force),
  },

  // Window state queries (invoke, not event subscriptions)
  window: {
    isFocused: async (): Promise<boolean> => decodeBoundary(await invokeIpc('window:is-focused'), boundary.boolean),
  },

  // ptyHost: typed wrapper over the per-window MessagePort. The raw port is
  // kept in preload scope; only these functions cross the contextBridge.
  //
  // `onExit` returns an unsubscribe function matching the existing
  // event-subscription convention elsewhere on `electronAPI.events`.
  //
  // `write` / `ack` post frames back over the port; main handles them in
  // `PtyHostSupervisor.onRendererMessage`.
  ptyHost: {
    onExit: (ptyId: string, cb: PtyExitCallback): (() => void) => {
      let set = ptyExitSubscribers.get(ptyId);
      if (!set) {
        set = new Set();
        ptyExitSubscribers.set(ptyId, set);
      }
      set.add(cb);
      return () => {
        const current = ptyExitSubscribers.get(ptyId);
        if (!current) return;
        current.delete(cb);
        if (current.size === 0) {
          ptyExitSubscribers.delete(ptyId);
        }
      };
    },
    ack: (ptyId: string, bytes: number): void => {
      if (!ptyHostPort) return;
      ptyHostPort.postMessage({ type: 'ack', ptyId, bytes });
    },
    write: (ptyId: string, data: string): void => {
      if (!ptyHostPort) return;
      ptyHostPort.postMessage({ type: 'write', ptyId, data });
    },
  },
});

// Expose electron event listeners and utilities for permission requests
contextBridge.exposeInMainWorld('electron', {
  openExternal: (url: string) => invokeIpc('openExternal', url),
  invoke: (channel: string, ...args: unknown[]) => invokeIpc(channel, ...args),
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = [
      'permission:request',
      'permission:resolved',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },
  off: (channel: string, callback: (...args: unknown[]) => void) => {
    const validChannels = [
      'permission:request',
      'permission:resolved',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, callback);
    }
  },
});
