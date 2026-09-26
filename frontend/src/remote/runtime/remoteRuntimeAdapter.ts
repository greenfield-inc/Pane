import { decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { remoteIpcEnvelopeSchema, remoteResponseSchemas } from './remotePayloadSchemas';
import type { ToolPanel } from '../../../../shared/types/panels';
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

export interface RemoteCreateSessionResult {
  jobId?: string;
  jobIds?: string[];
}

type RemoteChannel = keyof typeof remoteResponseSchemas;
type RemoteResponse<Channel extends RemoteChannel> = ReturnType<(typeof remoteResponseSchemas)[Channel]['decode']>;

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

  invoke<Channel extends RemoteChannel>(channel: Channel, args?: unknown[]): Promise<RemoteResponse<Channel>>;
  async invoke(channel: RemoteChannel, args: unknown[] = []): Promise<RemoteResponse<RemoteChannel>> {
    const response = await this.client.invoke<unknown>(channel, args);
    const envelope = decodeOptionalBoundary(response, remoteIpcEnvelopeSchema);
    if (envelope?.success === false) throw new Error(envelope.error ?? `${channel} failed`);
    const schema: BoundarySchema<RemoteResponse<RemoteChannel>> = remoteResponseSchemas[channel];
    return decodeBoundary(envelope ? envelope.data : response, schema);
  }

  getProjectsWithSessions(): Promise<RemoteProjectWithSessions[]> {
    return this.invoke('sessions:get-all-with-projects');
  }

  getSession(sessionId: string): Promise<Session> {
    return this.invoke('sessions:get', [sessionId]);
  }

  getPanels(sessionId: string): Promise<ToolPanel[]> {
    return this.invoke('panels:list', [sessionId]);
  }

  getActivePanel(sessionId: string): Promise<ToolPanel | null> {
    return this.invoke('panels:getActive', [sessionId]);
  }

  setActivePanel(sessionId: string, panelId: string): Promise<void> {
    return this.invoke('panels:set-active', [sessionId, panelId]);
  }

  getPwaAffordances(): Promise<RemotePwaAffordances> {
    return this.invoke('remote:pwa-affordances');
  }

  transcribeVoice(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    return this.invoke('voice:transcribe', [request]);
  }

  getDeepgramStreamingToken(): Promise<VoiceDeepgramTokenResult> {
    return this.invoke('voice:deepgram-token');
  }

  createDeepgramStreamingSocket(): WebSocket {
    return this.client.createDeepgramStreamingSocket();
  }

  finalizeStreamingVoice(request: VoiceStreamingFinalizeRequest): Promise<VoiceTranscriptionResult> {
    return this.invoke('voice:finalize-streaming', [request]);
  }

  toggleFavorite(sessionId: string): Promise<{ isFavorite: boolean; favoritePinnedAt?: string | null }> {
    return this.invoke('sessions:toggle-favorite', [sessionId]);
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.invoke('sessions:delete', [sessionId]);
  }

  listProjectBranches(projectId: number): Promise<RemoteBranchInfo[]> {
    return this.invoke('projects:list-branches', [String(projectId)]);
  }

  detectProjectBranch(path: string): Promise<string> {
    return this.invoke('projects:detect-branch', [path]);
  }

  createSession(request: CreateSessionRequest): Promise<RemoteCreateSessionResult> {
    return this.invoke('sessions:create', [request]);
  }

  createTerminalPanel(sessionId: string, options: { title?: string; initialCommand?: string } = {}): Promise<ToolPanel> {
    const initialState = options.initialCommand
      ? {
          customState: {
            initialCommand: options.initialCommand,
          },
        }
      : undefined;

    return this.invoke('panels:create', [{
      sessionId,
      type: 'terminal',
      title: options.title ?? 'Terminal',
      initialState,
    }]);
  }

  checkPanelInitialized(panelId: string): Promise<boolean> {
    return this.invoke('panels:checkInitialized', [panelId]);
  }

  initializePanel(panelId: string, options: { sessionId: string; cols?: number; rows?: number }): Promise<void> {
    return this.invoke('panels:initialize', [panelId, options]);
  }

  getPanelOutput(panelId: string, limit = 5_000): Promise<SessionOutput[]> {
    return this.invoke('panels:get-output', [panelId, limit]);
  }

  sendTerminalInput(panelId: string, data: string): Promise<void> {
    return this.invoke('terminal:input', [panelId, data]);
  }

  clearTerminalScrollback(panelId: string): Promise<void> {
    return this.invoke('terminal:clearScrollback', [panelId]);
  }

  resizeTerminal(panelId: string, cols: number, rows: number): Promise<void> {
    return this.invoke('terminal:resize', [panelId, cols, rows]);
  }

  setTerminalVisibility(panelId: string, visible: boolean, viewerId: string): Promise<void> {
    return this.invoke('terminal:setVisibility', [panelId, visible, viewerId]);
  }

  ackTerminalOutput(panelId: string, bytes: number): Promise<void> {
    return this.invoke('terminal:ack', [panelId, bytes]);
  }
}
