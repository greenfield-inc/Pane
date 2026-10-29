import { decodeUpdateIntent, type RemoteUpdateIntent } from './updateIntent';
import { REMOTE_READ_CHANNELS, REMOTE_RESTORE_CHANNELS } from './readChannels';
import { RecoveryCycle } from './recoveryCycle';
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
import { RemoteInputQueue } from '../remoteInputQueue';
import { PaneError, paneErrorText } from '../paneError';

// Structural fetch types, so browser fetch, Node fetch and `expo/fetch` all fit.
interface RemoteFetchInit {
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
  /** This device's own name, such as the phone's; the host names answers from it. */
  deviceLabel?: string;
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
  updateIntent?: RemoteUpdateIntent | null;
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
  /** This device's own name, such as the phone's; the host names answers from it. */
  deviceLabel?: string;
  fetch?: RemoteFetch;
  /**
   * Reconnect when the stream delivers nothing (the host sends a heartbeat
   * every 5 s) for this long. Mobile networks drop idle sockets without an
   * error, so native clients should set it. Off by default.
   */
  staleStreamTimeoutMs?: number;
  /**
   * Schedules the client's own timers (retry delays, reconnects, the stale-stream and recovery
   * deadlines). Defaults to the global `setTimeout`. A host that replaces the globals with timers
   * that stall while idle, as the Even Hub SDK does, passes timers that keep firing.
   */
  schedule?: RemoteSchedule;
}

/** A scheduled callback that can be cancelled. */
export interface RemoteTimer {
  cancel(): void;
}

export type RemoteSchedule = (callback: () => void, ms: number) => RemoteTimer;

function scheduleWithGlobals(callback: () => void, ms: number): RemoteTimer {
  const handle = setTimeout(callback, ms);
  return { cancel: () => clearTimeout(handle) };
}

/** The host rejected the connection code. Retrying cannot help. */
export class RemoteAuthError extends Error {
  override name = 'RemoteAuthError';

  /** The host's error code, such as `ERR_WORKSPACE_PASSWORD_REQUIRED`, when it sent one. */
  constructor(message: string, readonly code: string | null = null) {
    super(message);
  }
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
      next: boundary.optional(boundary.string),
    })),
  }),
);

const HEALTH_CHECK_ATTEMPTS = 5;
const INVOKE_ATTEMPTS = 4;
const REQUEST_RETRY_DELAY_MS = 2_000;
/** A restore that has not finished by then is treated as a broken connection. */
const RESTORE_TIMEOUT_MS = 30_000;
export const RECONNECT_GAVE_UP_MESSAGE = 'Could not reconnect within five minutes. Your workspace is kept. Choose Retry now.';

/** Platform-neutral client for a Pane daemon's HTTP + SSE API. */
export class RemoteDaemonClient {
  readonly profile: RemotePaneConnectionProfile;
  private readonly transport: RemoteDaemonTransport;
  private readonly fetch: RemoteFetch;
  private readonly clientLabel: string;
  private readonly deviceLabel: string | undefined;
  private readonly resolveRuntimeId: () => string | Promise<string>;
  private readonly staleStreamTimeoutMs: number | undefined;
  private runtimeId: string | null = null;
  private abortController: AbortController | null = null;
  private reconnectTimer: RemoteTimer | null = null;
  private readonly recovery = new RecoveryCycle();
  private deadlineTimer: RemoteTimer | null = null;
  private readonly schedule: RemoteSchedule;
  private streamController: AbortController | null = null;
  private restoreListeners = new Map<(signal: AbortSignal) => Promise<void>, string>();
  private eventListeners = new Set<(event: RemoteDaemonClientEvent) => void>();
  private statusListeners = new Set<(state: RemoteDaemonConnectionState) => void>();
  private readonly inputQueue = new RemoteInputQueue(
    (channel, args, signal) => this.invokeRequest(channel, args, signal),
    // Input the host never answered means the connection is broken; a restore follows.
    () => this.scheduleReconnect('Terminal input timed out'),
  );
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
    this.deviceLabel = options.deviceLabel;
    this.resolveRuntimeId = options.runtimeId;
    this.staleStreamTimeoutMs = options.staleStreamTimeoutMs;
    this.schedule = options.schedule ?? scheduleWithGlobals;
  }

  getState(): RemoteDaemonConnectionState {
    return { ...this.state };
  }

  onEvent(listener: (event: RemoteDaemonClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Core state owners finish their reads before the connection becomes green.
   * `label` names the step in the timing logs.
   */
  onRestore(listener: (signal: AbortSignal) => Promise<void>, label = 'restore'): () => void {
    this.restoreListeners.set(listener, label);
    return () => this.restoreListeners.delete(listener);
  }

  onStatus(listener: (state: RemoteDaemonConnectionState) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.getState());
    return () => this.statusListeners.delete(listener);
  }

  /** Waits for the health check, then opens the event stream in the background. */
  async connect(): Promise<void> {
    this.suspended = false;
    this.inputQueue.cancel(new Error('Remote Pane reconnecting; pending terminal input was discarded'));
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.abortController = new AbortController();
    this.recovery.reset();
    this.clearDeadline();
    this.setState({ status: 'connecting', lastError: null });
    this.armDeadline();

    const { signal } = this.abortController;
    try {
      await this.checkHealth(signal);
    } catch (error) {
      // Leave 'connecting' so callers can see the failure and try again.
      if (!signal.aborted) {
        if (error instanceof RemoteAuthError) this.stopRecovery(error.message);
        else this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    // Backgrounded mid-handshake: `resume` opens the stream on return.
    if (!signal.aborted && !this.suspended) void this.openEventStream(signal);
  }

  disconnect(): void {
    this.inputQueue.cancel(new Error('Remote Pane disconnected; pending terminal input was discarded'));
    this.clearReconnectTimer();
    this.abortController?.abort();
    this.abortController = null;
    this.streamController?.abort();
    this.recovery.reset();
    this.clearDeadline();
    this.setState({ status: 'local', lastError: null });
  }

  private suspended = false;

  suspend(): void {
    if (this.state.status === 'local' || this.state.status === 'error') return;
    this.suspended = true;
    this.clearReconnectTimer();
    this.clearDeadline();
    this.streamController?.abort();
    this.inputQueue.cancel(new Error('The client went to sleep.'));
    this.setState({ status: 'reconnecting' });
  }

  /** Time asleep is not an outage: each return gets a fresh five minutes. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.recovery.reset();
    this.clearDeadline();
    this.retryNow();
  }

  retryNow(): void {
    if (this.suspended) return;
    if (this.state.status === 'error' || this.state.status === 'local') { void this.connect().catch(() => {}); return; }
    // Already on its way; keep its deadline armed so it cannot hang forever.
    if (this.state.status === 'restoring' || this.state.status === 'connecting') { this.armDeadline(); return; }
    this.clearReconnectTimer();
    this.streamController?.abort();
    this.armDeadline();
    if (this.abortController && !this.abortController.signal.aborted) void this.openEventStream(this.abortController.signal);
  }

  async invoke<T = unknown>(channel: string, args: unknown[] = []): Promise<T> {
    // SAFETY: The named IPC/API channel contract establishes this response payload type.
    return this.inputQueue.invoke(channel, args) as Promise<T>;
  }

  private async invokeRequest<T = unknown>(channel: string, args: unknown[], inputSignal?: AbortSignal): Promise<T> {
    if (this.state.status !== 'connected' && !REMOTE_READ_CHANNELS.has(channel) && !REMOTE_RESTORE_CHANNELS.has(channel)) {
      throw new PaneError('ERR_REMOTE_OFFLINE', 'The action was not sent while the workspace is disconnected or restoring.', 'Wait for restoration before submitting it.');
    }
    let lastError: Error | null = null;
    let dispatched = false;
    const connection = this.abortController;
    const stream = this.streamController;
    const mutation = !REMOTE_READ_CHANNELS.has(channel) && !REMOTE_RESTORE_CHANNELS.has(channel);
    const signal = inputSignal ?? connection?.signal;
    const retryableRead = REMOTE_READ_CHANNELS.has(channel);
    const attempts = retryableRead ? INVOKE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const { headers, body } = this.transport.invokeRequest(await this.requestContext(), channel, args);
        const request: RemoteFetchInit = { method: 'POST', headers, body };
        if (signal) {
          request.signal = signal;
        }

        if (mutation && (this.state.status !== 'connected' || stream !== this.streamController || stream?.signal.aborted || connection !== this.abortController)) {
          throw new PaneError('ERR_REMOTE_OFFLINE', 'The action was not sent because the connection changed before dispatch.', 'Wait for restoration before submitting it.');
        }
        if (signal?.aborted || connection !== this.abortController || connection?.signal.aborted) throw createAbortError();
        dispatched = true;
        const response = await this.fetch(this.endpoint('invoke'), request);

        const payload = decodeInvokeResponse(await response.json().catch((cause: Error) => {
          if (isAuthFailureResponse(response.status)) {
            throw new RemoteAuthError(getRemoteAuthFailureMessage());
          }
          throw cause;
        }));
        if (signal?.aborted || connection !== this.abortController || connection?.signal.aborted) throw createAbortError();
        const failure = payload?.ok === false ? payload.error : undefined;
        if (isAuthFailureResponse(response.status)) {
          throw new RemoteAuthError(getRemoteAuthFailureMessage(failure?.message, failure?.code), failure?.code ?? null);
        }
        if (response.ok && payload?.ok) {
          // SAFETY: The named IPC/API channel contract establishes this response payload type.
          return payload.result as T;
        }

        const message = payload?.ok
          ? `Remote request failed with ${response.status}`
          : paneErrorText({ message: failure?.message ?? 'Remote request failed', next: failure?.next });
        if (!isRetryableResponse(response.status)) {
          throw new RemoteRequestError(message, response.status, failure?.code ?? null);
        }
        lastError = new Error(message);
      } catch (error) {
        if (!dispatched && error instanceof PaneError && error.code === 'ERR_REMOTE_OFFLINE') throw error;
        if (error instanceof RemoteAuthError) this.stopRecovery(error.message);
        if (error instanceof RemoteAuthError || error instanceof RemoteRequestError) throw error;
        if (signal?.aborted || connection !== this.abortController || connection?.signal.aborted) {
          if (!retryableRead && dispatched) { lastError = error instanceof Error ? error : new Error('Connection changed'); break; }
          throw error;
        }
        lastError = error instanceof Error ? error : new Error('Remote request failed');
        if (this.abortController && !this.abortController.signal.aborted) this.scheduleReconnect('Remote response interrupted');
      }

      if (attempt < attempts) {
        await delay(this.schedule, REQUEST_RETRY_DELAY_MS * attempt, signal);
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
    const context: RemoteRequestContext = {
      baseUrl: this.profile.baseUrl,
      token: this.profile.token,
      runtimeId: this.runtimeId ??= await this.resolveRuntimeId(),
      clientLabel: this.clientLabel,
    };
    if (this.deviceLabel) context.deviceLabel = this.deviceLabel;
    return context;
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.fetch(this.endpoint('health'), { signal, cache: 'no-store' });
        if (isAuthFailureResponse(response.status)) throw new RemoteAuthError(getRemoteAuthFailureMessage());
        if (response.ok) {
          return;
        }
        lastError = new Error(`Remote health check failed with ${response.status}`);
      } catch (error) {
        if (signal.aborted || error instanceof RemoteAuthError) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error('Remote health check failed');
      }

      if (attempt < HEALTH_CHECK_ATTEMPTS) {
        await delay(this.schedule, REQUEST_RETRY_DELAY_MS * attempt, signal);
      }
    }

    throw lastError ?? new Error('Remote health check failed');
  }

  private async openEventStream(signal: AbortSignal): Promise<void> {
    // A stale stream is cut through its own controller, so pending invokes
    // on the connection signal survive the reconnect.
    if (signal.aborted) return;
    this.streamController?.abort();
    const stream = new AbortController();
    this.streamController = stream;
    let ready = false;
    const abortStream = () => stream.abort();
    signal.addEventListener('abort', abortStream, { once: true });
    let staleTimer: RemoteTimer | null = null;
    const cancelStaleTimer = () => staleTimer?.cancel();
    const armStaleTimer = () => {
      cancelStaleTimer();
      staleTimer = this.schedule(() => {
        if (stream.signal.aborted) return;
        stream.abort();
        this.scheduleReconnect('Remote event stream stopped responding');
      }, this.staleStreamTimeoutMs ?? 20_000);
    };

    try {
      const context = await this.requestContext();
      // Armed before the request too, so a fetch that hangs before headers is cut.
      armStaleTimer();
      await this.transport.openEventStream({
        ...context,
        signal: stream.signal,
        onOpen: () => {
          if (stream.signal.aborted) return;
          armStaleTimer();
          // HTTP acceptance is not restoration; wait for the ready event.
        },
        onEvent: (event) => {
          if (stream.signal.aborted) return;
          armStaleTimer();
          if (event.event === 'ready') {
            if (ready) return;
            ready = true;
            this.setState({ status: 'restoring', lastError: null });
            this.handleSseEvent(event);
            void this.restore(stream.signal).then(() => {
              if (stream.signal.aborted || signal.aborted) return;
              this.recovery.reset();
              this.clearDeadline();
              this.setState({ status: 'connected', lastError: null });
              if (this.state.updateIntent) this.setState({ updateIntent: null });
            }, error => {
              if (!stream.signal.aborted && !signal.aborted) this.scheduleReconnect(error instanceof Error ? error.message : 'Workspace restoration failed');
            });
          } else this.handleSseEvent(event);
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
        this.stopRecovery(message);
        return;
      }

      this.scheduleReconnect(message);
    } finally {
      cancelStaleTimer();
      signal.removeEventListener('abort', abortStream);
      stream.abort();
    }
  }

  /** Runs every restore listener, timing each, and fails if they outlast `RESTORE_TIMEOUT_MS`. */
  private async restore(signal: AbortSignal): Promise<void> {
    const started = Date.now();
    const pending = new Set<string>();
    const steps = [...this.restoreListeners].map(async ([listener, label]) => {
      pending.add(label);
      await listener(signal);
      pending.delete(label);
      console.info(`[remote] restore step ${label} took ${Date.now() - started} ms`);
    });
    let expire!: (error: Error) => void;
    const timeout = new Promise<never>((_, reject) => { expire = reject; });
    const timer = this.schedule(() => expire(new Error(
      `Workspace restoration did not finish within ${RESTORE_TIMEOUT_MS / 1000} s (waiting on ${[...pending].join(', ')})`,
    )), RESTORE_TIMEOUT_MS);
    try {
      await Promise.race([Promise.all(steps), timeout]);
    } finally {
      timer.cancel();
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
      const updateIntent = payload.channel === 'remote:update-intent' ? decodeUpdateIntent(payload.args[0]) : undefined;
      this.setState({ lastSeenAt: payload.timestamp });
      if (updateIntent) this.setState({ updateIntent });
      this.emitEvent({ type: 'daemon-event', payload });
      return;
    }

    if (event.event === 'ready') {
      const now = new Date().toISOString();
      this.setState({ lastSeenAt: now });
      this.emitEvent({ type: 'ready', timestamp: now });
    }
  }

  private clearDeadline(): void {
    this.deadlineTimer?.cancel();
    this.deadlineTimer = null;
  }

  private armDeadline(): void {
    this.deadlineTimer ??= this.schedule(() => this.stopRecovery(RECONNECT_GAVE_UP_MESSAGE), this.recovery.remainingMs);
  }

  private stopRecovery(message: string): void {
    this.clearReconnectTimer();
    this.clearDeadline();
    this.abortController?.abort();
    this.streamController?.abort();
    this.setState({ status: 'error', lastError: message });
  }

  private scheduleReconnect(message: string): void {
    if (this.suspended || !this.abortController || this.abortController.signal.aborted || this.reconnectTimer !== null) return;
    this.streamController?.abort();
    this.inputQueue.cancel(new RemoteUnconfirmedResultError('Delivery unknown: input may have reached the host. Check it before trying again.'));
    this.armDeadline();
    const delayMs = this.recovery.nextDelay();
    if (delayMs === null) {
      this.stopRecovery(RECONNECT_GAVE_UP_MESSAGE);
      return;
    }
    this.setState({ status: 'reconnecting', lastError: message });
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      if (!this.abortController || this.abortController.signal.aborted) return;
      if (!this.recovery.remainingMs) { this.stopRecovery(RECONNECT_GAVE_UP_MESSAGE); return; }
      void this.openEventStream(this.abortController.signal);
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
    const previous = this.state.status;
    this.state = { ...this.state, ...update };
    if (this.state.status !== previous) {
      console.info(`[remote] ${new Date().toISOString()} ${previous} -> ${this.state.status}${this.state.lastError ? ` (${this.state.lastError})` : ''}`);
    }
    for (const listener of this.statusListeners) {
      listener(this.getState());
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.reconnectTimer.cancel();
      this.reconnectTimer = null;
    }
  }
}

export function isAuthFailureResponse(status: number): boolean {
  return status === 401 || status === 403;
}

export function getRemoteAuthFailureMessage(serverMessage?: string, code?: string | null): string {
  // A codeless host explains itself (wrong login, password needed); no code is involved.
  if (code?.startsWith('ERR_WORKSPACE_') && serverMessage) return serverMessage;
  const detail = serverMessage && serverMessage !== 'Remote request failed'
    ? ` (${serverMessage})`
    : '';
  return `This connection code is not accepted by the remote host${detail}. Create a new code in Pane Settings > Remote Access > Set Up Host, then reconnect.`;
}

/** Returns null for a body that is not an invoke envelope, such as a proxy's error page JSON. */
function decodeInvokeResponse(body: JsonValue) {
  try {
    return decodeBoundary(body, invokeResponseSchema);
  } catch {
    return null;
  }
}

function isRetryableResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function delay(schedule: RemoteSchedule, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeout = schedule(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      timeout.cancel();
      reject(createAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
