import http, { type IncomingMessage, type ServerResponse } from 'http';
import { pipeline, type Duplex, type Writable } from 'stream';
import { constants as zlibConstants, createGzip, gzip } from 'zlib';
import type { AddressInfo } from 'net';
import WebSocket, { type RawData, WebSocketServer } from 'ws';
import { createFanoutEventSink, noopPaneEventSink, type PaneEventSink } from '../core/eventSink';
import type { ConfigManager } from '../services/configManager';
import {
  getConnectedClientCountBucket,
  type RemotePaneAnalyticsSink,
} from '../services/remoteAnalytics';
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { PaneCommandRegistry } from './commandRegistry';
import { authenticateRemoteDaemonBearerToken } from './auth';
import { isPaneDaemonEventChannel } from './server';
import {
  createDefaultRemoteDaemonConfig,
  getRemoteDaemonHostConfigValidationError,
  type RemoteDaemonConnectedClient,
  type RemoteDaemonConfig,
  type RemoteDaemonEventEnvelope,
  type RemoteDaemonHeartbeatPayload,
  type RemoteInvokeRequest,
} from '../../../shared/types/remoteDaemon';
import { remoteHostRuntimeStateStore } from './remoteHostRuntimeState';
import { getRemotePwaAssetResponse } from './pwaStaticAssets';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { BoundarySchema, JsonValue } from '../../../shared/validation/boundaryDecoder';
import { serializeJsonTransport } from './jsonTransport';

interface RemoteHttpAddress {
  host: string;
  port: number;
}

const remoteInvokeRequestSchema: BoundarySchema<RemoteInvokeRequest> = boundary.object({
  channel: boundary.nonEmptyString,
  args: boundary.array(boundary.json),
  token: boundary.optional(boundary.string),
  runtimeId: boundary.optional(boundary.string),
  clientLabel: boundary.optional(boundary.string),
});

interface ConnectedRemoteEventClient {
  id: string;
  // The response itself, or a gzip stream piped into it when the client accepts gzip.
  stream: Writable;
  remoteClientId: string | null;
  remoteClientTokenHash: string | null;
  label: string | null;
  deviceLabel: string | null;
  remoteRuntimeId: string | null;
  remoteAddress: string | null;
  connectedAt: string;
  lastSeenAt: string;
  heartbeatTimer: NodeJS.Timeout;
}

interface RemoteInvokeSuccessPayload {
  ok: true;
  result: unknown;
}

interface RemoteInvokeErrorPayload {
  ok: false;
  error: {
    message: string;
    code: string;
  };
}

interface RemoteReadyEventPayload {
  replay: 'none';
  resync: 'refetch-state-after-reconnect';
  timestamp: string;
}

interface RemoteHealthPayload {
  ok: true;
  status: 'ready';
  transport: 'http+sse';
}

type RemoteRequestAuthResult =
  | {
    ok: true;
    client: {
      id: string;
      tokenHash: string;
      label: string;
    } | null;
  }
  | {
    ok: false;
    statusCode: number;
    error: {
      message: string;
      code: string;
    };
  };

const MAX_UNAUTHENTICATED_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_AUTHENTICATED_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_REMOTE_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
const REMOTE_VISIBILITY_VIEWER_STALE_MS = 15 * 60 * 1000;
const MIN_GZIP_BODY_BYTES = 1024;
const GZIP_HEADERS = { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } as const;
const DEEPGRAM_LISTEN_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const VOICE_DEEPGRAM_STREAM_PATH = '/voice/deepgram-stream';
const DEEPGRAM_STREAMING_KEYTERMS = [
  'Doozy',
  'Pane',
  'Dcouple',
  'Composio',
  'Anthropic',
  'Claude',
  'Claude Opus',
  'Claude Sonnet',
  'GPT',
  'GPT-5.5',
  'GPT-5.5 medium',
  'GPT-5.5 medium-high',
  'Gemini',
  'Gemini 3.1 Flash Lite',
  'Postgres',
  'PostgreSQL',
  'Supabase',
  'Next.js',
  'TypeScript',
  'JavaScript',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'gRPC',
  'GraphQL',
  'OAuth',
  'JWT',
  'Kubernetes',
  'Cursor',
  'Aider',
  'Codex',
  'OpenRouter',
  'RAG',
  'embeddings',
  'BM25',
  'SWE-bench',
  'n8n',
  'Tailwind',
  'shadcn/ui',
];
const REMOTE_DAEMON_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Authorization',
    'Content-Type',
    'X-Pane-Remote-Runtime-Id',
    'X-Pane-Remote-Client-Label',
    'X-Pane-Client-Label',
    'X-Pane-Client-Device-Label',
  ].join(', '),
  'Access-Control-Max-Age': '86400',
};

interface PaneRemoteHttpApiServerOptions {
  heartbeatIntervalMs?: number;
  analyticsSink?: RemotePaneAnalyticsSink;
}

type RemoteHttpConfig = Pick<ReturnType<ConfigManager['getConfig']>, 'deepgramApiKey' | 'remoteDaemon'>;

interface RemoteHttpConfigProvider {
  getConfig(): RemoteHttpConfig;
}

class RemoteDaemonBadRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'RemoteDaemonBadRequestError';
  }
}

export class PaneRemoteHttpApiServer {
  private server: http.Server | null = null;
  private voiceDeepgramWss: WebSocketServer | null = null;
  private readonly eventClients = new Map<string, ConnectedRemoteEventClient>();
  private readonly daemonEventSink: PaneEventSink;
  private address: RemoteHttpAddress | null = null;
  private nextClientConnectionId = 1;
  private readonly heartbeatIntervalMs: number;
  private readonly analyticsSink?: RemotePaneAnalyticsSink;

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    private readonly configManager: RemoteHttpConfigProvider,
    options: PaneRemoteHttpApiServerOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_REMOTE_DAEMON_HEARTBEAT_INTERVAL_MS;
    this.analyticsSink = options.analyticsSink;
    this.daemonEventSink = createFanoutEventSink([
      {
        send: (channel, ...args) => {
          if (!isPaneDaemonEventChannel(channel) || this.eventClients.size === 0) {
            return;
          }

          const payload: RemoteDaemonEventEnvelope = {
            channel,
            args: serializeJsonTransport(args, boundary.array(boundary.json)),
            timestamp: new Date().toISOString(),
          };

          for (const [clientConnectionId, client] of this.eventClients) {
            if (!this.shouldKeepEventClient(client.remoteClientId, client.remoteClientTokenHash)) {
              this.dropEventClient(clientConnectionId);
              continue;
            }

            try {
              writeSseEvent(client.stream, 'daemon-event', payload);
            } catch {
              this.dropEventClient(clientConnectionId);
            }
          }
        },
      },
      noopPaneEventSink,
    ]);
  }

  getAddress(): RemoteHttpAddress | null {
    return this.address;
  }

  getEventSink(): PaneEventSink {
    return this.daemonEventSink;
  }

  getConnectedClients(): RemoteDaemonConnectedClient[] {
    return this.getConnectedClientSnapshots();
  }

  disconnectClients(clientIds?: string[]): number {
    const clientIdSet = clientIds ? new Set(clientIds) : null;
    const clientConnectionIds = [...this.eventClients.entries()]
      .filter(([, client]) => !clientIdSet || (client.remoteClientId !== null && clientIdSet.has(client.remoteClientId)))
      .map(([clientConnectionId]) => clientConnectionId);

    for (const clientConnectionId of clientConnectionIds) {
      this.dropEventClient(clientConnectionId);
    }

    return clientConnectionIds.length;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Remote daemon HTTP API server is already running');
    }

    const hostConfig = this.getRemoteConfig().host.config;
    if (!hostConfig.enabled) {
      throw new Error('Remote daemon HTTP API server is disabled in config');
    }

    const hostConfigError = getRemoteDaemonHostConfigValidationError(hostConfig);
    if (hostConfigError) {
      throw new Error(hostConfigError);
    }

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          this.writeJson(response, 500, {
            ok: false,
            error: {
              message,
              code: 'ERR_REMOTE_DAEMON_HTTP_INTERNAL',
            },
          });
          return;
        }

        response.destroy(error instanceof Error ? error : new Error(message));
      });
    });
    const voiceDeepgramWss = new WebSocketServer({ noServer: true });
    this.voiceDeepgramWss = voiceDeepgramWss;
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).catch((error) => {
        writeRawHttpError(socket, 500, error instanceof Error ? error.message : String(error));
      });
    });

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        reject(error);
      };

      const handleListening = () => {
        server.removeListener('error', handleError);
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(hostConfig.listenPort, hostConfig.listenHost);
    });

    server.on('error', (error) => {
      console.error('[Pane remote daemon] HTTP server error:', error);
    });

    const address = server.address();
    if (!isTcpAddress(address)) {
      throw new Error('Remote daemon HTTP API server did not expose a TCP address');
    }

    this.server = server;
    this.address = {
      host: hostConfig.listenHost,
      port: address.port,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.address = null;
    const voiceDeepgramWss = this.voiceDeepgramWss;
    this.voiceDeepgramWss = null;
    if (voiceDeepgramWss) {
      for (const client of voiceDeepgramWss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        voiceDeepgramWss.close(() => resolve());
      });
    }

    for (const clientConnectionId of [...this.eventClients.keys()]) {
      this.dropEventClient(clientConnectionId);
    }

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== VOICE_DEEPGRAM_STREAM_PATH) {
      socket.destroy();
      return;
    }

    const auth = this.authenticateRequest(request, url.searchParams.get('access_token'));
    if (!auth.ok) {
      writeRawHttpError(socket, auth.statusCode, auth.error.message);
      return;
    }

    const deepgramApiKey = firstNonEmpty(this.configManager.getConfig().deepgramApiKey, process.env.DEEPGRAM_API_KEY);
    if (!deepgramApiKey) {
      writeRawHttpError(socket, 503, 'Deepgram API key is not configured');
      return;
    }

    const wss = this.voiceDeepgramWss;
    if (!wss) {
      writeRawHttpError(socket, 503, 'Voice streaming proxy is not available');
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      this.handleDeepgramProxySocket(client, deepgramApiKey);
    });
  }

  private handleDeepgramProxySocket(client: WebSocket, deepgramApiKey: string): void {
    const upstream = new WebSocket(buildDeepgramListenUrl(), {
      headers: {
        Authorization: `Token ${deepgramApiKey}`,
      },
    });
    const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
    let closing = false;

    const closeBoth = (code?: number, reason?: Buffer) => {
      if (closing) {
        return;
      }
      closing = true;
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(code, reason);
      }
    };

    upstream.on('open', () => {
      while (pendingMessages.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const message = pendingMessages.shift();
        if (message) {
          upstream.send(message.data, { binary: message.isBinary });
        }
      }
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    upstream.on('error', (error) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'Error',
          message: `Deepgram streaming connection failed: ${error.message}`,
        }));
      }
      closeBoth(1011);
    });
    upstream.on('close', (code, reason) => {
      closeBoth(code, reason);
    });

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      if (upstream.readyState === WebSocket.CONNECTING) {
        pendingMessages.push({ data, isBinary });
      }
    });
    client.on('error', () => {
      closeBoth(1011);
    });
    client.on('close', (code, reason) => {
      closeBoth(code, reason);
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, withCorsHeaders());
      response.end();
      return;
    }

    if (url.pathname === '/invoke') {
      await this.handleInvokeRequest(request, response);
      return;
    }

    if (url.pathname === '/health') {
      this.handleHealthRequest(request, response);
      return;
    }

    if (url.pathname === '/events') {
      this.handleEventStreamRequest(request, response, url);
      return;
    }

    const remotePwaResponse = await getRemotePwaAssetResponse(url.pathname);
    if (remotePwaResponse.handled) {
      response.writeHead(remotePwaResponse.statusCode ?? 200, withCorsHeaders(remotePwaResponse.headers ?? {}));
      response.end(remotePwaResponse.body ?? '');
      return;
    }

    this.writeJson(response, 404, {
      ok: false,
      error: {
        message: `Remote daemon endpoint "${url.pathname}" does not exist`,
        code: 'ERR_REMOTE_DAEMON_HTTP_NOT_FOUND',
      },
    });
  }

  private async handleInvokeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST') {
      this.writeMethodNotAllowed(response, 'POST');
      return;
    }

    const headerAuth = this.authenticateRequest(request);
    const maxBodyBytes = headerAuth.ok
      ? MAX_AUTHENTICATED_REQUEST_BODY_BYTES
      : MAX_UNAUTHENTICATED_REQUEST_BODY_BYTES;
    let invokeRequest: RemoteInvokeRequest;
    try {
      invokeRequest = await this.readInvokeRequest(request, maxBodyBytes);
    } catch (error) {
      if (error instanceof RemoteDaemonBadRequestError) {
        this.writeJson(response, error.statusCode, {
          ok: false,
          error: {
            message: error.message,
            code: error.code,
          },
        });
        return;
      }

      throw error;
    }

    const auth = headerAuth.ok
      ? headerAuth
      : this.authenticateRequest(request, invokeRequest.token);
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
      return;
    }

    try {
      const result = await this.commandRegistry.invoke(
        invokeRequest.channel,
        this.getInvokeArgsForRequest(invokeRequest, auth, request),
      );
      this.writeJson(response, 200, {
        ok: true,
        result,
      } satisfies RemoteInvokeSuccessPayload, request);
    } catch (error) {
      if (error instanceof RemoteDaemonBadRequestError) {
        this.writeJson(response, error.statusCode, {
          ok: false,
          error: { message: error.message, code: error.code },
        } satisfies RemoteInvokeErrorPayload);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes('No Pane daemon command registered')
        ? 'ERR_UNKNOWN_CHANNEL'
        : 'ERR_REMOTE_DAEMON_REQUEST_FAILED';
      const statusCode = code === 'ERR_UNKNOWN_CHANNEL' ? 404 : 500;

      this.writeJson(response, statusCode, {
        ok: false,
        error: {
          message,
          code,
        },
      } satisfies RemoteInvokeErrorPayload);
    }
  }

  private handleHealthRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== 'GET') {
      this.writeMethodNotAllowed(response, 'GET');
      return;
    }

    this.writeJson(response, 200, {
      ok: true,
      status: 'ready',
      transport: 'http+sse',
    } satisfies RemoteHealthPayload);
  }

  private handleEventStreamRequest(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== 'GET') {
      this.writeMethodNotAllowed(response, 'GET');
      return;
    }

    const auth = this.authenticateRequest(request, url.searchParams.get('access_token'));
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
      return;
    }

    if (url.searchParams.get('auth_check') === '1') {
      response.writeHead(204, withCorsHeaders({
        'Cache-Control': 'no-store',
      }));
      response.end();
      return;
    }

    const compress = acceptsGzip(request);
    const headers: http.OutgoingHttpHeaders = {
      ...REMOTE_DAEMON_CORS_HEADERS,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    };
    if (compress) {
      Object.assign(headers, GZIP_HEADERS);
    }
    response.writeHead(200, headers);
    response.flushHeaders();
    const stream = compress ? createSseGzipStream(response) : response;
    stream.write('retry: 1000\n\n');
    writeSseEvent(stream, 'ready', {
      replay: 'none',
      resync: 'refetch-state-after-reconnect',
      timestamp: new Date().toISOString(),
    } satisfies RemoteReadyEventPayload);

    const clientConnectionId = String(this.nextClientConnectionId++);
    const connectedAt = new Date().toISOString();
    const heartbeatTimer = setInterval(() => {
      this.sendHeartbeat(clientConnectionId);
    }, this.heartbeatIntervalMs);
    const connectedClient: ConnectedRemoteEventClient = {
      id: clientConnectionId,
      stream,
      remoteClientId: auth.client?.id ?? null,
      remoteClientTokenHash: auth.client?.tokenHash ?? null,
      label: auth.client?.label ?? getClientLabelFromRequest(request, url.searchParams.get('client_label')),
      deviceLabel: getClientDeviceLabelFromHeaders(request),
      remoteRuntimeId: getRemoteRuntimeIdFromRequest(request, url.searchParams.get('runtime_id')),
      remoteAddress: getRemoteAddress(request),
      connectedAt,
      lastSeenAt: connectedAt,
      heartbeatTimer,
    };
    this.eventClients.set(clientConnectionId, connectedClient);
    this.publishConnectedClients();
    this.trackRemoteClientConnection(connectedClient, 'connected');
    this.sendHeartbeat(clientConnectionId);

    const cleanup = () => {
      this.dropEventClient(clientConnectionId);
    };

    request.on('close', cleanup);
    response.on('close', cleanup);
  }

  private authenticateRequest(request: IncomingMessage, token?: string | null): RemoteRequestAuthResult {
    const remoteConfig = this.getRemoteConfig();
    if (!remoteConfig.host.config.enabled) {
      return {
        ok: false as const,
        statusCode: 503,
        error: {
          message: 'Remote daemon HTTP API is disabled',
          code: 'ERR_REMOTE_DAEMON_HTTP_DISABLED',
        },
      };
    }

    if (!remoteConfig.host.config.pairingRequired) {
      return {
        ok: true,
        client: null,
      };
    }

    return authenticateRemoteDaemonBearerToken(
      getAuthorizationHeaderForRequest(request, token),
      remoteConfig.host.clients,
    );
  }

  private async readInvokeRequest(
    request: IncomingMessage,
    maxBodyBytes: number,
  ): Promise<RemoteInvokeRequest> {
    const body = await readRequestBody(request, maxBodyBytes);
    if (body.length === 0) {
      throw new RemoteDaemonBadRequestError(
        'ERR_REMOTE_DAEMON_BAD_REQUEST',
        'Remote daemon invoke request body is required',
      );
    }

    try {
      return decodeBoundary(JSON.parse(body), remoteInvokeRequestSchema);
    } catch (error) {
      throw new RemoteDaemonBadRequestError(
        'ERR_REMOTE_DAEMON_BAD_REQUEST',
        `Failed to parse remote daemon invoke request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This HTTP output boundary serializes heterogeneous command and protocol responses as JSON.
    payload: unknown,
    request?: IncomingMessage,
  ): void {
    const body = JSON.stringify(payload);
    const headers = withCorsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
    });
    if (!request || body.length < MIN_GZIP_BODY_BYTES || !acceptsGzip(request)) {
      response.writeHead(statusCode, headers);
      response.end(body);
      return;
    }

    gzip(body, (error, compressed) => {
      if (error) {
        response.writeHead(statusCode, headers);
        response.end(body);
        return;
      }
      response.writeHead(statusCode, { ...headers, ...GZIP_HEADERS });
      response.end(compressed);
    });
  }

  private writeMethodNotAllowed(response: ServerResponse, method: 'GET' | 'POST'): void {
    response.writeHead(405, withCorsHeaders({
      Allow: method,
      'Content-Type': 'application/json; charset=utf-8',
    }));
    response.end(JSON.stringify({
      ok: false,
      error: {
        message: `Remote daemon endpoint only supports ${method}`,
        code: 'ERR_REMOTE_DAEMON_METHOD_NOT_ALLOWED',
      },
    }));
  }

  private shouldKeepEventClient(remoteClientId: string | null, remoteClientTokenHash: string | null): boolean {
    const remoteConfig = this.getRemoteConfig();
    if (!remoteConfig.host.config.enabled) {
      return false;
    }

    if (!remoteConfig.host.config.pairingRequired) {
      return true;
    }

    if (!remoteClientId || !remoteClientTokenHash) {
      return false;
    }

    return remoteConfig.host.clients.some((client) => (
      client.id === remoteClientId &&
      client.tokenHash === remoteClientTokenHash
    ));
  }

  private dropEventClient(clientConnectionId: string): void {
    const client = this.eventClients.get(clientConnectionId);
    if (!client) {
      return;
    }

    clearInterval(client.heartbeatTimer);
    terminalPanelManager.clearVisibilityViewersByPrefix(
      this.getRemoteVisibilityViewerPrefix(client.remoteClientId, client.remoteClientTokenHash, client.remoteRuntimeId),
    );
    this.eventClients.delete(clientConnectionId);
    if (!client.stream.writableEnded) {
      client.stream.end();
    }
    this.publishConnectedClients();
    this.trackRemoteClientConnection(client, 'disconnected');
  }

  private sendHeartbeat(clientConnectionId: string): void {
    const client = this.eventClients.get(clientConnectionId);
    if (!client) {
      return;
    }

    const timestamp = new Date().toISOString();
    try {
      writeSseEvent(client.stream, 'heartbeat', {
        timestamp,
      } satisfies RemoteDaemonHeartbeatPayload);
      client.lastSeenAt = timestamp;
      terminalPanelManager.pruneVisibilityViewersByPrefix(
        this.getRemoteVisibilityViewerPrefix(client.remoteClientId, client.remoteClientTokenHash, client.remoteRuntimeId),
        REMOTE_VISIBILITY_VIEWER_STALE_MS,
      );
      this.publishConnectedClients();
    } catch {
      this.dropEventClient(clientConnectionId);
    }
  }

  private publishConnectedClients(): void {
    remoteHostRuntimeStateStore.setConnectedClients(this.getConnectedClientSnapshots());
  }

  private getConnectedClientSnapshots(): RemoteDaemonConnectedClient[] {
    return [...this.eventClients.values()].map((client) => ({
      id: client.id,
      clientId: client.remoteClientId,
      label: client.label,
      deviceLabel: client.deviceLabel,
      remoteAddress: client.remoteAddress,
      connectedAt: client.connectedAt,
      lastSeenAt: client.lastSeenAt,
    }));
  }

  private getInvokeArgsForRequest(
    invokeRequest: RemoteInvokeRequest,
    auth: Extract<RemoteRequestAuthResult, { ok: true }>,
    request: IncomingMessage,
  ): JsonValue[] {
    const args = [...invokeRequest.args];
    if (invokeRequest.channel.startsWith('mobile:push-')) {
      if (!auth.client) {
        throw new RemoteDaemonBadRequestError(
          'ERR_MOBILE_PUSH_PAIRING_REQUIRED',
          'Mobile notifications require an authenticated paired host.',
          403,
        );
      }
      // The second argument is server-owned, even if the client supplied extra args.
      return [args[0] ?? null, { clientId: auth.client.id }];
    }
    if (invokeRequest.channel !== 'terminal:setVisibility') {
      return args;
    }

    let rawViewerId = 'default';
    try {
      rawViewerId = decodeBoundary(args[2], boundary.nonEmptyString);
    } catch {
      // Missing viewer IDs share the existing default remote visibility scope.
    }
    args[2] = `${this.getRemoteVisibilityViewerPrefix(
      auth.client?.id ?? null,
      auth.client?.tokenHash ?? null,
      getRemoteRuntimeIdFromRequest(request, invokeRequest.runtimeId),
    )}:viewer:${sanitizeVisibilityViewerPart(rawViewerId)}`;
    return args;
  }

  private getRemoteVisibilityViewerPrefix(
    remoteClientId: string | null,
    remoteClientTokenHash: string | null,
    remoteRuntimeId: string | null,
  ): string {
    const clientPart = remoteClientId ?? remoteClientTokenHash ?? 'anonymous';
    const runtimePart = remoteRuntimeId ?? 'legacy-runtime';
    return `remote:${sanitizeVisibilityViewerPart(clientPart)}:${sanitizeVisibilityViewerPart(runtimePart)}`;
  }

  private getRemoteConfig(): RemoteDaemonConfig {
    return this.configManager.getConfig().remoteDaemon ?? createDefaultRemoteDaemonConfig();
  }

  private trackRemoteClientConnection(
    client: ConnectedRemoteEventClient,
    status: 'connected' | 'disconnected',
  ): void {
    const clientKind = getRemoteClientKind(client);
    let eventName: 'remote_pane_pwa_client_connected'
      | 'remote_pane_pwa_client_disconnected'
      | 'remote_pane_client_connected'
      | 'remote_pane_client_disconnected';
    if (clientKind === 'browser_pwa') {
      eventName = status === 'connected'
        ? 'remote_pane_pwa_client_connected'
        : 'remote_pane_pwa_client_disconnected';
    } else {
      eventName = status === 'connected'
        ? 'remote_pane_client_connected'
        : 'remote_pane_client_disconnected';
    }

    this.analyticsSink?.track(eventName, {
      surface: 'host_transport',
      role: 'host',
      flow: 'connect',
      result: 'succeeded',
      client_kind: clientKind,
      connected_client_count_bucket: getConnectedClientCountBucket(this.eventClients.size),
    });
  }
}

function getRemoteClientKind(client: ConnectedRemoteEventClient): 'desktop' | 'browser_pwa' | 'unknown' {
  if (client.deviceLabel) {
    return 'desktop';
  }
  if (client.remoteRuntimeId || client.label) {
    return 'browser_pwa';
  }
  return 'unknown';
}

async function readRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;

    if (totalBytes > maxBodyBytes) {
      throw new RemoteDaemonBadRequestError(
        'ERR_REMOTE_DAEMON_REQUEST_TOO_LARGE',
        `Remote daemon request body exceeds the ${Math.round(maxBodyBytes / (1024 * 1024))} MB limit`,
        413,
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function withCorsHeaders(headers: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    ...REMOTE_DAEMON_CORS_HEADERS,
    ...headers,
  };
}

function writeSseEvent(
  stream: Writable,
  eventName: string,
  payload: RemoteReadyEventPayload | RemoteDaemonEventEnvelope | RemoteDaemonHeartbeatPayload,
): void {
  stream.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function acceptsGzip(request: IncomingMessage): boolean {
  const acceptEncoding = getSingleHeaderValue(request.headers['accept-encoding']) ?? '';
  return acceptEncoding.split(',').some((encoding) => encoding.trim().toLowerCase() === 'gzip');
}

// One shared gzip context per stream keeps the ratio high; a sync flush on
// every write still delivers each SSE event immediately.
function createSseGzipStream(response: ServerResponse): Writable {
  const gzipStream = createGzip({ flush: zlibConstants.Z_SYNC_FLUSH });
  pipeline(gzipStream, response, () => {});
  return gzipStream;
}

function writeRawHttpError(socket: Duplex, statusCode: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }

  const body = JSON.stringify({
    ok: false,
    error: {
      message,
      code: 'ERR_REMOTE_DAEMON_WEBSOCKET_FAILED',
    },
  });
  socket.write(
    `HTTP/1.1 ${statusCode} ${getHttpStatusText(statusCode)}\r\n` +
    'Content-Type: application/json; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    body,
  );
  socket.destroy();
}

function getHttpStatusText(statusCode: number): string {
  switch (statusCode) {
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 500:
      return 'Internal Server Error';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Error';
  }
}

function buildDeepgramListenUrl(): string {
  const url = new URL(DEEPGRAM_LISTEN_ENDPOINT);
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '300');
  url.searchParams.set('vad_events', 'true');
  url.searchParams.set('tag', 'pane-pwa-voice');
  for (const term of DEEPGRAM_STREAMING_KEYTERMS) {
    url.searchParams.append('keyterm', term);
  }
  return url.toString();
}

function getClientLabelFromHeaders(request: IncomingMessage): string | null {
  return getSingleHeaderValue(request.headers['x-pane-client-label']);
}

function getClientLabelFromRequest(request: IncomingMessage, fallback?: string | null): string | null {
  return getClientLabelFromHeaders(request) ?? getSingleString(fallback);
}

function getClientDeviceLabelFromHeaders(request: IncomingMessage): string | null {
  return getSingleHeaderValue(request.headers['x-pane-client-device-label']);
}

function getRemoteRuntimeIdFromHeaders(request: IncomingMessage): string | null {
  return getSingleHeaderValue(request.headers['x-pane-remote-runtime-id']);
}

function getRemoteRuntimeIdFromRequest(request: IncomingMessage, fallback?: string | null): string | null {
  return getRemoteRuntimeIdFromHeaders(request) ?? getSingleString(fallback);
}

function getAuthorizationHeaderForRequest(
  request: IncomingMessage,
  token?: string | null,
): string | string[] | undefined {
  const bodyToken = getSingleString(token);
  return bodyToken ? `Bearer ${bodyToken}` : request.headers.authorization;
}

function sanitizeVisibilityViewerPart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return sanitized || 'unknown';
}

function getRemoteAddress(request: IncomingMessage): string | null {
  const forwardedFor = getSingleHeaderValue(request.headers['x-forwarded-for']);
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || null;
  }

  return request.socket.remoteAddress ?? null;
}

function getSingleHeaderValue(value: string | string[] | undefined): string | null {
  const headerValue = Array.isArray(value) ? value[0] : value;
  return getSingleString(headerValue);
}

function getSingleString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map(value => value?.trim()).find(Boolean);
}

function isTcpAddress(address: string | AddressInfo | null): address is AddressInfo {
  return address !== null && 'port' in Object(address);
}
