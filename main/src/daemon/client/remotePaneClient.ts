import { EventEmitter } from 'events';
import { lookup as defaultLookup, Resolver } from 'dns';
import http, { type IncomingMessage, type RequestOptions } from 'http';
import https from 'https';
import { isIP, type LookupFunction } from 'net';
import { hostname as getOsHostname } from 'os';
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
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { BoundarySchema, JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { PaneSseParser } from './sseParser';
import { RemoteInputQueue } from '../../../../shared/remoteInputQueue';

interface RemoteConnectionStateMetadata {
  lastSeenAt?: string | null;
}

interface RemotePaneClientOptions {
  eventSink?: PaneEventSink;
  initialHandshakeTimeoutMs?: number;
  heartbeatStaleTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectErrorThreshold?: number;
  onConnectionStateChange?: (
    status: RemotePaneConnectionStatus,
    errorMessage?: string | null,
    metadata?: RemoteConnectionStateMetadata,
  ) => void;
  onResyncRequired?: () => void;
}

interface RemotePaneClientConnectOptions {
  retryOnInitialFailure?: boolean;
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
const REMOTE_DAEMON_RECONNECT_MAX_DELAY_MS = 15_000;
const REMOTE_DAEMON_RECONNECT_ERROR_THRESHOLD = 5;
const REMOTE_DAEMON_HEARTBEAT_STALE_TIMEOUT_MS = 20_000;
const REMOTE_DAEMON_INITIAL_HANDSHAKE_TIMEOUT_MS = 10_000;
const TAILSCALE_MAGIC_DNS_SERVER = '100.100.100.100';
const REMOTE_RUNTIME_ID = createRemoteRuntimeId();

type RemoteRequestOptions = RequestOptions & {
  servername?: string;
};

export class RemotePaneClient {
  private readonly normalizedBaseUrl: URL;
  private readonly eventSink: PaneEventSink;
  private readonly initialHandshakeTimeoutMs: number;
  private readonly heartbeatStaleTimeoutMs: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectErrorThreshold: number;
  private readonly onConnectionStateChange?: (
    status: RemotePaneConnectionStatus,
    errorMessage?: string | null,
    metadata?: RemoteConnectionStateMetadata,
  ) => void;
  private readonly onResyncRequired?: () => void;
  private eventParser = new PaneSseParser();
  private eventRequest: http.ClientRequest | null = null;
  private eventResponse: IncomingMessage | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatStaleTimer: NodeJS.Timeout | null = null;
  private consecutiveReconnectFailures = 0;
  private lastSeenAt: string | null = null;
  private closedByClient = false;
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
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs
      ?? REMOTE_DAEMON_RECONNECT_INITIAL_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs
      ?? REMOTE_DAEMON_RECONNECT_MAX_DELAY_MS;
    this.reconnectErrorThreshold = options.reconnectErrorThreshold
      ?? REMOTE_DAEMON_RECONNECT_ERROR_THRESHOLD;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.onResyncRequired = options.onResyncRequired;
  }

  isSameProfile(profile: RemotePaneConnectionProfile): boolean {
    return (
      this.profile.id === profile.id &&
      this.profile.baseUrl === profile.baseUrl &&
      this.profile.token === profile.token
    );
  }

  async connect(options: RemotePaneClientConnectOptions = {}): Promise<void> {
    this.closedByClient = false;
    try {
      await this.openEventStream(false);
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

  async disconnect(): Promise<void> {
    this.closedByClient = true;
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

  private async invokeRequest(channel: string, args: unknown[], signal?: AbortSignal): Promise<JsonValue | undefined> {
    const endpoint = buildRemoteEndpoint(this.normalizedBaseUrl, 'invoke');
    let response: JsonResponse;
    try {
      response = await requestJson(endpoint, this.buildRequestOptions(endpoint, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.profile.token}`,
          'Content-Type': 'application/json; charset=utf-8',
          'X-Pane-Remote-Runtime-Id': REMOTE_RUNTIME_ID,
        },
      }), JSON.stringify({ channel, args }));
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = getErrorMessage(error, 'Failed to invoke remote daemon');
      this.handleUnexpectedDisconnect(message, true);
      throw error;
    }

    const payload = parseJsonResponse(
      response,
      'Remote daemon returned an invalid invoke response',
      remoteInvokeResponseSchema,
    );

    if (!payload.ok) {
      throw new Error(payload.error.message);
    }

    return payload.result;
  }

  private async openEventStream(isReconnect: boolean): Promise<void> {
    this.clearReconnectTimer();
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
        rejectBeforeReady(
          `Timed out waiting for remote daemon ready event after ${this.initialHandshakeTimeoutMs}ms`,
          true,
        );
      }, this.initialHandshakeTimeoutMs);

      request = createRequest(endpoint, this.buildRequestOptions(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.profile.token}`,
          Accept: 'text/event-stream',
          'X-Pane-Client-Label': this.profile.label,
          'X-Pane-Client-Device-Label': getRemoteClientDeviceLabel(),
          'X-Pane-Remote-Runtime-Id': REMOTE_RUNTIME_ID,
        },
      }), async (response) => {
        if (response.statusCode !== 200) {
          const body = await readResponseBody(response);
          const message = extractRemoteErrorMessage(body)
            ?? `Remote daemon event stream failed with status ${response.statusCode ?? 'unknown'}`;
          rejectBeforeReady(message);
          return;
        }

        this.eventResponse = response;
        this.eventParser.reset();

        response.on('data', (chunk: Buffer) => {
          const events = this.eventParser.push(chunk);
          for (const event of events) {
            if (event.event === 'ready') {
              readyReceived = true;
              clearHandshakeTimer();
              const lastSeenAt = this.markRemoteSeen();
              this.consecutiveReconnectFailures = 0;
              const readyPayload = parseRemoteReadyEventPayload(event.data);
              if (readyPayload?.resync === 'refetch-state-after-reconnect') {
                this.onResyncRequired?.();
              }
              this.onConnectionStateChange?.('connected', null, { lastSeenAt });
              if (!settled) {
                settled = true;
                resolve();
              }
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
          if (readyReceived) {
            this.handleUnexpectedDisconnect(message, false);
            return;
          }

          rejectBeforeReady(message);
        });

        response.on('end', () => {
          const message = 'Remote daemon event stream ended';
          if (readyReceived) {
            this.handleUnexpectedDisconnect(message, false);
            return;
          }

          rejectBeforeReady(message);
        });

        response.on('close', () => {
          const message = 'Remote daemon event stream closed';
          if (readyReceived) {
            this.handleUnexpectedDisconnect(message, false);
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

    if (this.closedByClient) {
      return;
    }

    this.scheduleReconnect(message);
  }

  private scheduleReconnect(message: string): void {
    if (this.closedByClient || this.reconnectTimer) {
      return;
    }

    if (this.consecutiveReconnectFailures >= this.reconnectErrorThreshold) {
      this.onConnectionStateChange?.('error', message, { lastSeenAt: this.lastSeenAt });
      return;
    }

    this.onConnectionStateChange?.('reconnecting', message, { lastSeenAt: this.lastSeenAt });
    const attempt = this.consecutiveReconnectFailures;
    const reconnectDelayMs = Math.min(
      this.reconnectInitialDelayMs * (2 ** attempt),
      this.reconnectMaxDelayMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openEventStream(true).catch((error) => {
        const nextMessage = getErrorMessage(error, 'Failed to reconnect to remote daemon event stream');
        this.consecutiveReconnectFailures += 1;
        this.scheduleReconnect(nextMessage);
      });
    }, reconnectDelayMs);
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
    if (!this.closedByClient) {
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
  analyticsManager?: Pick<AnalyticsManager, 'track'>;
}

export class RemotePaneClientController extends EventEmitter {
  private configManager: ConfigManager | null = null;
  private rendererEventSink: PaneEventSink = noopPaneEventSink;
  private analyticsManager: Pick<AnalyticsManager, 'track'> | undefined;
  private activeClient: RemotePaneClient | null = null;
  private state = createDefaultRemotePaneConnectionState();
  private configListenerAttached = false;
  private remoteRuntimeUsageTracked = false;

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

    this.configManager = options.configManager;
    this.rendererEventSink = options.rendererEventSink;
    this.analyticsManager = options.analyticsManager;
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
    return { ...this.state };
  }

  isRemoteModeActive(): boolean {
    return this.state.mode === 'remote';
  }

  shouldForwardLocalRendererEvent(channel: string): boolean {
    return !this.isRemoteModeActive() || !isPaneDaemonEventChannel(channel);
  }

  async invoke<Result>(
    channel: string,
    args: unknown[],
    invokeLocal: () => Promise<Result>,
  ): Promise<Result | JsonValue | undefined> {
    if (!this.isRemoteModeActive()) {
      return invokeLocal();
    }

    if (!this.activeClient) {
      throw new Error(this.state.lastError ?? 'Remote Pane client is not connected');
    }

    const result = await this.activeClient.invoke(channel, args);
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

  async activateProfile(profile: RemotePaneConnectionProfile): Promise<RemotePaneConnectionState> {
    try {
      await this.connectProfile(profile, { retryOnInitialFailure: false });
      return this.getConnectionState();
    } catch (error) {
      await this.syncToConfig().catch((syncError) => {
        console.error('[Pane remote daemon] Failed to restore saved client state after activation error', syncError);
      });
      throw error;
    }
  }

  async switchToLocalMode(): Promise<RemotePaneConnectionState> {
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
        activeBaseUrl: activeProfile.baseUrl,
      });
      return;
    }

    await this.connectProfile(activeProfile, { retryOnInitialFailure: true });
  }

  private async connectProfile(
    profile: RemotePaneConnectionProfile,
    options: RemotePaneClientConnectOptions,
  ): Promise<void> {
    await this.disconnectActiveClient();
    trackRemotePaneEvent(this.analyticsManager, 'remote_pane_client_connect_started', {
      surface: 'desktop',
      role: 'client',
      flow: 'connect',
      result: 'started',
      connection_mode: 'remote',
      tunnel_kind: profile.tunnel?.kind ?? 'unknown',
      client_kind: 'desktop',
    });

    const client = new RemotePaneClient(profile, {
      eventSink: this.rendererEventSink,
      onConnectionStateChange: (status, errorMessage, metadata) => {
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
          lastError: errorMessage ?? null,
          lastSeenAt: metadata?.lastSeenAt ?? this.getLastSeenAtForProfile(profile.id, status),
        });
      },
      onResyncRequired: () => {
        this.rendererEventSink.send('remote-daemon:resync-required');
      },
    });

    this.activeClient = client;
    try {
      await client.connect({
        retryOnInitialFailure: options.retryOnInitialFailure,
      });
      this.setConnectionState({
        mode: 'remote',
        status: 'connected',
        activeProfileId: profile.id,
        activeProfileLabel: profile.label,
        activeBaseUrl: profile.baseUrl,
        lastError: null,
        lastSeenAt: this.getLastSeenAtForProfile(profile.id, 'connected'),
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
          status: 'reconnecting',
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

  private async disconnectActiveClient(): Promise<void> {
    const client = this.activeClient;
    this.activeClient = null;
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
    this.emit('state-changed', this.getConnectionState());
    this.rendererEventSink.send('remote-daemon:connection-state-changed', this.getConnectionState());
  }
}

export const remotePaneClientController = new RemotePaneClientController();

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

function parseJsonResponse<Value>(
  response: JsonResponse,
  fallbackMessage: string,
  schema: BoundarySchema<Value>,
): Value {
  try {
    return decodeBoundary(JSON.parse(response.body), schema);
  } catch (error) {
    throw new Error(
      `${fallbackMessage}: ${getErrorMessage(error, 'Unknown JSON parse failure')}`,
    );
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
