import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import {
  client, methods, type ClientConnection, type ContentBlock, type InitializeResponse,
  type LoadSessionRequest, type RequestPermissionRequest, type RequestPermissionResponse,
  type SessionNotification, type Stream, type PromptResponse, type NewSessionRequest, type NewSessionResponse,
  type LoadSessionResponse, type ForkSessionRequest, type ForkSessionResponse,
} from '@agentclientprotocol/sdk/unstable';
import { PaneError } from '../../../../shared/paneError';

export interface ChatPermission {
  id: string;
  generation: number;
  request: RequestPermissionRequest;
}

export interface AcpSessionOptions {
  requestTimeoutMs?: number;
  onUpdate?: (notification: SessionNotification) => void;
  onState?: () => void;
  onDisconnect?: () => void;
  /** Durable host fence before history loading or accepting new input. */
  onIdentity?: (sessionId: string) => void;
  onForkRequested?: () => void;
}

/** Protocol lifetime owned by the host. Viewers never close this connection. */
export class AcpSession {
  private readonly connection: ClientConnection;
  private initialization?: InitializeResponse;
  private sessionId?: string;
  private loaded = false;
  private disconnected = false;
  private closing = false;
  private historyVerified = false;
  private transferNotice?: string;
  private readonly history: SessionNotification[] = [];
  private readonly pending = new Map<string, { permission: ChatPermission; resolve: (response: RequestPermissionResponse) => void }>();
  private running = false;
  private configuring = false;
  private configuration?: LoadSessionResponse | NewSessionResponse;

  constructor(stream: Stream, readonly generation: number, private readonly options: AcpSessionOptions = {}) {
    this.connection = client({ name: 'pane' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (params.sessionId !== this.sessionId) return;
        if (params.update.sessionUpdate === 'config_option_update' && this.configuration) {
          this.configuration = { ...this.configuration, configOptions: params.update.configOptions };
          this.options.onState?.();
        }
        if (this.options.onUpdate) this.options.onUpdate(params);
        else if (this.history.length < 10_000) this.history.push(params);
        if (params.update.sessionUpdate === 'user_message_chunk' || params.update.sessionUpdate === 'agent_message_chunk') this.historyVerified = true;
      })
      .onRequest(methods.client.session.requestPermission, ({ params, requestId, signal }) => {
        if (params.sessionId !== this.sessionId || !this.loaded || signal.aborted) return { outcome: { outcome: 'cancelled' } };
        const id = `${generation}:${JSON.stringify(requestId)}`;
        return new Promise<RequestPermissionResponse>(resolve => {
          const abort = () => {
            this.pending.delete(id);
            resolve({ outcome: { outcome: 'cancelled' } });
            this.options.onState?.();
          };
          this.pending.set(id, {
            permission: { id, generation, request: params },
            resolve: response => { signal.removeEventListener('abort', abort); resolve(response); },
          });
          signal.addEventListener('abort', abort, { once: true });
          this.options.onState?.();
        });
      }).connect(stream);
    void this.connection.closed.then(() => {
      this.loaded = false;
      this.disconnected = true;
      this.withdrawPermissions();
      if (!this.closing) this.options.onDisconnect?.();
      this.options.onState?.();
    });
  }

  async initialize(): Promise<InitializeResponse> {
    this.initialization = await this.bounded(this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'pane', version: '1' },
    }));
    return this.initialization;
  }

  async load(request: LoadSessionRequest, options?: { allowIncompleteHistory: boolean }): Promise<LoadSessionResponse> {
    this.assertEmpty();
    return this.loadHistory(request, options?.allowIncompleteHistory);
  }

  /** Provider-native history copy: this never submits the old turns as prompts. */
  async fork(request: ForkSessionRequest): Promise<ForkSessionResponse> {
    this.assertEmpty();
    if (!this.initialization?.agentCapabilities?.sessionCapabilities?.fork || !this.initialization.agentCapabilities.loadSession) {
      throw new PaneError('CHAT_FORK_UNSUPPORTED', 'The adapter cannot copy and load conversation history.', 'Retry with a compatible adapter; the original history is preserved.');
    }
    this.options.onForkRequested?.();
    const response = await this.bounded(this.connection.agent.request(methods.agent.session.fork, request));
    if (!response.sessionId || response.sessionId === request.sessionId) {
      throw new PaneError('CHAT_FORK_IDENTITY_INVALID', 'The adapter did not return a separate conversation identity.', 'Keep the tab stopped and inspect the provider session before retrying.');
    }
    // Retain the returned identity even when replay fails, so close still targets
    // the fork and never the original provider conversation.
    this.sessionId = response.sessionId;
    this.options.onIdentity?.(response.sessionId);
    const loaded = await this.loadHistory({ ...request, sessionId: response.sessionId, mcpServers: request.mcpServers ?? [] }, true);
    return { ...loaded, sessionId: response.sessionId };
  }

  historyNotice(): string | undefined { return this.transferNotice; }

  private async loadHistory(request: LoadSessionRequest, allowIncompleteHistory = false): Promise<LoadSessionResponse> {
    if (!this.initialization?.agentCapabilities?.loadSession) {
      throw new PaneError('CHAT_IMPORT_UNSUPPORTED', 'The adapter cannot load an existing conversation.', 'Keep this tab in Terminal or install a compatible adapter.');
    }
    this.sessionId = request.sessionId;
    this.loaded = false;
    const response = await this.bounded(this.connection.agent.request(methods.agent.session.load, request));
    if (!this.historyVerified && !allowIncompleteHistory) {
      throw new PaneError('CHAT_HISTORY_UNVERIFIED', 'The adapter returned no conversation history. Chat was not activated.', 'Keep the exact conversation stopped until the adapter can replay it; do not create a replacement.');
    }
    this.transferNotice = this.historyVerified ? undefined : 'The provider did not return earlier conversation history. Its saved conversation is retained, but Chat cannot confirm that all prior context is available.';
    this.loaded = true;
    this.configuration = response;
    return response;
  }

  private assertEmpty(): void {
    if (this.sessionId) throw new PaneError('CHAT_ALREADY_LOADED', 'This adapter already owns a conversation. No new conversation was created.', 'Use a separate tab for a new conversation.');
  }

  async create(request: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertEmpty();
    const response = await this.bounded(this.connection.agent.request(methods.agent.session.new, request));
    this.sessionId = response.sessionId;
    this.options.onIdentity?.(response.sessionId);
    this.loaded = true;
    this.configuration = response;
    return response;
  }

  updates(): SessionNotification[] {
    return structuredClone(this.history);
  }

  permissions(): ChatPermission[] {
    return structuredClone([...this.pending.values()].map(entry => entry.permission));
  }

  answer(id: string, generation: number, optionId: string): void {
    if (generation !== this.generation) throw new PaneError('CHAT_STALE_GENERATION', 'The runtime changed. No permission answer was sent.', 'Refresh the conversation.');
    const pending = this.pending.get(id);
    if (!pending) throw new PaneError('CHAT_PERMISSION_ALREADY_ANSWERED', 'This permission was already answered or withdrawn. No answer was sent.', 'Refresh the pending requests.');
    if (!pending.permission.request.options.some(option => option.optionId === optionId)) {
      throw new PaneError('CHAT_PERMISSION_OPTION_INVALID', 'The answer is not one of the advertised permission options. No answer was sent.', 'Select one of the displayed options.');
    }
    this.pending.delete(id);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    this.options.onState?.();
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    if (!this.sessionId || !this.loaded) throw new PaneError('CHAT_NOT_LOADED', 'No verified conversation is loaded. No prompt was sent.', 'Load the exact conversation first.');
    if (this.running || this.configuring) throw new PaneError('CHAT_TURN_RUNNING', 'The agent is already working. No prompt was sent.', 'Wait for the turn or cancel it.');
    this.running = true;
    this.options.onState?.();
    try {
      return await this.connection.agent.request(methods.agent.session.prompt, { sessionId: this.sessionId, prompt: content });
    } finally {
      this.running = false;
      this.options.onState?.();
    }
  }

  isRunning(): boolean { return this.running || this.configuring; }
  supportsImages(): boolean { return this.initialization?.agentCapabilities?.promptCapabilities?.image === true; }

  async configure(configId: string, value: string): Promise<void> {
    if (!this.sessionId || !this.loaded || this.running || this.configuring || this.pending.size) throw new PaneError('CHAT_CONFIG_BUSY', 'Configuration cannot change while the conversation is unloaded, working or waiting for an answer.', 'Wait for the current turn to finish.');
    const option = this.configuration?.configOptions?.find(option => option.id === configId);
    const values = option?.type === 'select' ? option.options.flatMap(entry => 'group' in entry ? entry.options.map(choice => choice.value) : [entry.value]) : [];
    if (!values.includes(value)) throw new PaneError('CHAT_CONFIG_UNSUPPORTED', 'The adapter did not advertise this configuration choice. Nothing changed.', 'Choose one of the current advertised options.');
    this.configuring = true;
    this.options.onState?.();
    try {
    const result = await this.bounded(this.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId, value }));
    if (this.configuration) this.configuration = { ...this.configuration, configOptions: result.configOptions };
    if (result.configOptions.find(option => option.id === configId)?.currentValue !== value) throw new PaneError('CHAT_CONFIG_UNCONFIRMED', 'The adapter did not confirm the requested setting.', 'Refresh its configuration before continuing.');
    } finally { this.configuring = false; this.options.onState?.(); }
  }

  controls(): AgentChatConfigOption[] {
    return (this.configuration?.configOptions ?? []).flatMap(option => option.type === 'select' ? [{ id: option.id, name: option.name, currentValue: option.currentValue, options: option.options.flatMap(entry => 'group' in entry ? entry.options : [entry]).map(choice => ({ value: choice.value, name: choice.name })) }] : []);
  }

  config(): LoadSessionResponse | NewSessionResponse | undefined { return structuredClone(this.configuration); }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PaneError('CHAT_ADAPTER_TIMEOUT', 'The adapter did not respond in time. Its ownership is not assumed released.', 'Inspect the stopped conversation before retrying.')), this.options.requestTimeoutMs ?? 30_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private withdrawPermissions(): void {
    for (const entry of this.pending.values()) entry.resolve({ outcome: { outcome: 'cancelled' } });
    this.pending.clear();
    this.options.onState?.();
  }

  async cancel(): Promise<void> {
    this.withdrawPermissions();
    if (this.sessionId && !this.disconnected) await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.disconnected) return;
    try {
      if (this.sessionId && this.initialization?.agentCapabilities?.sessionCapabilities?.close) {
        await this.bounded(this.connection.agent.request(methods.agent.session.close, { sessionId: this.sessionId }));
      }
    } finally {
      this.withdrawPermissions();
      this.connection.close();
    }
  }
}
