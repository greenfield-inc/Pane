import { PaneSseParser, type ParsedSseEvent } from '../../../../shared/sseParser';
import {
  decodeRemoteDaemonEventEnvelope,
  decodeRemoteHeartbeatPayload,
  type RemoteDaemonEventEnvelope,
  type RemoteDaemonHeartbeatPayload,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionStatus,
} from '../../../../shared/types/remoteDaemon';
import { RemoteInputQueue } from '../../../../shared/remoteInputQueue';

type RemoteBrowserEvent =
  | { type: 'ready'; timestamp: string }
  | { type: 'heartbeat'; payload: RemoteDaemonHeartbeatPayload }
  | { type: 'daemon-event'; payload: RemoteDaemonEventEnvelope };

type RemoteBrowserEventListener = (event: RemoteBrowserEvent) => void;
type RemoteStatusListener = (status: RemoteBrowserConnectionState) => void;

export interface RemoteBrowserConnectionState {
  status: RemotePaneConnectionStatus;
  lastError: string | null;
  lastSeenAt: string | null;
}

interface InvokeSuccessPayload<T> {
  ok: true;
  result: T;
}

interface InvokeErrorPayload {
  ok: false;
  error?: {
    message?: string;
    code?: string;
  };
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEALTH_CHECK_ATTEMPTS = 5;
const INVOKE_ATTEMPTS = 4;
const REQUEST_RETRY_DELAY_MS = 2_000;
const RUNTIME_ID_STORAGE_KEY = 'pane.remotePwa.runtimeId';

// Retry only reviewed reads. A command name or runtime ID cannot prove that
// replaying it is safe after the host applied it but its response was lost.
const RETRYABLE_READ_CHANNELS = new Set([
  'sessions:get-all-with-projects',
  'sessions:get',
  'panels:list',
  'panels:getActive',
  'panels:checkInitialized',
  'panels:get-output',
  'projects:list-branches',
  'projects:detect-branch',
  'remote:pwa-affordances',
  'mobile:push-status',
]);

export class RemoteDaemonBrowserClient {
  private abortController: AbortController | null = null;
  private eventSource: EventSource | null = null;
  private eventSourceAbortCleanup: (() => void) | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private eventListeners = new Set<RemoteBrowserEventListener>();
  private statusListeners = new Set<RemoteStatusListener>();
  private readonly inputQueue = new RemoteInputQueue((channel, args, signal) =>
    this.invokeRequest(channel, args, signal));
  private state: RemoteBrowserConnectionState = {
    status: 'local',
    lastError: null,
    lastSeenAt: null,
  };

  constructor(private readonly profile: RemotePaneConnectionProfile) {}

  getState(): RemoteBrowserConnectionState {
    return { ...this.state };
  }

  onEvent(listener: RemoteBrowserEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: RemoteStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getState());
    return () => this.statusListeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.inputQueue.cancel(new Error('Remote Pane reconnecting; pending terminal input was discarded'));
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.closeEventSource();
    this.abortController = new AbortController();
    this.reconnectAttempt = 0;
    this.setState({ status: 'connecting', lastError: null });

    await this.checkHealth(this.abortController.signal);
    this.openEventStream(this.abortController.signal);
  }

  disconnect(): void {
    this.inputQueue.cancel(new Error('Remote Pane disconnected; pending terminal input was discarded'));
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.closeEventSource();
    this.abortController = null;
    this.reconnectAttempt = 0;
    this.setState({ status: 'local', lastError: null });
  }

  async invoke<T = unknown>(channel: string, args: unknown[] = []): Promise<T> {
    // SAFETY: The named IPC/API channel contract establishes this response payload type.
    return this.inputQueue.invoke(channel, args) as Promise<T>;
  }

  private async invokeRequest<T = unknown>(channel: string, args: unknown[], inputSignal?: AbortSignal): Promise<T> {
    let lastError: Error | null = null;
    const signal = inputSignal ?? this.abortController?.signal;
    const retryableRead = RETRYABLE_READ_CHANNELS.has(channel);
    const attempts = retryableRead ? INVOKE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const runtimeId = getRuntimeId();
        const clientLabel = getClientLabel();
        const request: RequestInit = {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.profile.token}`,
            'Content-Type': 'text/plain;charset=UTF-8',
          },
          body: JSON.stringify({
            channel,
            args,
            token: this.profile.token,
            runtimeId,
            clientLabel,
          }),
        };
        if (signal) {
          request.signal = signal;
        }

        const response = await fetch(this.endpoint('invoke'), {
          ...request,
        });

        // SAFETY: The named IPC/API channel contract establishes this response payload type.
        const payload = await response.json().catch((cause: unknown) => {
          if (isAuthFailureResponse(response.status)) {
            throw new RemoteAuthInvalidError(getRemoteAuthFailureMessage());
          }
          throw cause;
        }) as InvokeSuccessPayload<T> | InvokeErrorPayload;
        if (isAuthFailureResponse(response.status)) {
          throw new RemoteAuthInvalidError(getRemoteAuthFailureMessage(!payload?.ok ? payload?.error?.message : undefined));
        }
        if (response.ok && payload.ok) {
          return payload.result;
        }

        const message = payload.ok
          ? `Remote request failed with ${response.status}`
          : payload.error?.message ?? 'Remote request failed';
        if (!isRetryableResponse(response.status)) {
          throw new NonRetryableRemoteError(message);
        }
        lastError = new Error(message);
      } catch (error) {
        if (error instanceof RemoteAuthInvalidError || error instanceof NonRetryableRemoteError || signal?.aborted) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error('Remote request failed');
      }

      if (attempt < attempts) {
        await delay(REQUEST_RETRY_DELAY_MS * attempt, signal);
      }
    }

    if (!retryableRead) {
      throw new Error(
        'The remote action may have completed, but its result could not be confirmed. ' +
        'Check the current state before trying again.' +
        (lastError ? ` (${lastError.message})` : ''),
      );
    }
    throw lastError ?? new Error('Remote request failed');
  }

  createDeepgramStreamingSocket(): WebSocket {
    return new WebSocket(this.websocketEndpoint('voice/deepgram-stream', {
      access_token: this.profile.token,
      runtime_id: getRuntimeId(),
      client_label: getClientLabel(),
    }));
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(this.endpoint('health'), { signal, cache: 'no-store' });
        if (response.ok) {
          return;
        }
        lastError = new Error(`Remote health check failed with ${response.status}`);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error('Remote health check failed');
      }

      if (attempt < HEALTH_CHECK_ATTEMPTS) {
        await delay(REQUEST_RETRY_DELAY_MS * attempt, signal);
      }
    }

    throw this.createHealthCheckError(lastError);
  }

  private async openEventStream(signal: AbortSignal): Promise<void> {
    try {
      if (globalThis.EventSource !== undefined) {
        await this.assertEventStreamAuthenticated(signal);
        this.openNativeEventSource(signal);
        return;
      }

      const response = await fetch(this.eventStreamEndpoint(), {
        signal,
      });

      if (isAuthFailureResponse(response.status)) {
        throw new RemoteAuthInvalidError(getRemoteAuthFailureMessage());
      }

      if (!response.ok || !response.body) {
        throw new Error(`Remote event stream failed with ${response.status}`);
      }

      this.reconnectAttempt = 0;
      this.setState({ status: 'connected', lastError: null, lastSeenAt: new Date().toISOString() });
      await this.consumeEventStream(response.body, signal);

      if (!signal.aborted) {
        throw new Error('Remote event stream ended');
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RemoteAuthInvalidError) {
        this.closeEventSource();
        this.setState({ status: 'error', lastError: message });
        return;
      }

      this.scheduleReconnect(message);
    }
  }

  private async assertEventStreamAuthenticated(signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();

    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    signal.addEventListener('abort', abort, { once: true });

    try {
      const response = await fetch(this.eventStreamAuthCheckEndpoint(), {
        signal: controller.signal,
        cache: 'no-store',
      });

      if (isAuthFailureResponse(response.status)) {
        throw new RemoteAuthInvalidError(getRemoteAuthFailureMessage());
      }

      if (!response.ok) {
        throw new Error(`Remote event stream failed with ${response.status}`);
      }
    } finally {
      controller.abort();
      signal.removeEventListener('abort', abort);
    }
  }

  private openNativeEventSource(signal: AbortSignal): void {
    this.closeEventSource();

    const eventSource = new EventSource(this.eventStreamEndpoint());
    this.eventSource = eventSource;

    const closeOnAbort = () => {
      if (this.eventSource === eventSource) {
        this.closeEventSource();
      } else {
        eventSource.close();
      }
    };

    eventSource.onopen = () => {
      if (signal.aborted || this.eventSource !== eventSource) {
        return;
      }

      this.reconnectAttempt = 0;
      this.setState({ status: 'connected', lastError: null, lastSeenAt: new Date().toISOString() });
    };

    eventSource.addEventListener('ready', (event) => {
      this.handleNativeSseEvent('ready', event, signal, eventSource);
    });
    eventSource.addEventListener('heartbeat', (event) => {
      this.handleNativeSseEvent('heartbeat', event, signal, eventSource);
    });
    eventSource.addEventListener('daemon-event', (event) => {
      this.handleNativeSseEvent('daemon-event', event, signal, eventSource);
    });

    eventSource.onerror = () => {
      if (signal.aborted || this.eventSource !== eventSource) {
        return;
      }

      this.closeEventSource();
      this.scheduleReconnect('Remote event stream failed');
    };

    if (signal.aborted) {
      closeOnAbort();
      return;
    }

    signal.addEventListener('abort', closeOnAbort, { once: true });
    this.eventSourceAbortCleanup = () => {
      signal.removeEventListener('abort', closeOnAbort);
    };
  }

  private eventStreamEndpoint(): string {
    return this.endpoint('events', {
      access_token: this.profile.token,
      runtime_id: getRuntimeId(),
      client_label: getClientLabel(),
    });
  }

  private eventStreamAuthCheckEndpoint(): string {
    return this.endpoint('events', {
      access_token: this.profile.token,
      runtime_id: getRuntimeId(),
      client_label: getClientLabel(),
      auth_check: '1',
    });
  }

  private handleNativeSseEvent(
    eventName: string,
    event: MessageEvent,
    signal: AbortSignal,
    eventSource: EventSource,
  ): void {
    if (signal.aborted || this.eventSource !== eventSource) {
      return;
    }

    this.handleSseEvent({ event: eventName, data: String(event.data ?? '') });
  }

  private async consumeEventStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const parser = new PaneSseParser();

    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }

        const events = parser.push(decoder.decode(value, { stream: true }));

        for (const event of events) {
          this.handleSseEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleSseEvent(event: ParsedSseEvent): void {
    if (event.event === 'heartbeat') {
      const payload = decodeRemoteHeartbeatPayload(JSON.parse(event.data));
      this.setState({ lastSeenAt: payload.timestamp });
      this.emitEvent({ type: 'heartbeat', payload });
      return;
    }

    if (event.event === 'daemon-event') {
      const payload = decodeRemoteDaemonEventEnvelope(JSON.parse(event.data));
      this.setState({ lastSeenAt: payload.timestamp });
      this.emitEvent({ type: 'daemon-event', payload });
      return;
    }

    if (event.event === 'ready') {
      const now = new Date().toISOString();
      this.setState({ status: 'connected', lastError: null, lastSeenAt: now });
      this.emitEvent({ type: 'ready', timestamp: now });
    }
  }

  private scheduleReconnect(message: string): void {
    this.inputQueue.cancel(new Error(message));
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setState({ status: 'error', lastError: message });
      return;
    }

    this.reconnectAttempt += 1;
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.setState({ status: 'reconnecting', lastError: message });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const controller = new AbortController();
      this.abortController = controller;
      void this.openEventStream(controller.signal);
    }, delay);
  }

  private endpoint(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.profile.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private websocketEndpoint(path: string, params?: Record<string, string>): string {
    const url = new URL(this.endpoint(path, params));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  private emitEvent(event: RemoteBrowserEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private setState(update: Partial<RemoteBrowserConnectionState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.statusListeners) {
      listener(this.getState());
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeEventSource(): void {
    this.eventSourceAbortCleanup?.();
    this.eventSourceAbortCleanup = null;
    this.eventSource?.close();
    this.eventSource = null;
  }

  private createHealthCheckError(error: Error | null): Error {
    if (error instanceof Error && isNetworkFailure(error) && isTailscaleUrl(this.profile.baseUrl)) {
      const hostname = getUrlHostname(this.profile.baseUrl);
      return new Error(
        `Safari could not reach the Tailscale host${hostname ? ` ${hostname}` : ''}. ` +
        'Open Tailscale on this device, confirm it is connected to the same tailnet, then retry. ' +
        'If this only fails in Safari or a Home Screen app, temporarily disable iCloud Private Relay and Limit IP Address Tracking for this network.',
      );
    }

    return error ?? new Error('Remote health check failed');
  }
}

function getRuntimeId(): string {
  const existing = window.localStorage.getItem(RUNTIME_ID_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.() ?? `remote-pwa-${Date.now().toString(36)}`;
  window.localStorage.setItem(RUNTIME_ID_STORAGE_KEY, generated);
  return generated;
}

function getClientLabel(): string {
  const platform = navigator.platform || 'Browser';
  return `Pane PWA on ${platform}`;
}

function isRetryableResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isAuthFailureResponse(status: number): boolean {
  return status === 401 || status === 403;
}

function getRemoteAuthFailureMessage(serverMessage?: string): string {
  const detail = serverMessage && serverMessage !== 'Remote request failed'
    ? ` (${serverMessage})`
    : '';
  return `This connection code is not accepted by the remote host${detail}. Create and copy a new code from Pane Settings > Remote Pane, then reconnect.`;
}

class NonRetryableRemoteError extends Error {}

class RemoteAuthInvalidError extends Error {}

function isNetworkFailure(error: Error): boolean {
  return error.name === 'TypeError' || /fetch|load|network/i.test(error.message);
}

function isTailscaleUrl(value: string): boolean {
  return getUrlHostname(value)?.endsWith('.ts.net') ?? false;
}

function getUrlHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
