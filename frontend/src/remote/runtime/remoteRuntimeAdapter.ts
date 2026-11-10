import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { ChatTabClient, ChatTabCreate } from '../../../../shared/types/chatTab';
import { decodeChatMessages, decodeChatReceipt, decodeChatTabEvent, decodeChatTabView } from '../../../../shared/types/chatTabDecoders';
import type {
  OrchestrationSessionCreateInput,
  OrchestrationSessionListResult,
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../../shared/types/orchestrationSession';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { FileDiffRequest } from '../../../../shared/types/gitDiff';
import { BRANCH_SCOPE, decodeFileDiff, decodeManifest, type ChangeList } from '../../../../shared/gitDiffClient';
import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import type { RemoteDaemonEventEnvelope, RemotePaneConnectionProfile, RemotePwaAffordances } from '../../../../shared/types/remoteDaemon';
import type { RunpanePanelScreenResult, RunpanePauseResult } from '../../../../shared/types/runpaneOrchestration';
import type {
  VoiceDeepgramTokenResult,
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../../../../shared/types/voiceTranscription';
import type { Project } from '../../types/project';
import type { SessionWorkerSource } from '../../components/chatTab/sessionWorkers';
import { watchHostSessionChanges } from './hostSessionChanges';
import { savedFilePath } from '../../components/chatTab/chatAttachments';
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

  retryNow(): void { this.client.retryNow(); }

  suspend(): void { this.client.suspend(); }

  resume(): void { this.client.resume(); }

  disconnect(): void {
    this.client.disconnect();
  }

  getStatus(): RemoteBrowserConnectionState {
    return this.client.getState();
  }

  onRestore(listener: (signal: AbortSignal) => Promise<void>): () => void {
    return this.client.onRestore(listener);
  }

  onStatus(listener: RemoteRuntimeStatusListener): () => void {
    return this.client.onStatus(listener);
  }

  /**
   * A Pane's git status, as the host's `sessions:get-git-status` returns it (non-blocking: the
   * cached status now, with a refresh that arrives as `git-status-updated`). Its reply carries
   * `gitStatus` beside `success`, not under `data`, so it is read here rather than through invoke.
   */
  async gitStatus(paneId: string): Promise<JsonValue | undefined> {
    const response = await this.client.invoke<{ success?: boolean; error?: string; gitStatus?: JsonValue }>('sessions:get-git-status', [paneId, true]);
    if (response.success === false) throw new Error(response.error ?? 'sessions:get-git-status failed');
    return response.gitStatus ?? undefined;
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

  /** Chat tabs on the connected host: the agent runs there, under that machine's own sign-in. */
  readonly chatTab: ChatTabClient & { create(request: ChatTabCreate): Promise<{ panelId: string }> } = {
    create: request => this.invoke('chat-tab:create', [request]),
    get: async (panelId, limit) => decodeChatTabView(await this.invoke('chat-tab:get', limit === undefined ? [panelId] : [panelId, limit])),
    history: async (panelId, before, limit) => decodeChatMessages(await this.invoke('chat-tab:history', [panelId, before, limit])),
    send: async (panelId, request) => {
      const receipt = decodeChatReceipt(await this.invoke('chat-tab:send', [panelId, request]));
      if (!receipt) throw new Error('The host did not confirm the message. Check delivery before sending again.');
      return receipt;
    },
    receipt: async (panelId, operationId) => decodeChatReceipt(await this.invoke('chat-tab:receipt', [panelId, operationId])),
    unqueue: (panelId, operationId) => this.invoke('chat-tab:unqueue', [panelId, operationId]),
    sendNow: (panelId, operationId) => this.invoke('chat-tab:send-now', [panelId, operationId]),
    editQueued: (panelId, operationId, text) => this.invoke('chat-tab:edit-queued', [panelId, operationId, text]),
    clear: panelId => this.invoke('chat-tab:clear', [panelId]),
    stopTask: (panelId, taskId) => this.invoke('chat-tab:stop-task', [panelId, taskId]),
    configure: (panelId, configId, value) => this.invoke('chat-tab:configure', [panelId, configId, value]),
    cancel: panelId => this.invoke('chat-tab:cancel', [panelId]),
    permission: (panelId, requestId, optionId) => this.invoke('chat-tab:permission', [panelId, requestId, optionId]),
    answer: (panelId, questionId, response) => this.invoke('chat-tab:answer', [panelId, questionId, response]),
    restart: panelId => this.invoke('chat-tab:restart', [panelId]),
    signIn: panelId => this.invoke('chat-tab:sign-in', [panelId]),
    onEvent: callback => this.onEvent(event => { if (event.channel === 'chat-tab:event') callback(decodeChatTabEvent(event.args[0])); }),
    onState: callback => this.onEvent(event => { if (event.channel === 'chat-tab:state') callback(decodeChatTabView(event.args[0])); }),
    onReconnect: callback => this.onStatus(state => { if (state.status === 'connected') callback(); }),
  };

  /** A Session's overview on the host, read again when its Panes, states or reports change or the connection returns. */
  readonly sessionWorkers: SessionWorkerSource = {
    overview: sessionId => this.invoke<OrchestrationSessionOverview>('orchestration-sessions:overview', [{ sessionId }]),
    onChange: callback => watchHostSessionChanges(this, callback),
  };

  getProjectsWithSessions(): Promise<RemoteProjectWithSessions[]> {
    return this.invoke<RemoteProjectWithSessions[]>('sessions:get-all-with-projects');
  }

  getSession(sessionId: string): Promise<Session> {
    return this.invoke<Session>('sessions:get', [sessionId]);
  }

  getPanels(sessionId: string): Promise<ToolPanel[]> {
    return this.invoke<ToolPanel[]>('panels:list', [sessionId, { chatTabs: true }]);
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

  /**
   * Pauses or resumes every terminal tab of a Pane, or of a Session's chat and Panes.
   * Returns what the person must know when chat tabs kept running (D-187).
   */
  async setPaused(target: { kind: 'pane' | 'session'; id: string }, paused: boolean): Promise<string | undefined> {
    const noun = target.kind === 'pane' ? 'panes' : 'sessions';
    const key = target.kind === 'pane' ? 'paneId' : 'sessionId';
    const result = await this.invoke<RunpanePauseResult>(`runpane:${noun}:${paused ? 'pause' : 'resume'}`, [{ [key]: target.id }]);
    // A resume that left some tabs stopped answers `ok: false` with why.
    if (!result.ok) throw new Error(result.message);
    return result.chatTabsNotPaused ? result.message : undefined;
  }

  /** Resumes one paused tab through the host's usual restart. */
  resumePanel(panelId: string): Promise<void> {
    return this.invoke<void>('runpane:panels:resume', [{ panelId }]);
  }

  /** A terminal tab's screen as text: the live one, or the one saved when it stopped. */
  getPanelScreen(panelId: string, limit: number): Promise<RunpanePanelScreenResult> {
    return this.invoke<RunpanePanelScreenResult>('runpane:panels:screen', [{ panelId, limit }]);
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
    return this.invoke<OrchestrationSessionView<Session>>('orchestration-sessions:get', [{ sessionId }, { chatTabs: true }]);
  }

  createOrchestrationSession(input: OrchestrationSessionCreateInput): Promise<OrchestrationSessionView<Session>> {
    return this.invoke<OrchestrationSessionView<Session>>('orchestration-sessions:create', [input, { chatTabs: true }]);
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

  /** Copies a file dropped or pasted into a chat to the Pane's machine, as the terminal's upload does (D-139). */
  async saveFile(sessionId: string, file: { name: string; dataUrl: string }): Promise<string> {
    return savedFilePath(await this.invoke('terminal:paste-file', [sessionId, file.dataUrl, file.name, { keepName: true }]));
  }

  /** The branch's changes, read-only, as the phone's Diff tab reads them. */
  readonly diff = {
    manifest: async (sessionId: string): Promise<ChangeList> => decodeManifest(await this.client.invoke('sessions:get-diff-manifest', [sessionId, BRANCH_SCOPE])),
    file: async (sessionId: string, request: FileDiffRequest) => decodeFileDiff(await this.client.invoke('sessions:get-file-diff', [sessionId, BRANCH_SCOPE, request])),
  };

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

  ackTerminalOutput(panelId: string, bytes: number, viewerId: string): Promise<void> {
    return this.invoke<void>('terminal:ack', [panelId, bytes, viewerId]);
  }
}

function isIpcResponse<T>(value: IpcLikeResponse<T> | T): value is IpcLikeResponse<T> {
  return decodeOptionalBoundary(value, boundary.object({ success: boundary.boolean })) !== undefined;
}
