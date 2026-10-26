import { decodeUpdateIntent } from '../../../../shared/remoteClient/updateIntent';
import { EventEmitter } from 'events';
import { lookup as defaultLookup, Resolver } from 'dns';
import http, { type IncomingMessage, type RequestOptions } from 'http';
import https from 'https';
import { isIP, type LookupFunction } from 'net';
import { hostname as getOsHostname } from 'os';
import WebSocket, { type ClientOptions } from 'ws';
import { Readable } from 'stream';
import { noopPaneEventSink, type PaneEventSink } from '../../core/eventSink';
import type { ConfigManager } from '../../services/configManager';
import type { AnalyticsManager } from '../../services/analyticsManager';
import { getRemoteFailureCategory, trackRemotePaneEvent } from '../../services/remoteAnalytics';
import { isPaneDaemonEventChannel } from '../server';
import {
  createDefaultRemotePaneConnectionState,
  normalizeRemoteDaemonConfig,
  type RemoteDaemonHeartbeatPayload,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionState,
  type RemotePaneConnectionStatus,
} from '../../../../shared/types/remoteDaemon';
import type { RemoteDaemonEventEnvelope } from '../../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { BoundarySchema, JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { PaneSseParser } from './sseParser';
import { RemoteInputQueue } from '../../../../shared/remoteInputQueue';
import { decodeListeningPortsSnapshot, type ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import { localTargetOf } from '../../../../shared/utils/browserUrl';
import { createPortTunnel, type PortTunnel } from './portTunnel';
import { REMOTE_READ_CHANNELS, REMOTE_RESTORE_CHANNELS } from '../../../../shared/remoteClient/readChannels';
import { RecoveryCycle } from '../../../../shared/remoteClient/recoveryCycle';
import { PaneError } from '../../../../shared/paneError';
import type {
  RemoteConnectionCheck,
  RemoteConnectionCheckRow,
  RemoteConnectionCheckStage,
} from '../../../../shared/types/remoteDaemon';
import type { RemotePaneFailedCheck } from '../../services/remoteAnalytics';
import { lookupTailnetMachine, probeWorkspace, readTailscaleStatus } from '../../services/tailnetMachines';
import { listSshConfigHosts } from '../../services/sshConfigHosts';
import {
  addressOf,
  copyCommandRow,
  initialRows,
  probeHost,
  routeOf,
  runSshCommand,
  versionRow,
  type ConnectionCheckDependencies,
} from './connectionChecks';

interface RemoteConnectionStateMetadata {
  lastSeenAt?: string | null;
  /** The host's Pane version from its ready event; absent before ready and from older hosts. */
  hostVersion?: string;
}

interface RemotePaneClientOptions {
  eventSink?: PaneEventSink;
  initialHandshakeTimeoutMs?: number;
  heartbeatStaleTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectDurationMs?: number;
  onConnectionStateChange?: (
    status: RemotePaneConnectionStatus,
    errorMessage?: string | null,
    metadata?: RemoteConnectionStateMetadata,
  ) => void;
  onResyncRequired?: () => void | Promise<void>;
}

interface RemotePaneClientConnectOptions {
  retryOnInitialFailure?: boolean;
  resolveOnReady?: boolean;
}

interface RemoteInvokeSuccessPayload {
  ok: true;
  result?: JsonValue;
}

interface RemoteInvokeErrorPayload {
  ok: false;
  error: {
    message: string;
    code?: string;
    next?: string;
  };
}

type RemoteInvokeResponsePayload = RemoteInvokeSuccessPayload | RemoteInvokeErrorPayload;

interface JsonResponse {
  statusCode: number;
  body: string;
}

interface RemoteReadyEventPayload {
  replay: 'none';
  resync: 'refetch-state-after-reconnect';
  timestamp: string;
  paneVersion?: string;
}

const remoteInvokeResponseSchema: BoundarySchema<RemoteInvokeResponsePayload> = boundary.union(
  boundary.object({
    ok: boundary.literal(true),
    result: boundary.optional(boundary.json),
  }),
  boundary.object({
    ok: boundary.literal(false),
    error: boundary.object({
      message: boundary.string,
      code: boundary.optional(boundary.string),
      next: boundary.optional(boundary.string),
    }),
  }),
);
const remoteErrorResponseSchema = boundary.object({
  error: boundary.object({ message: boundary.string }),
});
const remoteReadyEventSchema: BoundarySchema<RemoteReadyEventPayload> = boundary.object({
  replay: boundary.literal('none'),
  resync: boundary.literal('refetch-state-after-reconnect'),
  timestamp: boundary.string,
  paneVersion: boundary.optional(boundary.string),
});
const remoteHeartbeatSchema: BoundarySchema<RemoteDaemonHeartbeatPayload> = boundary.object({
  timestamp: boundary.nonEmptyString,
});
const remoteEventEnvelopeSchema: BoundarySchema<RemoteDaemonEventEnvelope> = boundary.object({
  channel: boundary.string,
  args: boundary.array(boundary.json),
  timestamp: boundary.string,
});

const REMOTE_DAEMON_RECONNECT_INITIAL_DELAY_MS = 1_000;
const REMOTE_DAEMON_RECONNECT_MAX_DELAY_MS = 30_000;
const REMOTE_DAEMON_HEARTBEAT_STALE_TIMEOUT_MS = 20_000;
const REMOTE_DAEMON_INITIAL_HANDSHAKE_TIMEOUT_MS = 10_000;
const TAILSCALE_MAGIC_DNS_SERVER = '100.100.100.100';
const PORTS_LIST_CHANNEL = 'ports:list';
const PORTS_CHANGED_CHANNEL = 'ports:changed';
/** How a host's command registry refuses a command it does not have (`commandRegistry.ts`). */
const UNKNOWN_COMMAND_MESSAGE = 'No Pane daemon command registered';
const PORTS_LIST_RETRY_MS = 5_000;
// These view/flow-control operations restore a terminal without submitting work.
const REMOTE_RUNTIME_ID = createRemoteRuntimeId();
const MEDIA_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control',
  'x-content-type-options', 'content-security-policy',
  'access-control-allow-origin', 'access-control-expose-headers',
] as const;
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const CONNECTION_CHECK_TIMEOUT_MS = 5_000;
/** What a reverse proxy such as Tailscale Serve answers when nothing listens behind it. */
const PROXY_BACKEND_DOWN_STATUSES = new Set([502, 503, 504]);

export type HostHealthCheck =
  | { kind: 'running'; elapsedMs: number }
  | { kind: 'not-running'; elapsedMs: number; detail: string }
  | { kind: 'unreachable'; detail: string };

type RemoteRequestOptions = RequestOptions & {
  servername?: string;
};

export class RemotePaneClient {
  private readonly normalizedBaseUrl: URL;
  private readonly eventSink: PaneEventSink;
  private readonly initialHandshakeTimeoutMs: number;
  private readonly heartbeatStaleTimeoutMs: number;
  private readonly recovery: RecoveryCycle;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private recoveryStopped = false;
  private readonly onConnectionStateChange?: (
    status: RemotePaneConnectionStatus,
    errorMessage?: string | null,
    metadata?: RemoteConnectionStateMetadata,
  ) => void;
  private readonly onResyncRequired?: () => void | Promise<void>;
  private eventParser = new PaneSseParser();
  private eventRequest: http.ClientRequest | null = null;
  private eventResponse: IncomingMessage | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatStaleTimer: NodeJS.Timeout | null = null;
  private lastSeenAt: string | null = null;
  private closedByClient = false;
  /** Set while the system sleeps: no stream, heartbeat or reconnect until resume(). */
  private suspended = false;
  /** Bumped per stream and on suspend; callbacks from an older stream are ignored. */
  private streamGeneration = 0;
  private readonly inputQueue = new RemoteInputQueue((channel, args, signal) =>
    this.invokeRequest(channel, args, signal));

  constructor(
    readonly profile: RemotePaneConnectionProfile,
    options: RemotePaneClientOptions = {},
  ) {
    this.normalizedBaseUrl = normalizeBaseUrl(profile.baseUrl);
    this.eventSink = options.eventSink ?? noopPaneEventSink;
    this.initialHandshakeTimeoutMs = options.initialHandshakeTimeoutMs
      ?? REMOTE_DAEMON_INITIAL_HANDSHAKE_TIMEOUT_MS;
    this.heartbeatStaleTimeoutMs = options.heartbeatStaleTimeoutMs
      ?? REMOTE_DAEMON_HEARTBEAT_STALE_TIMEOUT_MS;
    this.recovery = new RecoveryCycle(Math.random, options.reconnectDurationMs,
      options.reconnectInitialDelayMs ?? REMOTE_DAEMON_RECONNECT_INITIAL_DELAY_MS,
      options.reconnectMaxDelayMs ?? REMOTE_DAEMON_RECONNECT_MAX_DELAY_MS);
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.onResyncRequired = options.onResyncRequired;
  }

  /** A codeless profile without a password relies on Tailscale identity alone. */
  private authorizationHeader(): { Authorization?: string } {
    return this.profile.token ? { Authorization: `Bearer ${this.profile.token}` } : {};
  }

  isSameProfile(profile: RemotePaneConnectionProfile): boolean {
    return (
      this.profile.id === profile.id &&
      // A codeless profile's address is looked up at connect, so the saved one may differ.
      (profile.tailnetMachine
        ? this.profile.tailnetMachine === profile.tailnetMachine
        : this.profile.baseUrl === profile.baseUrl) &&
      this.profile.token === profile.token
    );
  }

  async connect(options: RemotePaneClientConnectOptions = {}): Promise<void> {
    this.closedByClient = false;
    this.recoveryStopped = false;
    this.recovery.reset();
    this.armDeadline();
    try {
      await this.openEventStream(false, options.resolveOnReady);
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to connect to remote daemon event stream');
      if (options.retryOnInitialFailure ?? true) {
        this.scheduleReconnect(message);
      } else {
        this.onConnectionStateChange?.('error', message, { lastSeenAt: this.lastSeenAt });
      }
      throw error;
    }
  }

  async retryNow(): Promise<void> {
    if (this.closedByClient || this.suspended) return;
    // An in-flight handshake/restoration already owns this attempt.
    if (this.eventRequest && !this.reconnectTimer && !this.recoveryStopped) return;
    this.clearReconnectTimer();
    if (this.recoveryStopped) { this.recovery.reset(); this.recoveryStopped = false; }
    this.armDeadline();
    try { await this.openEventStream(true); }
    catch (error) { this.scheduleReconnect(getErrorMessage(error, 'Remote host unavailable')); }
  }

  async disconnect(): Promise<void> {
    this.closedByClient = true;
    this.streamGeneration += 1;
    this.clearDeadline();
    this.inputQueue.cancel(new Error('Remote Pane disconnected; pending terminal input was discarded'));
    this.clearReconnectTimer();
    this.clearHeartbeatStaleTimer();
    this.eventParser.reset();

    if (this.eventResponse && !this.eventResponse.destroyed) {
      this.eventResponse.destroy();
    }
    this.eventResponse = null;

    if (this.eventRequest) {
      this.eventRequest.destroy();
    }
    this.eventRequest = null;
  }

  async invoke(channel: string, args: unknown[]): Promise<JsonValue | undefined> {
    return this.inputQueue.invoke(channel, args);
  }

  /** One raw byte stream to a forwarded port on the host, signed in like every other request. */
  openPortStream(port: number): WebSocket {
    const endpoint = new URL(`ports/${port}`, this.normalizedBaseUrl);
    const lookup = createTailscaleFallbackLookup(this.profile, endpoint);
    const options: ClientOptions & { lookup?: LookupFunction } = { headers: this.authorizationHeader() };
    if (lookup) options.lookup = lookup;
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    return new WebSocket(endpoint, options);
  }

  /** Streams a preview file from the host's /media route, passing the byte range through. */
  async fetchMedia(file: { sessionId: string; filePath: string }, request: Request): Promise<Response> {
    const endpoint = new URL('media', this.normalizedBaseUrl);
    endpoint.searchParams.set('sessionId', file.sessionId);
    endpoint.searchParams.set('filePath', file.filePath);
    const requestHeaders: http.OutgoingHttpHeaders = {
      ...this.authorizationHeader(),
      'X-Pane-Remote-Runtime-Id': REMOTE_RUNTIME_ID,
    };
    const range = request.headers.get('Range');
    if (range) requestHeaders.Range = range;
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = createRequest(endpoint, this.buildRequestOptions(endpoint, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        signal: request.signal,
        headers: requestHeaders,
      }), (response) => {
        const status = response.statusCode ?? 502;
        const headers = new Headers();
        for (const name of MEDIA_RESPONSE_HEADERS) {
          const value = decodeOptionalBoundary(response.headers[name], boundary.string);
          if (value !== undefined) headers.set(name, value);
        }
        if (request.method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
          response.resume();
          resolve(new Response(null, { status, headers }));
          return;
        }
        // SAFETY: Node's toWeb adapter produces a byte stream from the HTTP response.
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  /**
   * A timed GET /health. A refusal, or a proxy answering 502-504, means nothing serves Pane on a
   * host that answered; a timeout or failed lookup means the host itself was not reached.
   */
  async checkHealth(timeoutMs = CONNECTION_CHECK_TIMEOUT_MS): Promise<HostHealthCheck> {
    const endpoint = new URL('health', this.normalizedBaseUrl);
    const startedAt = Date.now();
    const result = await this.timedGet(endpoint, {}, timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    if ('statusCode' in result) {
      return PROXY_BACKEND_DOWN_STATUSES.has(result.statusCode)
        ? { kind: 'not-running', elapsedMs, detail: `HTTP ${result.statusCode}` }
        : { kind: 'running', elapsedMs };
    }
    return result.code === 'ECONNREFUSED'
      ? { kind: 'not-running', elapsedMs, detail: result.message }
      : { kind: 'unreachable', detail: result.message };
  }

  /** Whether the host accepts this profile's sign-in, without opening an event stream. */
  async checkSignIn(timeoutMs = CONNECTION_CHECK_TIMEOUT_MS): Promise<'accepted' | 'rejected'> {
    const endpoint = buildRemoteEndpoint(this.normalizedBaseUrl, 'events');
    endpoint.searchParams.set('auth_check', '1');
    const result = await this.timedGet(endpoint, this.authorizationHeader(), timeoutMs);
    // Anything else is left to the real connect, which reports it on the workspace row.
    return 'statusCode' in result && (result.statusCode === 401 || result.statusCode === 403) ? 'rejected' : 'accepted';
  }

  private timedGet(
    endpoint: URL,
    headers: http.OutgoingHttpHeaders,
    timeoutMs: number,
  ): Promise<{ statusCode: number } | { code: string | undefined; message: string }> {
    return new Promise((resolve) => {
      const request = createRequest(endpoint, this.buildRequestOptions(endpoint, { method: 'GET', headers }), (response) => {
        response.resume();
        resolve({ statusCode: response.statusCode ?? 0 });
      });
      // An absolute deadline, so a host that accepts the connection and never answers still fails.
      const deadline = setTimeout(() => {
        request.destroy(Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      request.on('error', (error: NodeJS.ErrnoException) => resolve({ code: error.code, message: error.message }));
      request.on('close', () => clearTimeout(deadline));
      request.end();
    });
  }

  /** Drops the event stream for system sleep so it neither times out nor retries. */
  suspend(): void {
    if (this.closedByClient || this.suspended) return;
    this.suspended = true;
    this.streamGeneration += 1;
    this.clearReconnectTimer();
    this.clearHeartbeatStaleTimer();
    this.eventParser.reset();
    this.eventResponse?.destroy();
    this.eventRequest?.destroy();
    this.eventResponse = null;
    this.eventRequest = null;
  }

  /** Sleep does not extend an outage that was already in progress. */
  resume(): void {
    if (this.closedByClient || !this.suspended) return;
    this.suspended = false;
    if (this.recoveryStopped) return;
    if (!this.recovery.remainingMs) { this.expireRecovery(); return; }
    this.armDeadline();
    void this.openEventStream(true).catch((error) => {
      this.scheduleReconnect(getErrorMessage(error, 'Failed to reconnect to remote daemon event stream'));
    });
  }

  private async invokeRequest(channel: string, args: unknown[], signal?: AbortSignal): Promise<JsonValue | undefined> {
    const endpoint = buildRemoteEndpoint(this.normalizedBaseUrl, 'invoke');
    let payload: RemoteInvokeResponsePayload;
    const generation = this.streamGeneration;
    // Reads and viewer bookkeeping change nothing the person must check, so losing one is only an interruption.
    const nothingToCheck = REMOTE_READ_CHANNELS.has(channel) || REMOTE_RESTORE_CHANNELS.has(channel);
    try {
      const response = await requestJson(endpoint, this.buildRequestOptions(endpoint, {
        method: 'POST', signal,
        headers: {
          ...this.authorizationHeader(),
          'Content-Type': 'application/json; charset=utf-8',
          'X-Pane-Remote-Runtime-Id': REMOTE_RUNTIME_ID,
        },
      }), JSON.stringify({ channel, args }));
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.stopRecovery('The host rejected your credentials. Open connection settings to sign in again.');
        throw new PaneError('ERR_REMOTE_AUTH', 'The host rejected your credentials.', 'Open connection settings to sign in again.');
      }
      payload = parseJsonResponse(response, 'Remote daemon returned an invalid invoke response', remoteInvokeResponseSchema);
    } catch (error) {
      if (error instanceof PaneError) throw error;
      const failure = new PaneError(nothingToCheck ? 'ERR_REMOTE_TRANSPORT' : 'ERR_REMOTE_DELIVERY_UNKNOWN',
        nothingToCheck ? 'Remote connection interrupted: the host response was incomplete. Pane is reconnecting.'
          : 'Delivery unknown: the remote response was interrupted. The action may have completed; it was not replayed.',
        'Wait for reconnection and check the destination before trying again.');
      if (!signal?.aborted && generation === this.streamGeneration && !this.closedByClient) {
        this.handleUnexpectedDisconnect(failure.message, true);
      }
      throw failure;
    }
    if (generation !== this.streamGeneration || this.closedByClient) {
      throw new PaneError('ERR_REMOTE_STALE_RESPONSE', nothingToCheck ? 'Remote connection interrupted: the host changed before its response arrived.' : `Delivery unknown: ${this.profile.label} changed connection before the response arrived.`, 'Check the original destination before trying again.');
    }

    if (!payload.ok) {
      throw new PaneError(payload.error.code ?? 'ERR_REMOTE_DAEMON_REQUEST_FAILED', payload.error.message, payload.error.next);
    }

    return payload.result;
  }

  private async openEventStream(isReconnect: boolean, resolveOnReady = false): Promise<void> {
    this.clearReconnectTimer();
    const generation = ++this.streamGeneration;
    const isStale = (): boolean => generation !== this.streamGeneration || this.closedByClient || this.recoveryStopped;
    this.onConnectionStateChange?.(isReconnect ? 'reconnecting' : 'connecting', null, {
      lastSeenAt: this.lastSeenAt,
    });

    const endpoint = buildRemoteEndpoint(this.normalizedBaseUrl, 'events');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let readyReceived = false;
      let handshakeTimer: NodeJS.Timeout | null = null;
      let request: http.ClientRequest | null = null;

      const clearHandshakeTimer = (): void => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
      };

      const rejectBeforeReady = (message: string, destroyStream = false): void => {
        if (settled) {
          return;
        }

        if (isStale()) {
          // A newer stream owns the shared fields; this attempt just ends.
          settled = true;
          clearHandshakeTimer();
          resolve();
          return;
        }

        settled = true;
        clearHandshakeTimer();
        const activeResponse = this.eventResponse;
        const activeRequest = this.eventRequest ?? request;
        this.handleInitialConnectionFailure();

        if (destroyStream) {
          if (activeResponse && !activeResponse.destroyed) {
            activeResponse.destroy(new Error(message));
          }

          if (activeRequest && !activeRequest.destroyed) {
            activeRequest.destroy(new Error(message));
          }
        }

        reject(new Error(message));
      };

      handshakeTimer = setTimeout(() => {
        if (isStale()) { resolve(); return; }
        if (settled) { this.handleUnexpectedDisconnect('Workspace restoration timed out', true); return; }
        rejectBeforeReady(
          `Timed out waiting for remote daemon ready event after ${this.initialHandshakeTimeoutMs}ms`,
          true,
        );
      }, Math.min(this.initialHandshakeTimeoutMs, this.recovery.remainingMs));

      request = createRequest(endpoint, this.buildRequestOptions(endpoint, {
        method: 'GET',
        headers: {
          ...this.authorizationHeader(),
          Accept: 'text/event-stream',
          'X-Pane-Client-Label': this.profile.label,
          'X-Pane-Client-Device-Label': getRemoteClientDeviceLabel(),
          'X-Pane-Remote-Runtime-Id': REMOTE_RUNTIME_ID,
        },
      }), async (response) => {
        if (response.statusCode !== 200) {
          try {
            const body = await readResponseBody(response);
            if (isStale()) { resolve(); return; }
            const message = extractRemoteErrorMessage(body)
              ?? `Remote daemon event stream failed with status ${response.statusCode ?? 'unknown'}`;
            rejectBeforeReady(message, true);
            if (response.statusCode === 401 || response.statusCode === 403) {
              this.stopRecovery('The host rejected your credentials. Open connection settings to sign in again.');
            }
          } catch (error) {
            rejectBeforeReady(getErrorMessage(error, 'Remote response interrupted'), true);
          }
          return;
        }

        if (isStale()) {
          response.destroy();
          return;
        }

        this.eventResponse = response;
        this.eventParser.reset();

        response.on('data', (chunk: Buffer) => {
          if (isStale()) return;
          const events = this.eventParser.push(chunk);
          for (const event of events) {
            if (event.event === 'ready') {
              if (readyReceived) continue;
              const readyPayload = parseRemoteReadyEventPayload(event.data);
              if (!readyPayload) { rejectBeforeReady('Invalid remote ready event', true); return; }
              readyReceived = true;
              this.markRemoteSeen();
              if (resolveOnReady && !settled) { settled = true; resolve(); }
              this.onConnectionStateChange?.('restoring', null, {
                lastSeenAt: this.lastSeenAt,
                hostVersion: readyPayload.paneVersion,
              });
              void Promise.resolve().then(() => this.onResyncRequired?.()).then(() => {
                if (!isStale()) {
                  clearHandshakeTimer();
                  this.clearDeadline();
                  this.recovery.reset();
                  this.onConnectionStateChange?.('connected', null, { lastSeenAt: this.lastSeenAt });
                }
                if (!settled) { settled = true; resolve(); }
              }, error => {
                const message = getErrorMessage(error, 'Remote restoration failed');
                if (settled && !isStale()) this.handleUnexpectedDisconnect(message, true);
                else rejectBeforeReady(message, true);
              });
              continue;
            }

            if (event.event === 'heartbeat') {
              const heartbeatPayload = parseRemoteHeartbeatPayload(event.data);
              this.markRemoteSeen(heartbeatPayload?.timestamp);
              continue;
            }

            if (event.event !== 'daemon-event') {
              continue;
            }

            try {
              const envelope = decodeBoundary(JSON.parse(event.data), remoteEventEnvelopeSchema);
              if (!isPaneDaemonEventChannel(envelope.channel)) {
                continue;
              }

              this.markRemoteSeen(envelope.timestamp);
              this.eventSink.send(envelope.channel, ...envelope.args);
            } catch (error) {
              console.error('[Pane remote daemon] Failed to parse daemon event payload', error);
            }
          }
        });

        response.on('error', (error) => {
          const message = getErrorMessage(error, 'Remote daemon event stream errored');
          if (readyReceived && settled) {
            if (!isStale()) this.handleUnexpectedDisconnect(message, false);
            return;
          }

          rejectBeforeReady(message);
        });

        response.on('end', () => {
          const message = 'Remote daemon event stream ended';
          if (readyReceived && settled) {
            if (!isStale()) this.handleUnexpectedDisconnect(message, false);
            return;
          }

          rejectBeforeReady(message);
        });

        response.on('close', () => {
          const message = 'Remote daemon event stream closed';
          if (readyReceived && settled) {
            if (!isStale()) this.handleUnexpectedDisconnect(message, false);
            return;
          }

          rejectBeforeReady(message);
        });
      });

      this.eventRequest = request;

      request.on('error', (error) => {
        const message = getErrorMessage(error, 'Failed to connect to remote daemon event stream');
        rejectBeforeReady(message);
      });

      request.end();
    });
  }

  private buildRequestOptions(endpoint: URL, options: RequestOptions): RemoteRequestOptions {
    const lookup = createTailscaleFallbackLookup(this.profile, endpoint);
    const requestOptions: RemoteRequestOptions = { ...options };
    if (lookup) {
      requestOptions.lookup = lookup;
    }
    if (endpoint.protocol === 'https:') {
      requestOptions.servername = endpoint.hostname;
    }
    return requestOptions;
  }

  private handleInitialConnectionFailure(): void {
    this.eventResponse = null;
    this.eventRequest = null;
    this.eventParser.reset();
    this.clearHeartbeatStaleTimer();
  }

  private handleUnexpectedDisconnect(message: string, destroyStream: boolean): void {
    this.streamGeneration += 1;
    this.inputQueue.cancel(new Error(message));
    const activeResponse = this.eventResponse;
    const activeRequest = this.eventRequest;

    this.eventResponse = null;
    this.eventRequest = null;
    this.eventParser.reset();
    this.clearHeartbeatStaleTimer();

    if (destroyStream) {
      if (activeResponse && !activeResponse.destroyed) {
        activeResponse.destroy(new Error(message));
      }

      if (activeRequest && !activeRequest.destroyed) {
        activeRequest.destroy(new Error(message));
      }
    }

    if (this.closedByClient || this.suspended) {
      return;
    }

    this.scheduleReconnect(message);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private armDeadline(): void {
    if (this.deadlineTimer || this.recoveryStopped) return;
    this.deadlineTimer = setTimeout(() => this.expireRecovery(), this.recovery.remainingMs);
  }

  private expireRecovery(): void {
    this.stopRecovery('Could not reconnect within five minutes. Your workspace is kept. Choose Retry now or switch machine.');
  }

  private stopRecovery(message: string): void {
    this.recoveryStopped = true;
    this.streamGeneration += 1;
    this.clearDeadline();
    this.clearReconnectTimer();
    this.clearHeartbeatStaleTimer();
    this.eventResponse?.destroy();
    this.eventRequest?.destroy();
    this.onConnectionStateChange?.('error', message, { lastSeenAt: this.lastSeenAt });
  }

  private scheduleReconnect(message: string): void {
    if (this.closedByClient || this.suspended || this.recoveryStopped || this.reconnectTimer) return;
    this.armDeadline();
    const delay = this.recovery.nextDelay();
    if (delay === null) { this.expireRecovery(); return; }
    this.onConnectionStateChange?.('reconnecting', message, { lastSeenAt: this.lastSeenAt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.recovery.remainingMs) { this.expireRecovery(); return; }
      void this.openEventStream(true).catch(error => {
        this.scheduleReconnect(getErrorMessage(error, 'Failed to reconnect to remote daemon event stream'));
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private markRemoteSeen(timestamp = new Date().toISOString()): string {
    this.lastSeenAt = timestamp;
    this.clearHeartbeatStaleTimer();
    if (!this.closedByClient && !this.suspended) {
      this.heartbeatStaleTimer = setTimeout(() => {
        this.handleUnexpectedDisconnect(
          `Remote daemon heartbeat timed out after ${this.heartbeatStaleTimeoutMs}ms`,
          true,
        );
      }, this.heartbeatStaleTimeoutMs);
    }
    return timestamp;
  }

  private clearHeartbeatStaleTimer(): void {
    if (this.heartbeatStaleTimer) {
      clearTimeout(this.heartbeatStaleTimer);
      this.heartbeatStaleTimer = null;
    }
  }
}

interface RemotePaneClientControllerOptions {
  configManager: ConfigManager;
  rendererEventSink: PaneEventSink;
  rendererIds?: () => number[];
  analyticsManager?: Pick<AnalyticsManager, 'track'>;
  /** Looks up a codeless profile's machine on its tailnet; see `tailnetMachine`. */
  resolveTailnetMachineUrl?: (machine: TailnetMachineRef) => Promise<string>;
  /** This app's Pane version, compared with the host's on the checklist's version row. */
  appVersion?: string;
  checkDependencies?: Partial<ConnectionCheckDependencies>;
}

const defaultCheckDependencies: ConnectionCheckDependencies = {
  readTailscaleStatus,
  lookupTailnetMachine,
  probeWorkspace,
  listSshHosts: () => listSshConfigHosts(),
  runSsh: runSshCommand,
};
/** How long a host gets to start serving after a fix ran on it. */
const HOST_FIX_SETTLE_MS = 30_000;
const HOST_FIX_POLL_MS = 2_000;

export class RemotePaneClientController extends EventEmitter {
  private configManager: ConfigManager | null = null;
  private rendererEventSink: PaneEventSink = noopPaneEventSink;
  private analyticsManager: Pick<AnalyticsManager, 'track'> | undefined;
  private resolveTailnetMachineUrl: ((machine: TailnetMachineRef) => Promise<string>) | undefined;
  private activeClient: RemotePaneClient | null = null;
  private rendererIds: () => number[] = () => [];
  private restoreSequence = 0;
  private pendingRestore: {
    id: number; waiting: Set<number>; resolve: () => void; reject: (error: Error) => void;
  } | null = null;
  private activationCommitted: (() => void) | null = null;
  private connectionGeneration = 0;
  /** Mirrors the active host's forwarded ports onto this machine's loopback. */
  private portTunnel: PortTunnel | null = null;
  /** Tunnel syncs run one at a time, in the order the host's lists arrived. */
  private portTunnelSync: Promise<unknown> = Promise.resolve();
  /** The host's last Ports list, with where this desktop reaches each port. */
  private tunnelledSnapshot: ListeningPortsSnapshot | null = null;
  /** One pending re-read after the host failed to list its ports. */
  private portsListRetry: NodeJS.Timeout | null = null;
  private state = createDefaultRemotePaneConnectionState();
  private configListenerAttached = false;
  private remoteRuntimeUsageTracked = false;
  private appVersion: string | undefined;
  private checkDependencies = defaultCheckDependencies;
  /** The checklist of the latest connect the user started, or of a connection that failed. */
  private check: RemoteConnectionCheck | null = null;
  private checkProfile: RemotePaneConnectionProfile | null = null;
  private checkSequence = 0;
  /** The SSH host and command behind each of the current check's run-on-host fixes. */
  private hostFixes = new Map<RemoteConnectionCheckStage, { alias: string; command: string }>();
  private versionRowReady: Promise<void> = Promise.resolve();
  /** When this app last heard from each host, and its version; kept in memory only. */
  private readonly sightings = new Map<string, { at: string | null; version: string | null }>();

  private readonly configUpdatedListener = () => {
    void this.syncToConfig().catch((error) => {
      this.setConnectionState({
        ...this.state,
        mode: 'remote',
        status: 'error',
        lastError: getErrorMessage(error, 'Failed to sync remote daemon client state'),
      });
    });
  };

  initialize(options: RemotePaneClientControllerOptions): void {
    if (this.configManager && this.configListenerAttached) {
      this.configManager.off('config-updated', this.configUpdatedListener);
      this.configListenerAttached = false;
    }

    this.rendererIds = options.rendererIds ?? (() => []);
    this.configManager = options.configManager;
    this.rendererEventSink = options.rendererEventSink;
    this.analyticsManager = options.analyticsManager;
    this.resolveTailnetMachineUrl = options.resolveTailnetMachineUrl;
    this.appVersion = options.appVersion;
    this.checkDependencies = { ...defaultCheckDependencies, ...options.checkDependencies };
    this.configManager.on('config-updated', this.configUpdatedListener);
    this.configListenerAttached = true;

    void this.syncToConfig().catch((error) => {
      this.setConnectionState({
        ...this.state,
        mode: 'remote',
        status: 'error',
        lastError: getErrorMessage(error, 'Failed to initialize remote daemon client'),
      });
    });
  }

  getConnectionState(): RemotePaneConnectionState {
    return { ...this.state, check: this.check };
  }

  isRemoteModeActive(): boolean {
    return this.state.mode === 'remote';
  }

  /**
   * Points a host link to a forwarded port, such as one in terminal output, at where this desktop
   * reaches it. Null for a host loopback port without a tunnel here, including before the host's
   * Ports list arrives: opening it would reach this computer's own service instead.
   */
  toLocalUrl(url: string): string | null {
    if (!this.isRemoteModeActive()) return url;
    const target = localTargetOf(url, this.tunnelledSnapshot);
    return target.kind === 'load' ? target.url : null;
  }

  getActiveRemoteClient(): RemotePaneClient | null {
    return this.isRemoteModeActive() ? this.activeClient : null;
  }

  shouldForwardLocalRendererEvent(channel: string): boolean {
    return !this.isRemoteModeActive() || !isPaneDaemonEventChannel(channel);
  }

  async invoke<Result>(
    channel: string,
    args: unknown[],
    invokeLocal: () => Promise<Result>,
  ): Promise<Result | JsonValue | ListeningPortsSnapshot | undefined> {
    if (!this.isRemoteModeActive()) {
      return invokeLocal();
    }

    if (!this.activeClient) {
      throw new Error(this.state.lastError ?? 'Remote Pane client is not connected');
    }

    const client = this.activeClient;
    if (this.state.status !== 'connected' && !REMOTE_READ_CHANNELS.has(channel)
      && !REMOTE_RESTORE_CHANNELS.has(channel)) {
      throw new PaneError('ERR_REMOTE_OFFLINE', 'Remote connection interrupted: the action was not sent while the workspace is disconnected.', 'Wait for restoration before submitting it.');
    }
    let result: JsonValue | ListeningPortsSnapshot | undefined;
    if (channel === PORTS_LIST_CHANNEL) {
      result = await this.listTunnelledPorts(client);
    } else {
      try {
        result = await client.invoke(channel, args);
      } catch (error) {
        if (error instanceof Error && error.message.includes(UNKNOWN_COMMAND_MESSAGE)) throw hostOutdatedError(client.profile.label, channel);
        throw error;
      }
    }
    if (!this.remoteRuntimeUsageTracked) {
      this.remoteRuntimeUsageTracked = true;
      trackRemotePaneEvent(this.analyticsManager, 'remote_pane_remote_runtime_used', {
        surface: 'desktop',
        role: 'client',
        flow: 'usage',
        result: 'succeeded',
        connection_mode: 'remote',
        client_kind: 'desktop',
        remote_runtime_used: true,
      });
    }
    return result;
  }

  /**
   * Connects to a profile the user chose, running the connection checklist first. A failed check
   * throws and leaves the current connection as it was; `recheck` reconnects even when connected.
   */
  async activateProfile(
    profile: RemotePaneConnectionProfile,
    options: { recheck?: boolean } = {},
  ): Promise<RemotePaneConnectionState> {
    const sameProfile = this.activeClient?.isSameProfile(profile) === true;
    if (sameProfile && this.state.status === 'connected' && !options.recheck) return this.getConnectionState();
    await this.runProbes(profile);
    const activeClient = this.activeClient;
    if (sameProfile && activeClient && !options.recheck) {
      const machine = tailnetMachineRef(profile);
      if (this.state.status === 'error' && machine) await this.reresolveTailnetMachine(profile, machine, activeClient);
      await this.activeClient?.retryNow();
      return this.getConnectionState();
    }
    try {
      await this.connectProfile(profile, { retryOnInitialFailure: false, resolveOnReady: true });
      return this.getConnectionState();
    } catch (error) {
      await this.syncToConfig().catch((syncError) => {
        console.error('[Pane remote daemon] Failed to restore saved client state after activation error', syncError);
      });
      throw error;
    }
  }

  /** Called only after the selected host's config is committed. */
  commitActivation(): void {
    this.activationCommitted?.();
    this.activationCommitted = null;
  }

  acknowledgeRestore(rendererId: number, restoreId: number, error?: string): void {
    const pending = this.pendingRestore;
    if (!pending || pending.id !== restoreId || !pending.waiting.has(rendererId)) return;
    if (error) {
      this.pendingRestore = null;
      pending.reject(new Error('Workspace restoration failed. Pane will retry.'));
      return;
    }
    pending.waiting.delete(rendererId);
    if (!pending.waiting.size) { this.pendingRestore = null; pending.resolve(); }
  }

  private restoreRenderers(hostChanged: boolean): Promise<void> {
    this.pendingRestore?.reject(new Error('Restoration superseded'));
    const id = ++this.restoreSequence;
    const waiting = new Set(this.rendererIds());
    const result = waiting.size ? new Promise<void>((resolve, reject) => {
      this.pendingRestore = { id, waiting, resolve, reject };
    }) : Promise.resolve();
    this.rendererEventSink.send('remote-daemon:resync-required', { hostChanged, restoreId: id });
    return result;
  }

  /** Pauses the remote connection while the system sleeps. */
  suspend(): void {
    this.activeClient?.suspend();
  }

  /** Reconnects the remote host the user was on before the system slept. */
  resume(): void {
    this.activeClient?.resume();
  }

  /** Closes the checklist, as "Continue to workspace" does. */
  dismissCheck(checkId: number): RemotePaneConnectionState {
    if (this.check?.id === checkId) {
      this.check = null;
      this.publishState();
    }
    return this.getConnectionState();
  }

  /**
   * Runs a row's fixed command on the host over the user's SSH config, then waits for the host to
   * serve again. Returns the profile to reconnect to, or null when the command failed; the row then
   * offers the command to copy instead.
   */
  async runCheckFix(checkId: number, stage: RemoteConnectionCheckStage): Promise<RemotePaneConnectionProfile | null> {
    const target = this.hostFixes.get(stage);
    const profile = this.checkProfile;
    const row = this.check?.rows.find((candidate) => candidate.stage === stage);
    if (this.check?.id !== checkId || !target || !profile || !row) {
      throw new PaneError('ERR_REMOTE_CHECK_STALE', 'This connection check is out of date, so the fix did not run.', 'Retry the connection, then use the fix again.');
    }
    this.updateCheck(checkId, { rows: this.withRow({ ...row, status: 'running' }) });
    try {
      await this.checkDependencies.runSsh(target.alias, target.command);
    } catch (error) {
      this.hostFixes.delete(stage);
      this.updateCheck(checkId, { rows: this.withRow({
        ...row,
        ...copyCommandRow(profile, target.command, `ssh ${target.alias} failed: ${getErrorMessage(error, 'unknown error')}.`),
      }) });
      return null;
    }
    const deadline = Date.now() + HOST_FIX_SETTLE_MS;
    while (Date.now() < deadline && this.check?.id === checkId) {
      const outcome = await probeHost(profile, new RemotePaneClient(profile), this.checkDependencies, () => {});
      if (outcome.failedCheck !== 'pane_not_running' && outcome.failedCheck !== 'host_unreachable') break;
      await new Promise((resolve) => setTimeout(resolve, HOST_FIX_POLL_MS));
    }
    return this.check?.id === checkId ? profile : null;
  }

  async switchToLocalMode(): Promise<RemotePaneConnectionState> {
    this.check = null;
    this.connectionGeneration += 1;
    await this.disconnectActiveClient();
    this.setConnectionState(createDefaultRemotePaneConnectionState());
    return this.getConnectionState();
  }

  async syncToConfig(): Promise<void> {
    if (!this.configManager) {
      return;
    }

    const remoteConfig = normalizeRemoteDaemonConfig(this.configManager.getConfig().remoteDaemon);
    const activeProfileId = remoteConfig.client.activeProfileId;
    if (remoteConfig.client.mode !== 'remote' || !activeProfileId) {
      await this.disconnectActiveClient();
      this.setConnectionState(createDefaultRemotePaneConnectionState());
      return;
    }

    const activeProfile = remoteConfig.client.profiles.find((profile) => profile.id === activeProfileId);
    if (!activeProfile) {
      await this.disconnectActiveClient();
      this.setConnectionState({
        mode: 'remote',
        status: 'error',
        activeProfileId,
        activeProfileLabel: null,
        activeBaseUrl: null,
        lastError: `Remote daemon connection profile "${activeProfileId}" does not exist`,
        lastSeenAt: null,
      });
      return;
    }

    if (this.activeClient?.isSameProfile(activeProfile)) {
      this.setConnectionState({
        ...this.state,
        mode: 'remote',
        activeProfileId: activeProfile.id,
        activeProfileLabel: activeProfile.label,
        activeBaseUrl: this.activeClient.profile.baseUrl,
      });
      return;
    }

    await this.connectProfile(activeProfile, { retryOnInitialFailure: true });
  }

  /**
   * A codeless connection that fails may have lost its machine to a tailnet switch: look it up
   * again, reconnect if it moved within its tailnet, or say why it is gone.
   */
  private async reresolveTailnetMachine(
    savedProfile: RemotePaneConnectionProfile,
    machine: TailnetMachineRef,
    client: RemotePaneClient,
  ): Promise<void> {
    if (!this.resolveTailnetMachineUrl) return;
    try {
      const baseUrl = await this.resolveTailnetMachineUrl(machine);
      if (this.activeClient !== client || baseUrl === client.profile.baseUrl) return;
      await this.connectProfile(savedProfile, { retryOnInitialFailure: true });
    } catch (error) {
      if (this.activeClient !== client) return;
      this.setConnectionState({ ...this.state, status: 'error', lastError: getErrorMessage(error, `Could not find ${machine.name}`) });
    }
  }

  private async connectProfile(
    savedProfile: RemotePaneConnectionProfile,
    options: RemotePaneClientConnectOptions,
  ): Promise<void> {
    const generation = ++this.connectionGeneration;
    await this.disconnectActiveClient();
    const machine = tailnetMachineRef(savedProfile);
    const profile = machine && this.resolveTailnetMachineUrl
      ? { ...savedProfile, baseUrl: await this.resolveTailnetMachineUrl(machine) }
      : savedProfile;
    if (generation !== this.connectionGeneration) return;
    const commit = options.resolveOnReady && this.rendererIds().length > 0
      ? new Promise<void>(resolve => { this.activationCommitted = resolve; })
      : Promise.resolve();
    trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_connect_started', {
      surface: 'desktop',
      role: 'client',
      flow: 'connect',
      result: 'started',
      connection_mode: 'remote',
      tunnel_kind: profile.tunnel?.kind ?? 'unknown',
      client_kind: 'desktop',
    });

    let hostChanged = options.resolveOnReady === true;
    const client = new RemotePaneClient(profile, {
      eventSink: {
        send: (channel, ...args) => {
          if (this.activeClient !== client) return;
          if (channel === 'remote:update-intent') {
            const updateIntent = decodeUpdateIntent(args[0]);
            if (updateIntent) this.setConnectionState({ ...this.state, updateIntent });
          }
          if (channel === PORTS_CHANGED_CHANNEL) {
            void this.publishTunnelledPorts(client, args[0]);
            return;
          }
          this.rendererEventSink.send(channel, ...args);
        },
      },
      onConnectionStateChange: (status, errorMessage, metadata) => {
        if (this.activeClient !== client) return;
        this.advanceCheck(savedProfile, status, errorMessage, metadata?.hostVersion);
        if (status === 'error' || status === 'reconnecting') {
          this.pendingRestore?.reject(new Error('Connection interrupted'));
          this.pendingRestore = null;
        }
        if (status === 'connected') {
          trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_connected', {
            surface: 'desktop',
            role: 'client',
            flow: 'connect',
            result: 'succeeded',
            connection_mode: 'remote',
            tunnel_kind: profile.tunnel?.kind ?? 'unknown',
            client_kind: 'desktop',
          });
        } else if (status === 'error') {
          trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_connection_failed', {
            surface: 'desktop',
            role: 'client',
            flow: 'connect',
            result: 'failed',
            failure_stage: 'remote_client_state',
            failure_category: getRemoteFailureCategory(errorMessage),
            client_kind: 'desktop',
          });
        }
        this.setConnectionState({
          mode: 'remote',
          status,
          activeProfileId: profile.id,
          activeProfileLabel: profile.label,
          activeBaseUrl: profile.baseUrl,
          updateIntent: status === 'connected' ? null : this.state.updateIntent,
          lastError: errorMessage ?? null,
          lastSeenAt: metadata?.lastSeenAt ?? this.getLastSeenAtForProfile(profile.id, status),
        });
      },
      onResyncRequired: async () => {
        await commit;
        if (this.activeClient !== client) return;
        await this.restoreRenderers(hostChanged);
        hostChanged = false;
        void this.refreshTunnelledPorts(client);
      },
    });

    this.activeClient = client;
    this.portTunnel = createPortTunnel(port => client.openPortStream(port));
    try {
      await client.connect({
        retryOnInitialFailure: options.retryOnInitialFailure,
        resolveOnReady: options.resolveOnReady,
      });
    } catch (error) {
      if (options.retryOnInitialFailure && this.activeClient === client) {
        trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_connection_failed', {
          surface: 'desktop',
          role: 'client',
          flow: 'connect',
          result: 'failed',
          failure_stage: 'initial_connect_retrying',
          failure_category: getRemoteFailureCategory(error instanceof Error ? error.message : String(error)),
          client_kind: 'desktop',
        });
        this.setConnectionState({
          mode: 'remote',
          status: this.state.status === 'error' ? 'error' : 'reconnecting',
          activeProfileId: profile.id,
          activeProfileLabel: profile.label,
          activeBaseUrl: profile.baseUrl,
          lastError: getErrorMessage(error, `Failed to connect to remote daemon profile "${profile.label}"`),
          lastSeenAt: null,
        });
        return;
      }

      if (!options.retryOnInitialFailure || this.activeClient !== client) {
        if (this.activeClient === client) {
          this.activeClient = null;
        }
        await client.disconnect();
      }
      trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_connection_failed', {
        surface: 'desktop',
        role: 'client',
        flow: 'connect',
        result: 'failed',
        failure_stage: 'initial_connect',
        failure_category: getRemoteFailureCategory(error instanceof Error ? error.message : String(error)),
        client_kind: 'desktop',
      });
      this.setConnectionState({
        mode: 'remote',
        status: 'error',
        activeProfileId: profile.id,
        activeProfileLabel: profile.label,
        activeBaseUrl: profile.baseUrl,
        lastError: getErrorMessage(error, `Failed to connect to remote daemon profile "${profile.label}"`),
        lastSeenAt: null,
      });
      throw error;
    }
  }

  /**
   * Tunnels every port in a host's Ports list and returns the list with where each port is
   * reachable here. Null for a list of an unknown shape, or from a client that is no longer active.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Host port lists are decoded with decodeListeningPortsSnapshot before use.
  private async tunnelPorts(client: RemotePaneClient, value: unknown): Promise<ListeningPortsSnapshot | null> {
    const snapshot = decodeListeningPortsSnapshot(value);
    const tunnel = this.portTunnel;
    if (!snapshot || !tunnel || this.activeClient !== client) return null;
    // When host and client share a machine, the host also lists this desktop's own tunnel
    // listeners; tunnelling those would connect each one back to itself.
    const hostPorts = snapshot.ports
      .filter(port => !(snapshot.host === getOsHostname() && port.pid === process.pid))
      .map(port => port.port);
    const sync = this.portTunnelSync.then(() => tunnel.sync(hostPorts));
    this.portTunnelSync = sync.catch(error => console.warn('[Pane port tunnel] sync_failed:', error));
    const localPorts = await sync;
    const tunnelled: ListeningPortsSnapshot = {
      ...snapshot,
      ports: snapshot.ports.map(port => {
        const localPort = localPorts.get(port.port);
        return localPort === undefined ? port : { ...port, localPort };
      }),
    };
    if (this.activeClient === client) this.tunnelledSnapshot = tunnelled;
    return tunnelled;
  }

  /**
   * The host's Ports list with local ports. A host older than port detection gets an empty list
   * marked `unsupportedHost`, so its tabs load as before. When a current host fails to read its
   * ports, tabs keep the last list, or an empty one until a retry succeeds; the tunnel is untouched.
   */
  private async listTunnelledPorts(client: RemotePaneClient): Promise<JsonValue | ListeningPortsSnapshot | undefined> {
    let listed: JsonValue | undefined;
    try {
      listed = await client.invoke(PORTS_LIST_CHANNEL, []);
    } catch (error) {
      if (error instanceof Error && error.message.includes(UNKNOWN_COMMAND_MESSAGE)) {
        const unsupported: ListeningPortsSnapshot = { host: client.profile.label, ports: [], unsupportedHost: true };
        if (this.activeClient === client) this.tunnelledSnapshot = unsupported;
        return unsupported;
      }
      console.warn('[Pane port tunnel] list_failed:', error);
      this.portsListRetry ??= setTimeout(() => {
        this.portsListRetry = null;
        if (this.activeClient === client) void this.refreshTunnelledPorts(client);
      }, PORTS_LIST_RETRY_MS);
      this.portsListRetry.unref?.();
      return this.tunnelledSnapshot ?? { host: client.profile.label, ports: [] };
    }
    return await this.tunnelPorts(client, listed) ?? listed;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Host port events pass through tunnelPorts, which decodes them before use.
  private async publishTunnelledPorts(client: RemotePaneClient, value: unknown): Promise<void> {
    try {
      const snapshot = await this.tunnelPorts(client, value);
      if (snapshot && this.activeClient === client) this.rendererEventSink.send(PORTS_CHANGED_CHANNEL, snapshot);
    } catch (error) {
      console.warn('[Pane port tunnel] publish_failed:', error);
    }
  }

  /** Tunnels the host's ports on every (re)connect, before any tab asks for them. */
  private async refreshTunnelledPorts(client: RemotePaneClient): Promise<void> {
    try {
      const snapshot = decodeListeningPortsSnapshot(await this.listTunnelledPorts(client));
      if (snapshot && this.activeClient === client) this.rendererEventSink.send(PORTS_CHANGED_CHANNEL, snapshot);
    } catch (error) {
      console.warn('[Pane port tunnel] list_failed:', error);
    }
  }

  private async disconnectActiveClient(): Promise<void> {
    this.commitActivation();
    this.pendingRestore?.reject(new Error('Connection changed'));
    this.pendingRestore = null;
    const client = this.activeClient;
    this.activeClient = null;
    const tunnel = this.portTunnel;
    this.portTunnel = null;
    this.tunnelledSnapshot = null;
    await tunnel?.close();
    if (client) {
      await client.disconnect();
      trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_disconnected', {
        surface: 'desktop',
        role: 'client',
        flow: 'connect',
        result: 'succeeded',
        connection_mode: 'local',
        client_kind: 'desktop',
      });
    }
  }

  private getLastSeenAtForProfile(profileId: string, status: RemotePaneConnectionStatus): string | null {
    if (this.state.activeProfileId !== profileId) {
      return null;
    }

    if (status === 'connecting') {
      return null;
    }

    return this.state.lastSeenAt;
  }

  private setConnectionState(nextState: RemotePaneConnectionState): void {
    this.state = nextState;
    if (nextState.activeProfileId && nextState.lastSeenAt) {
      const sighting = this.sightings.get(nextState.activeProfileId);
      this.sightings.set(nextState.activeProfileId, { at: nextState.lastSeenAt, version: sighting?.version ?? null });
    }
    this.publishState();
  }

  private publishState(): void {
    this.emit('state-changed', this.getConnectionState());
    this.rendererEventSink.send('remote-daemon:connection-state-changed', this.getConnectionState());
  }

  /**
   * Starts a checklist for `profile` and runs its probe stages. Throws when one fails, naming the
   * stage, so the connect stops before it touches the current connection.
   */
  private async runProbes(profile: RemotePaneConnectionProfile): Promise<void> {
    const id = ++this.checkSequence;
    const sighting = this.sightings.get(profile.id);
    this.checkProfile = profile;
    this.hostFixes = new Map();
    this.check = {
      id,
      profileId: profile.id,
      hostLabel: profile.label,
      route: routeOf(profile),
      address: addressOf(profile),
      outcome: 'running',
      rows: initialRows(profile),
      lastConnectedAt: sighting?.at ?? null,
      hostVersion: sighting?.version ?? null,
    };
    this.publishState();
    const outcome = await probeHost(profile, new RemotePaneClient(profile), this.checkDependencies, (rows) => this.updateCheck(id, { rows }));
    if (this.check?.id !== id) {
      throw new PaneError('ERR_REMOTE_CHECK_SUPERSEDED', `The connection to ${profile.label} was replaced by a newer one.`, 'Wait for the newer connection to finish.');
    }
    this.hostFixes = outcome.hostFixes;
    if (outcome.hostVersion) this.recordHostVersion(profile.id, outcome.hostVersion);
    const failed = outcome.rows.find((row) => row.status === 'failed');
    if (failed && outcome.failedCheck) {
      this.updateCheck(id, { rows: outcome.rows, address: outcome.address, outcome: 'failed' });
      this.trackCheckFailure(outcome.failedCheck);
      throw new PaneError('ERR_REMOTE_CHECK_FAILED', `${failed.label}.`, failed.detail ?? 'Use the fix on the connection checklist, then retry.');
    }
    this.updateCheck(id, {
      address: outcome.address,
      rows: outcome.rows.map((row) => (row.stage === 'version' ? { ...row, status: 'running' } : row)),
    });
  }

  /**
   * Moves the active checklist along with the real connect: the ready event fills the version row
   * and a restored workspace closes it. A connection that fails with no checklist running gets one,
   * so the card names the failed stage.
   */
  private advanceCheck(
    profile: RemotePaneConnectionProfile,
    status: RemotePaneConnectionStatus,
    errorMessage: string | null | undefined,
    hostVersion: string | undefined,
  ): void {
    const check = this.check;
    // A codeless host already described its version to the probe; older hosts omit it on ready.
    const version = hostVersion ?? (profile.tailnetMachine && check?.profileId === profile.id ? check.hostVersion : null);
    if (status === 'restoring') this.recordHostVersion(profile.id, version);
    if (!check || check.profileId !== profile.id || check.outcome !== 'running') {
      if (status === 'error') void this.diagnoseFailure(profile, errorMessage);
      return;
    }
    const id = check.id;
    if (status === 'restoring') {
      this.versionRowReady = this.resolveVersionRow(id, profile, version);
      return;
    }
    if (status === 'connected') {
      void this.versionRowReady.then(() => {
        const current = this.check;
        if (current?.id !== id || current.outcome !== 'running') return;
        const rows = this.withRow({ stage: 'workspace', status: 'passed', label: 'Workspace loaded' });
        this.updateCheck(id, { rows, outcome: rows.some((row) => row.status === 'warning') ? 'warning' : 'passed' });
      });
      return;
    }
    // A reconnecting state with no error is a new attempt starting, not a failure.
    if (status === 'error' || (status === 'reconnecting' && errorMessage)) {
      this.updateCheck(id, {
        rows: this.withRow({ stage: 'workspace', status: 'failed', label: 'Workspace did not load', detail: errorMessage ?? 'The host stopped answering.' }),
        outcome: 'failed',
      });
      this.trackCheckFailure('workspace_restore');
    }
  }

  private async resolveVersionRow(id: number, profile: RemotePaneConnectionProfile, hostVersion: string | null): Promise<void> {
    // Without this app's version there is nothing to compare; the row passes.
    const { row, target } = this.appVersion
      ? await versionRow(profile, hostVersion, this.appVersion, this.checkDependencies)
      : { row: { stage: 'version' as const, status: 'passed' as const, label: 'Versions match', metric: hostVersion ?? undefined }, target: null };
    if (this.check?.id !== id) return;
    if (target) this.hostFixes.set('version', target);
    this.updateCheck(id, { rows: this.withRow(row) });
    if (this.check?.id === id) this.updateCheck(id, { rows: this.withRow({ stage: 'workspace', status: 'running', label: 'Workspace loaded' }) });
  }

  /** Runs the probe stages once after a connection fails on its own, to name the stage. */
  private async diagnoseFailure(profile: RemotePaneConnectionProfile, errorMessage: string | null | undefined): Promise<void> {
    try {
      await this.runProbes(profile);
    } catch {
      return;
    }
    const id = this.check?.id;
    if (id === undefined) return;
    this.updateCheck(id, {
      rows: this.withRow({ stage: 'workspace', status: 'failed', label: 'Workspace did not load', detail: errorMessage ?? 'The host stopped answering.' })
        .map((row) => (row.stage === 'version' ? { ...row, status: 'waiting' } : row)),
      outcome: 'failed',
    });
    this.trackCheckFailure('workspace_restore');
  }

  private recordHostVersion(profileId: string, version: string | null): void {
    const sighting = this.sightings.get(profileId);
    this.sightings.set(profileId, { at: sighting?.at ?? null, version });
    if (this.check?.profileId === profileId && version) this.check = { ...this.check, hostVersion: version };
  }

  /** The current check's rows with `row` in its stage's place. */
  private withRow(row: RemoteConnectionCheckRow): RemoteConnectionCheckRow[] {
    return (this.check?.rows ?? []).map((candidate) => (candidate.stage === row.stage ? row : candidate));
  }

  private updateCheck(id: number, update: Partial<Pick<RemoteConnectionCheck, 'rows' | 'outcome' | 'address'>>): void {
    if (this.check?.id !== id) return;
    this.check = { ...this.check, ...update };
    this.publishState();
  }

  private trackCheckFailure(failedCheck: RemotePaneFailedCheck): void {
    trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_connection_failed', {
      surface: 'desktop',
      role: 'client',
      flow: 'connect',
      result: 'failed',
      failure_stage: 'connection_check',
      failed_check: failedCheck,
      client_kind: 'desktop',
    });
  }
}

export const remotePaneClientController = new RemotePaneClientController();

/** A codeless profile's machine: its Tailscale name on the tailnet it was saved on. */
export interface TailnetMachineRef {
  name: string;
  domain: string;
}

function tailnetMachineRef(profile: RemotePaneConnectionProfile): TailnetMachineRef | null {
  return profile.tailnetMachine && profile.tailnetDomain
    ? { name: profile.tailnetMachine, domain: profile.tailnetDomain }
    : null;
}

function normalizeBaseUrl(baseUrl: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(normalized);
}

function buildRemoteEndpoint(baseUrl: URL, path: 'invoke' | 'events'): URL {
  return new URL(path, baseUrl);
}

function createTailscaleFallbackLookup(
  profile: RemotePaneConnectionProfile,
  endpoint: URL,
): LookupFunction | undefined {
  const hostname = normalizeLookupHostname(endpoint.hostname);
  if (isIP(hostname) !== 0) {
    return undefined;
  }

  const staticTailscaleIp = profile.tunnel?.kind === 'tailscale'
    ? normalizeFallbackIp(profile.tunnel.tailscaleIp)
    : null;
  const isTailscaleHostname = hostname.toLowerCase().endsWith('.ts.net');
  if (!staticTailscaleIp && !isTailscaleHostname) {
    return undefined;
  }

  return (lookupHostname, options, callback) => {
    defaultLookup(lookupHostname, options, (error, address, family) => {
      if (!error) {
        callback(null, address, family);
        return;
      }

      void resolveTailscaleFallbackAddress(
        normalizeLookupHostname(lookupHostname),
        staticTailscaleIp,
        isTailscaleHostname,
      ).then((fallbackAddress) => {
        if (!fallbackAddress) {
          callback(error, '', 0);
          return;
        }

        const fallbackFamily = isIP(fallbackAddress);
        if (options.all === true) {
          callback(null, [{ address: fallbackAddress, family: fallbackFamily }]);
          return;
        }

        callback(null, fallbackAddress, fallbackFamily);
      }).catch(() => {
        callback(error, '', 0);
      });
    });
  };
}

async function resolveTailscaleFallbackAddress(
  hostname: string,
  staticTailscaleIp: string | null,
  isTailscaleHostname: boolean,
): Promise<string | null> {
  if (staticTailscaleIp) {
    return staticTailscaleIp;
  }

  if (!isTailscaleHostname) {
    return null;
  }

  return resolveTailscaleMagicDnsIpv4(hostname);
}

async function resolveTailscaleMagicDnsIpv4(hostname: string): Promise<string | null> {
  const resolver = new Resolver();
  resolver.setServers([TAILSCALE_MAGIC_DNS_SERVER]);

  const addresses = await new Promise<string[]>((resolve, reject) => {
    resolver.resolve4(hostname, (error, result) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    });
  });

  return addresses.find((address) => isIP(address) === 4) ?? null;
}

function normalizeFallbackIp(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();
  return isIP(normalizedValue) !== 0 ? normalizedValue : null;
}

function normalizeLookupHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)]$/, '$1');
}

function createRequest(
  url: URL,
  options: RemoteRequestOptions,
  onResponse: (response: IncomingMessage) => void,
): http.ClientRequest {
  const transport = url.protocol === 'https:' ? https : http;
  return transport.request(url, options, onResponse);
}

async function requestJson(
  url: URL,
  options: RemoteRequestOptions,
  body: string,
): Promise<JsonResponse> {
  return await new Promise<JsonResponse>((resolve, reject) => {
    const request = createRequest(url, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      void readResponseBody(response).then((responseBody) => {
        resolve({
          statusCode: response.statusCode ?? 500,
          body: responseBody,
        });
      }).catch(reject);
    });

    request.setTimeout(15_000, () => request.destroy(new Error('Remote response timed out')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function readResponseBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** The host's own refusal says to update "Pane", which reads as this desktop; name the host instead. */
function hostOutdatedError(hostLabel: string, channel: string): PaneError {
  return new PaneError(
    'ERR_HOST_OUTDATED',
    `${hostLabel} runs an older Pane that does not have this command (${channel}). Nothing was changed.`,
    `Update Pane on ${hostLabel} (run \`runpane update\` there), then try again.`,
  );
}

function parseJsonResponse<Value>(
  response: JsonResponse,
  fallbackMessage: string,
  schema: BoundarySchema<Value>,
): Value {
  let value: unknown;
  try { value = JSON.parse(response.body); }
  catch (error) {
    if (!response.body.trim() || (error instanceof SyntaxError && /end of JSON|Unterminated/i.test(error.message)) || response.statusCode >= 500) {
      throw new Error(fallbackMessage);
    }
    throw new PaneError('ERR_REMOTE_PROTOCOL', 'The host returned an invalid response. The result cannot be confirmed.', 'Check host and client version compatibility.');
  }
  try { return decodeBoundary(value, schema); }
  catch {
    throw new PaneError('ERR_REMOTE_PROTOCOL', 'The host returned an incompatible response. The result cannot be confirmed.', 'Check host and client version compatibility.');
  }
}

function extractRemoteErrorMessage(body: string): string | null {
  if (body.trim().length === 0) {
    return null;
  }

  try {
    const parsed = decodeBoundary(JSON.parse(body), remoteInvokeResponseSchema);
    return parsed.ok ? null : parsed.error.message;
  } catch {
    try {
      return decodeBoundary(JSON.parse(body), remoteErrorResponseSchema).error.message;
    } catch {
      return body;
    }
  }
}

function getRemoteClientDeviceLabel(): string {
  const localHostname = getOsHostname().trim();
  if (localHostname) {
    return localHostname.slice(0, 80);
  }

  switch (process.platform) {
    case 'darwin':
      return 'macOS device';
    case 'win32':
      return 'Windows device';
    case 'linux':
      return 'Linux device';
    default:
      return 'remote client';
  }
}

function createRemoteRuntimeId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `remote-runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function parseRemoteReadyEventPayload(data: string): RemoteReadyEventPayload | null {
  if (data.length === 0) {
    return null;
  }

  try {
    return decodeBoundary(JSON.parse(data), remoteReadyEventSchema);
  } catch {
    return null;
  }
}

function parseRemoteHeartbeatPayload(data: string): RemoteDaemonHeartbeatPayload | null {
  if (data.length === 0) {
    return null;
  }

  try {
    return decodeBoundary(JSON.parse(data), remoteHeartbeatSchema);
  } catch {
    return null;
  }
}

function getErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
