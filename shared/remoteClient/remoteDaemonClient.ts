import type { ParsedSseEvent } from '../sseParser';
import {
  decodeRemoteDaemonEventEnvelope,
  decodeRemoteHeartbeatPayload,
  type RemoteDaemonEventEnvelope,
  type RemoteDaemonHeartbeatPayload,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionStatus,
} from '../types/remoteDaemon';
import { boundary, decodeBoundary, type JsonValue } from '../validation/boundaryDecoder';

// Structural fetch types, so browser fetch, Node fetch and `expo/fetch` all fit.
export interface RemoteFetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  cache?: 'no-store';
}

interface RemoteByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
}

export interface RemoteFetchResponse {
  ok: boolean;
  status: number;
  body: { getReader(): RemoteByteStreamReader } | null;
  json(): Promise<JsonValue>;
}

export type RemoteFetch = (url: string, init?: RemoteFetchInit) => Promise<RemoteFetchResponse>;

export interface RemoteRequestContext {
  baseUrl: string;
  token: string;
  runtimeId: string;
  clientLabel: string;
}

export interface RemoteEventStreamContext extends RemoteRequestContext {
  signal: AbortSignal;
  /** Call once the host accepted the stream. */
  onOpen(): void;
  onEvent(event: ParsedSseEvent): void;
}

/**
 * How requests carry credentials and how the event stream is read. The
 * stream promise settles when the stream ends or fails; it rejects with
 * `RemoteAuthError` when the host rejects the token.
 */
export interface RemoteDaemonTransport {
  invokeRequest(context: RemoteRequestContext, channel: string, args: unknown[]): {
    headers: Record<string, string>;
    body: string;
  };
  openEventStream(context: RemoteEventStreamContext): Promise<void>;
}

export type RemoteDaemonClientEvent =
  | { type: 'ready'; timestamp: string }
  | { type: 'heartbeat'; payload: RemoteDaemonHeartbeatPayload }
  | { type: 'daemon-event'; payload: RemoteDaemonEventEnvelope };

export interface RemoteDaemonConnectionState {
  status: RemotePaneConnectionStatus;
  lastError: string | null;
  lastSeenAt: string | null;
}

export interface RemoteDaemonClientOptions {
  profile: RemotePaneConnectionProfile;
  transport: RemoteDaemonTransport;
  /** Stable per-install ID; see `getOrCreateRuntimeId`. */
  runtimeId: () => string | Promise<string>;
  clientLabel: string;
  fetch?: RemoteFetch;
  /**
   * Reconnect when the stream delivers nothing (the host sends a heartbeat
   * every 5 s) for this long. Mobile networks drop idle sockets without an
   * error, so native clients should set it. Off by default.
   */
  staleStreamTimeoutMs?: number;
}

/** The host rejected the connection code. Retrying cannot help. */
export class RemoteAuthError extends Error {
  override name = 'RemoteAuthError';
}

/** The host answered with an error that retrying cannot fix. */
export class RemoteRequestError extends Error {
  override name = 'RemoteRequestError';

  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
  }
}

/** A mutation failed in transit, so the host may or may not have applied it. */
export class RemoteUnconfirmedResultError extends Error {
  override name = 'RemoteUnconfirmedResultError';
}

const invokeResponseSchema = boundary.union(
  boundary.object({
    ok: boundary.literal(true),
    result: boundary.optional(boundary.json),
  }),
  boundary.object({
    ok: boundary.literal(false),
    error: boundary.optional(boundary.object({
      message: boundary.optional(boundary.string),
      code: boundary.optional(boundary.string),
    })),
  }),
);

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEALTH_CHECK_ATTEMPTS = 5;
const INVOKE_ATTEMPTS = 4;
const REQUEST_RETRY_DELAY_MS = 2_000;

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

/** Platform-neutral client for a Pane daemon's HTTP + SSE API. */
export class RemoteDaemonClient {
  readonly profile: RemotePaneConnectionProfile;
  private readonly transport: RemoteDaemonTransport;
  private readonly fetch: RemoteFetch;
  private readonly clientLabel: string;
  private readonly resolveRuntimeId: () => string | Promise<string>;
  private readonly staleStreamTimeoutMs: number | undefined;
  private runtimeId: string | null = null;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private eventListeners = new Set<(event: RemoteDaemonClientEvent) => void>();
  private statusListeners = new Set<(state: RemoteDaemonConnectionState) => void>();
  private state: RemoteDaemonConnectionState = {
    status: 'local',
    lastError: null,
    lastSeenAt: null,
  };

  constructor(options: RemoteDaemonClientOptions) {
    this.profile = options.profile;
    this.transport = options.transport;
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.clientLabel = options.clientLabel;
    this.resolveRuntimeId = options.runtimeId;
    this.staleStreamTimeoutMs = options.staleStreamTimeoutMs;
  }

  getState(): RemoteDaemonConnectionState {
    return { ...this.state };
  }

  onEvent(listener: (event: RemoteDaemonClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (state: RemoteDaemonConnectionState) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getState());
    return () => this.statusListeners.delete(listener);
  }

  /** Waits for the health check, then opens the event stream in the background. */
  async connect(): Promise<void> {
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.reconnectAttempt = 0;
    this.setState({ status: 'connecting', lastError: null });

    await this.checkHealth(this.abortController.signal);
    void this.openEventStream(this.abortController.signal);
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.abortController = null;
    this.reconnectAttempt = 0;
    this.setState({ status: 'local', lastError: null });
  }

  async invoke<T = unknown>(channel: string, args: unknown[] = []): Promise<T> {
    let lastError: Error | null = null;
    const signal = this.abortController?.signal;
    const retryableRead = RETRYABLE_READ_CHANNELS.has(channel);
    const attempts = retryableRead ? INVOKE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { headers, body } = this.transport.invokeRequest(await this.requestContext(), channel, args);
        const request: RemoteFetchInit = { method: 'POST', headers, body };
        if (signal) {
          request.signal = signal;
        }

        const response = await this.fetch(this.endpoint('invoke'), request);

        const payload = decodeBoundary(await response.json().catch((cause: Error) => {
          if (isAuthFailureResponse(response.status)) {
            throw new RemoteAuthError(getRemoteAuthFailureMessage());
          }
          throw cause;
        }), invokeResponseSchema);
        if (isAuthFailureResponse(response.status)) {
          throw new RemoteAuthError(getRemoteAuthFailureMessage(!payload?.ok ? payload?.error?.message : undefined));
        }
        if (response.ok && payload.ok) {
          // SAFETY: The named IPC/API channel contract establishes this response payload type.
          return payload.result as T;
        }

        const message = payload.ok
          ? `Remote request failed with ${response.status}`
          : payload.error?.message ?? 'Remote request failed';
        if (!isRetryableResponse(response.status)) {
          throw new RemoteRequestError(message, response.status, payload.ok ? null : payload.error?.code ?? null);
        }
        lastError = new Error(message);
      } catch (error) {
        if (error instanceof RemoteAuthError || error instanceof RemoteRequestError || signal?.aborted) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error('Remote request failed');
      }

      if (attempt < attempts) {
        await delay(REQUEST_RETRY_DELAY_MS * attempt, signal);
      }
    }

    if (!retryableRead) {
      throw new RemoteUnconfirmedResultError(
        'The remote action may have completed, but its result could not be confirmed. ' +
        'Check the current state before trying again.' +
        (lastError ? ` (${lastError.message})` : ''),
      );
    }
    throw lastError ?? new Error('Remote request failed');
  }

  private async requestContext(): Promise<RemoteRequestContext> {
    return {
      baseUrl: this.profile.baseUrl,
      token: this.profile.token,
      runtimeId: this.runtimeId ??= await this.resolveRuntimeId(),
      clientLabel: this.clientLabel,
    };
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetch(this.endpoint('health'), { signal, cache: 'no-store' });
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

    throw lastError ?? new Error('Remote health check failed');
  }

  private async openEventStream(signal: AbortSignal): Promise<void> {
    // A stale stream is cut through its own controller, so pending invokes
    // on the connection signal survive the reconnect.
    const stream = new AbortController();
    const abortStream = () => stream.abort();
    signal.addEventListener('abort', abortStream, { once: true });
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const armStaleTimer = () => {
      if (this.staleStreamTimeoutMs === undefined) return;
      if (staleTimer !== null) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        stream.abort();
        this.scheduleReconnect('Remote event stream stopped responding');
      }, this.staleStreamTimeoutMs);
    };

    try {
      await this.transport.openEventStream({
        ...await this.requestContext(),
        signal: stream.signal,
        onOpen: () => {
          if (stream.signal.aborted) return;
          armStaleTimer();
          this.reconnectAttempt = 0;
          this.setState({ status: 'connected', lastError: null, lastSeenAt: new Date().toISOString() });
        },
        onEvent: (event) => {
          if (stream.signal.aborted) return;
          armStaleTimer();
          this.handleSseEvent(event);
        },
      });

      if (!stream.signal.aborted) {
        throw new Error('Remote event stream ended');
      }
    } catch (error) {
      if (stream.signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RemoteAuthError) {
        this.setState({ status: 'error', lastError: message });
        return;
      }

      this.scheduleReconnect(message);
    } finally {
      if (staleTimer !== null) clearTimeout(staleTimer);
      signal.removeEventListener('abort', abortStream);
      stream.abort();
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
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.setState({ status: 'error', lastError: message });
      return;
    }

    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.setState({ status: 'reconnecting', lastError: message });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const controller = new AbortController();
      this.abortController = controller;
      void this.openEventStream(controller.signal);
    }, delayMs);
  }

  private endpoint(path: 'health' | 'invoke'): string {
    return `${this.profile.baseUrl}/${path}`;
  }

  private emitEvent(event: RemoteDaemonClientEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private setState(update: Partial<RemoteDaemonConnectionState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.statusListeners) {
      listener(this.getState());
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export function isAuthFailureResponse(status: number): boolean {
  return status === 401 || status === 403;
}

export function getRemoteAuthFailureMessage(serverMessage?: string): string {
  const detail = serverMessage && serverMessage !== 'Remote request failed'
    ? ` (${serverMessage})`
    : '';
  return `This connection code is not accepted by the remote host${detail}. Create and copy a new code from Pane Settings > Remote Pane, then reconnect.`;
}

function isRetryableResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(createAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
