import type {
  OrchestrationSessionCreateInput,
  OrchestrationSessionListResult,
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../../shared/types/orchestrationSession';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import type { RemoteDaemonEventEnvelope, RemotePaneConnectionProfile, RemotePwaAffordances } from '../../../../shared/types/remoteDaemon';
import type {
  VoiceDeepgramTokenResult,
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../../../../shared/types/voiceTranscription';
import type { Project } from '../../types/project';
import type { CreateSessionRequest, Session, SessionOutput } from '../../types/session';
import { RemoteDaemonBrowserClient, type RemoteBrowserConnectionState } from './remoteDaemonBrowserClient';

export interface RemoteProjectWithSessions extends Project {
  sessions?: Session[];
}

export interface RemoteBranchInfo {
  name: string;
  isCurrent: boolean;
  hasWorktree: boolean;
  isRemote: boolean;
}

/** One entry of a worktree folder; `path` is relative to the worktree, in the host's separators. */
export interface RemoteFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

/** The `file:*` commands answer `{ success, error, ...result }` instead of the `{ success, data }` envelope. */
type FileCommandResult<T> = T & { success: boolean; error?: string };

export interface RemoteCreateSessionResult {
  jobId?: string;
  jobIds?: string[];
}

interface IpcLikeResponse<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

export type RemoteRuntimeEventListener = (event: RemoteDaemonEventEnvelope) => void;
export type RemoteRuntimeStatusListener = (status: RemoteBrowserConnectionState) => void;

export class RemoteRuntimeAdapter {
  private readonly client: RemoteDaemonBrowserClient;

  constructor(readonly profile: RemotePaneConnectionProfile) {
    this.client = new RemoteDaemonBrowserClient(profile);
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  getStatus(): RemoteBrowserConnectionState {
    return this.client.getState();
  }

  onStatus(listener: RemoteRuntimeStatusListener): () => void {
    return this.client.onStatus(listener);
  }

  onEvent(listener: RemoteRuntimeEventListener): () => void {
    return this.client.onEvent(event => {
      if (event.type === 'daemon-event') {
        listener(event.payload);
      }
    });
  }

  async invoke<T>(channel: string, args: unknown[] = []): Promise<T> {
    const response = await this.client.invoke<IpcLikeResponse<T> | T>(channel, args);
    if (isIpcResponse<T>(response)) {
      if (response.success === false) {
        throw new Error(response.error ?? `${channel} failed`);
      }
      // SAFETY: The named IPC/API channel contract establishes this response payload type.
      return response.data as T;
    }
    // SAFETY: The adapter method selects T from the invoked channel contract.
    return response as T;
  }

  getProjectsWithSessions(): Promise<RemoteProjectWithSessions[]> {
    return this.invoke<RemoteProjectWithSessions[]>('sessions:get-all-with-projects');
  }

  getSession(sessionId: string): Promise<Session> {
    return this.invoke<Session>('sessions:get', [sessionId]);
  }

  getPanels(sessionId: string): Promise<ToolPanel[]> {
    return this.invoke<ToolPanel[]>('panels:list', [sessionId]);
  }

  getActivePanel(sessionId: string): Promise<ToolPanel | null> {
    return this.invoke<ToolPanel | null>('panels:getActive', [sessionId]);
  }

  setActivePanel(sessionId: string, panelId: string): Promise<void> {
    return this.invoke<void>('panels:set-active', [sessionId, panelId]);
  }

  getPwaAffordances(): Promise<RemotePwaAffordances> {
    return this.invoke<RemotePwaAffordances>('remote:pwa-affordances');
  }

  transcribeVoice(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    return this.invoke<VoiceTranscriptionResult>('voice:transcribe', [request]);
  }

  getDeepgramStreamingToken(): Promise<VoiceDeepgramTokenResult> {
    return this.invoke<VoiceDeepgramTokenResult>('voice:deepgram-token');
  }

  createDeepgramStreamingSocket(): WebSocket {
    return this.client.createDeepgramStreamingSocket();
  }

  finalizeStreamingVoice(request: VoiceStreamingFinalizeRequest): Promise<VoiceTranscriptionResult> {
    return this.invoke<VoiceTranscriptionResult>('voice:finalize-streaming', [request]);
  }

  toggleFavorite(sessionId: string): Promise<{ isFavorite: boolean; favoritePinnedAt?: string | null }> {
    return this.invoke<{ isFavorite: boolean; favoritePinnedAt?: string | null }>('sessions:toggle-favorite', [sessionId]);
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.invoke<void>('sessions:delete', [sessionId]);
  }

  getArchivedProjectsWithSessions(): Promise<RemoteProjectWithSessions[]> {
    return this.invoke<RemoteProjectWithSessions[]>('sessions:get-archived-with-projects');
  }

  restoreSession(sessionId: string): Promise<void> {
    return this.invoke<void>('sessions:restore', [sessionId]);
  }

  listOrchestrationSessions(): Promise<OrchestrationSessionListResult> {
    return this.invoke<OrchestrationSessionListResult>('orchestration-sessions:list');
  }

  /**
   * Returns the Session's workspace and agent panel, starting them if needed. It
   * leaves the host's selected Session alone so a phone never moves the desktop.
   */
  openOrchestrationSession(sessionId: string): Promise<OrchestrationSessionView<Session>> {
    return this.invoke<OrchestrationSessionView<Session>>('orchestration-sessions:get', [{ sessionId }]);
  }

  createOrchestrationSession(input: OrchestrationSessionCreateInput): Promise<OrchestrationSessionView<Session>> {
    return this.invoke<OrchestrationSessionView<Session>>('orchestration-sessions:create', [input]);
  }

  updateOrchestrationSession(sessionId: string, input: OrchestrationSessionUpdateInput): Promise<OrchestrationSessionRecord> {
    return this.invoke<OrchestrationSessionRecord>('orchestration-sessions:update', [{ sessionId }, input]);
  }

  listProjectBranches(projectId: number): Promise<RemoteBranchInfo[]> {
    return this.invoke<RemoteBranchInfo[]>('projects:list-branches', [String(projectId)]);
  }

  detectProjectBranch(path: string): Promise<string> {
    return this.invoke<string>('projects:detect-branch', [path]);
  }

  createSession(request: CreateSessionRequest): Promise<RemoteCreateSessionResult> {
    return this.invoke<RemoteCreateSessionResult>('sessions:create', [request]);
  }

  createTerminalPanel(sessionId: string, options: { title?: string; initialCommand?: string } = {}): Promise<ToolPanel> {
    const initialState = options.initialCommand
      ? {
          customState: {
            initialCommand: options.initialCommand,
          },
        }
      : undefined;

    return this.invoke<ToolPanel>('panels:create', [{
      sessionId,
      type: 'terminal',
      title: options.title ?? 'Terminal',
      initialState,
    }]);
  }

  createBrowserPanel(sessionId: string): Promise<ToolPanel> {
    return this.invoke<ToolPanel>('panels:create', [{ sessionId, type: 'browser', title: 'Browser' }]);
  }

  updatePanelState(panelId: string, state: ToolPanel['state']): Promise<void> {
    return this.invoke<void>('panels:update', [panelId, { state }]);
  }

  /** Asks the host for a web port's phone address; it arrives with the next ports:changed. */
  requestPhoneAddress(port: number): Promise<void> {
    return this.invoke<void>('ports:phone-address', [port]);
  }

  getListeningPorts(): Promise<ListeningPortsSnapshot> {
    return this.invoke<ListeningPortsSnapshot>('ports:list');
  }

  /** A folder of the pane's worktree, folders first; '' is the worktree itself. */
  async listFiles(sessionId: string, path: string): Promise<RemoteFileEntry[]> {
    return (await this.invokeFileCommand<{ files: RemoteFileEntry[] }>('file:list', [{ sessionId, path }])).files;
  }

  /** A worktree file's text, or null when the host finds it binary. */
  async readTextFile(sessionId: string, filePath: string): Promise<string | null> {
    const result = await this.client.invoke<FileCommandResult<{ content?: string; binary?: boolean }>>('file:read', [{ sessionId, filePath }]);
    if (result.binary) return null;
    if (!result.success) throw new Error(result.error ?? 'Could not read the file');
    return result.content ?? '';
  }

  async writeTextFile(sessionId: string, filePath: string, content: string): Promise<void> {
    await this.invokeFileCommand('file:write', [{ sessionId, filePath, content }]);
  }

  private async invokeFileCommand<T extends object = object>(channel: string, args: unknown[]): Promise<T> {
    const result = await this.client.invoke<FileCommandResult<T>>(channel, args);
    if (!result.success) throw new Error(result.error ?? `${channel} failed`);
    return result;
  }

  checkPanelInitialized(panelId: string): Promise<boolean> {
    return this.invoke<boolean>('panels:checkInitialized', [panelId]);
  }

  initializePanel(panelId: string, options: { sessionId: string; cols?: number; rows?: number }): Promise<void> {
    return this.invoke<void>('panels:initialize', [panelId, options]);
  }

  getPanelOutput(panelId: string, limit = 5_000): Promise<SessionOutput[]> {
    return this.invoke<SessionOutput[]>('panels:get-output', [panelId, limit]);
  }

  sendTerminalInput(panelId: string, data: string): Promise<void> {
    return this.invoke<void>('terminal:input', [panelId, data]);
  }

  clearTerminalScrollback(panelId: string): Promise<void> {
    return this.invoke<void>('terminal:clearScrollback', [panelId]);
  }

  resizeTerminal(panelId: string, cols: number, rows: number): Promise<void> {
    return this.invoke<void>('terminal:resize', [panelId, cols, rows]);
  }

  setTerminalVisibility(panelId: string, visible: boolean, viewerId: string): Promise<void> {
    return this.invoke<void>('terminal:setVisibility', [panelId, visible, viewerId]);
  }

  ackTerminalOutput(panelId: string, bytes: number): Promise<void> {
    return this.invoke<void>('terminal:ack', [panelId, bytes]);
  }
}

function isIpcResponse<T>(value: IpcLikeResponse<T> | T): value is IpcLikeResponse<T> {
  return Boolean(value && value instanceof Object && ('success' in value || 'data' in value || 'error' in value));
}
