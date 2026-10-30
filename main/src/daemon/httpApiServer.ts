import http, { type IncomingMessage, type ServerResponse } from 'http';
import { pipeline as pipelineCallback, Readable, type Duplex, type Writable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { pipeline } from 'stream/promises';
import { constants as zlibConstants, createGzip, gzip } from 'zlib';
import net, { type AddressInfo } from 'net';
import WebSocket, { createWebSocketStream, type RawData, WebSocketServer } from 'ws';
import { createFanoutEventSink, noopPaneEventSink, type PaneEventSink } from '../core/eventSink';
import type { ConfigManager } from '../services/configManager';
import {
  getConnectedClientCountBucket,
  type RemotePaneAnalyticsSink,
} from '../services/remoteAnalytics';
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { PaneCommandRegistry } from './commandRegistry';
import { authenticateRemoteDaemonBearerToken, authenticateWorkspaceRequest, type WorkspaceAccessPolicy } from './auth';

export type { WorkspaceAccessPolicy } from './auth';
import { isPaneDaemonEventChannel } from './server';
import {
  GLASSES_CHANNELS,
  GLASSES_EVENT_CHANNELS,
  glassesKeyInput,
  glassesSource,
  type GlassesAccess,
  type GlassesFailureReason,
} from './glassesAccess';
import { GLASSES_COMMANDS, GLASSES_TOKEN_PREFIX, GLASSES_WEBSOCKET_PROTOCOL } from '../../../shared/types/glasses';
import {
  createDefaultRemoteDaemonConfig,
  getRemoteDaemonHostConfigValidationError,
  NATIVE_APP_WEBSOCKET_ORIGIN,
  type RemoteDaemonConnectedClient,
  type RemoteDaemonConfig,
  type RemoteDaemonEventEnvelope,
  type RemoteDaemonHeartbeatPayload,
  type RemoteInvokeRequest,
} from '../../../shared/types/remoteDaemon';
import { remoteHostRuntimeStateStore } from './remoteHostRuntimeState';
import { getRemotePwaAssetResponse } from './pwaStaticAssets';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { BoundarySchema, JsonValue } from '../../../shared/validation/boundaryDecoder';
import { serializeJsonTransport } from './jsonTransport';
import { toPaneDaemonError } from '../../../shared/paneError';
import type { VoiceStreamErrorCode } from '../../../shared/voice/deepgramLive';
import { voiceKeyProblem } from '../../../shared/voice/voiceKeys';
import { streamWorktreePreview } from '../services/mediaStream';
import { RecentWrites, type InvokeAnswer } from './recentWrites';
import { REMOTE_WRITES_BUSY_CODE } from '../../../shared/remoteClient/readChannels';

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
  requestId: boundary.optional(boundary.refine(boundary.string, (id) => id.length > 0 && id.length <= 128, 'expected a request id of 1 to 128 characters')),
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
  /** What a workspace client signed in with, checked again before each event it receives. */
  workspaceCredentials: WorkspaceCredentials | null;
  /**
   * Set for the Pane glasses app to the origin it came in with: its stream carries only
   * GLASSES_EVENT_CHANNELS, and ends when that origin is no longer allowed.
   */
  glassesOrigin: string | null;
}

/** Who signed in, kept so access can be checked again after the request was admitted. */
type AdmittedIdentity = Pick<ConnectedRemoteEventClient, 'remoteClientId' | 'remoteClientTokenHash' | 'workspaceCredentials' | 'glassesOrigin'>;

interface WorkspaceRefusal {
  statusCode: number;
  error: { message: string; code: string; next?: string };
}

/**
 * A request the glasses path admitted: owner identity, an allowed origin, no Funnel, and the
 * source not locked out. `client` is the device its token names, or null for a pairing call.
 */
interface GlassesAdmission {
  client: { id: string; tokenHash: string; label: string; origin: string } | null;
  source: string;
}

function glassesIdentity(client: NonNullable<GlassesAdmission['client']>): AdmittedIdentity {
  return { remoteClientId: client.id, remoteClientTokenHash: client.tokenHash, workspaceCredentials: null, glassesOrigin: client.origin };
}

interface WorkspaceCredentials {
  login: string | string[] | undefined;
  authorization: string | string[] | undefined;
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
    next?: string;
  };
}

interface RemoteReadyEventPayload {
  replay: 'none';
  resync: 'refetch-state-after-reconnect';
  timestamp: string;
  /** This host's Pane version, for the client's version check. Hosts before it omit it. */
  paneVersion?: string;
  /** A write repeated with the same `requestId` runs once and gets the first answer, so clients may resend. Hosts before it omit it. */
  deduplicatesRequestIds: true;
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
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REMOTE_DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
const REMOTE_VISIBILITY_VIEWER_STALE_MS = 15 * 60 * 1000;
const MIN_GZIP_BODY_BYTES = 1024;
const GZIP_HEADERS = { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } as const;
const DEEPGRAM_LISTEN_ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const VOICE_DEEPGRAM_STREAM_PATH = '/voice/deepgram-stream';
/** `/ports/<port>`: a WebSocket that carries raw TCP bytes to that host loopback port. */
const PORT_STREAM_PATH = /^\/ports\/(\d{1,5})$/;
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
  /** Serve workspaces on loopback behind Tailscale Serve, trusting the Tailscale logins `access` allows. */
  workspace?: WorkspaceIdentityOptions;
  /** Whether a port is in the host's forwarded list; port streams reach only those. Without it, none. */
  isForwardedPort?(port: number): boolean;
  /** Where the voice proxy reaches Deepgram's streaming API; Deepgram's own by default. */
  deepgramListenEndpoint?: string;
  /** Sent to signed-in clients on the ready event. */
  paneVersion?: string;
}

interface WorkspaceIdentityOptions {
  listenPort: number;
  /**
   * Tailscale Serve's target path, secret per launch. Serve prefixes every request with it, so
   * another OS user who finds the loopback port cannot call it directly.
   */
  pathSecret: string;
  /** Who may connect right now; null refuses every request. */
  access(): WorkspaceAccessPolicy | null;
  /** Admits the Pane glasses app with a per-device token; without it, every browser is refused. */
  glasses?: GlassesAccess;
}

/** Commands that act on the whole machine: workspace identity only, never pairing tokens. */
const WORKSPACE_ONLY_CHANNEL_PREFIXES = ['runpane:machine:', 'runpane:glasses:'];

const WORKSPACE_LISTEN_HOST = '127.0.0.1';

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
  private portStreamWss: WebSocketServer | null = null;
  /** Open port and glasses voice streams and who opened them; each one closes when its caller loses access. */
  private readonly admittedSockets = new Map<WebSocket, AdmittedIdentity>();
  private admittedSocketCheckTimer: NodeJS.Timeout | null = null;
  private readonly eventClients = new Map<string, ConnectedRemoteEventClient>();
  private readonly deviceLabelsByRuntime = new Map<string, string>();
  private readonly recentWrites = new RecentWrites();
  private readonly daemonEventSink: PaneEventSink;
  private address: RemoteHttpAddress | null = null;
  private nextClientConnectionId = 1;
  private readonly heartbeatIntervalMs: number;
  private readonly analyticsSink?: RemotePaneAnalyticsSink;
  private readonly workspace?: WorkspaceIdentityOptions;
  private readonly isForwardedPort: (port: number) => boolean;
  private readonly deepgramListenEndpoint: string;
  private readonly glassesAdmissions = new WeakMap<IncomingMessage, GlassesAdmission>();
  private stopWatchingGlassesRevokes: (() => void) | null = null;
  private readonly paneVersion?: string;

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    private readonly configManager: RemoteHttpConfigProvider,
    options: PaneRemoteHttpApiServerOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_REMOTE_DAEMON_HEARTBEAT_INTERVAL_MS;
    this.analyticsSink = options.analyticsSink;
    this.workspace = options.workspace;
    this.isForwardedPort = options.isForwardedPort ?? (() => false);
    this.deepgramListenEndpoint = options.deepgramListenEndpoint ?? DEEPGRAM_LISTEN_ENDPOINT;
    this.paneVersion = options.paneVersion;
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
            if (client.glassesOrigin !== null && !GLASSES_EVENT_CHANNELS.has(channel)) {
              continue;
            }
            if (!this.isStillAdmitted(client)) {
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

    const streams = [...this.admittedSockets.entries()]
      .filter(([, identity]) => !clientIdSet || (identity.remoteClientId !== null && clientIdSet.has(identity.remoteClientId)))
      .map(([stream]) => stream);
    for (const stream of streams) {
      stream.terminate();
    }

    return clientConnectionIds.length + streams.length;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Remote daemon HTTP API server is already running');
    }

    const listen = this.workspace
      ? { host: WORKSPACE_LISTEN_HOST, port: this.workspace.listenPort }
      : this.getValidatedPairingListenAddress();

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
    // Phones on slow links send uploads in chunks that can take minutes each;
    // Node's default 300 s per request would cut one off on a bad link.
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    const voiceDeepgramWss = new WebSocketServer({
      noServer: true,
      // The glasses app names its token in the subprotocol list; the handshake answers with the protocol only.
      handleProtocols: (protocols) => (protocols.has(GLASSES_WEBSOCKET_PROTOCOL) ? GLASSES_WEBSOCKET_PROTOCOL : false),
    });
    this.voiceDeepgramWss = voiceDeepgramWss;
    this.portStreamWss = new WebSocketServer({ noServer: true });
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
      server.listen(listen.port, listen.host);
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
      host: listen.host,
      port: address.port,
    };
    this.stopWatchingGlassesRevokes = this.workspace?.glasses?.onRevoked((id) => this.disconnectClients([id])) ?? null;
  }

  private getValidatedPairingListenAddress(): RemoteHttpAddress {
    const hostConfig = this.getRemoteConfig().host.config;
    if (!hostConfig.enabled) {
      throw new Error('Remote daemon HTTP API server is disabled in config');
    }

    const hostConfigError = getRemoteDaemonHostConfigValidationError(hostConfig);
    if (hostConfigError) {
      throw new Error(hostConfigError);
    }
    return { host: hostConfig.listenHost, port: hostConfig.listenPort };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.address = null;
    this.stopWatchingGlassesRevokes?.();
    this.stopWatchingGlassesRevokes = null;
    if (this.admittedSocketCheckTimer) clearInterval(this.admittedSocketCheckTimer);
    this.admittedSocketCheckTimer = null;
    const webSocketServers = [this.voiceDeepgramWss, this.portStreamWss];
    this.voiceDeepgramWss = null;
    this.portStreamWss = null;
    for (const wss of webSocketServers) {
      if (!wss) continue;
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
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
    if (this.workspace) {
      const refusal = this.admitWorkspace(request, this.workspace.pathSecret);
      if (refusal) {
        writeRawHttpError(socket, refusal.statusCode, refusal.error.message, refusal.error.code);
        return;
      }
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const glasses = this.glassesAdmissions.get(request);
    if (glasses && (!glasses.client || url.pathname !== VOICE_DEEPGRAM_STREAM_PATH)) {
      writeRawHttpError(socket, 403, 'Glasses reach only the voice stream, with a device token.', 'ERR_GLASSES_ENDPOINT_REFUSED');
      return;
    }
    const portMatch = PORT_STREAM_PATH.exec(url.pathname);
    if (portMatch) {
      this.handlePortStreamUpgrade(request, socket, head, Number(portMatch[1]), url);
      return;
    }
    if (url.pathname !== VOICE_DEEPGRAM_STREAM_PATH) {
      socket.destroy();
      return;
    }

    const auth = glasses ? { ok: true as const } : this.authenticateRequest(request, url.searchParams.get('access_token'));
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
      const glassesClient = glasses?.client;
      if (glassesClient) this.trackAdmittedSocket(client, glassesIdentity(glassesClient));
      this.handleDeepgramProxySocket(client, deepgramApiKey);
    });
  }

  /**
   * Connects an authenticated client to a host loopback port in the forwarded list and copies raw
   * bytes both ways, one WebSocket per TCP connection the client accepted.
   */
  private handlePortStreamUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, port: number, url: URL): void {
    const auth = this.authenticateRequest(request, url.searchParams.get('access_token'));
    if (!auth.ok) {
      writeRawHttpError(socket, auth.statusCode, auth.error.message, auth.error.code);
      return;
    }
    if (!this.isForwardedPort(port)) {
      writeRawHttpError(socket, 403, `Port ${port} is not forwarded from this host`, 'ERR_PORT_NOT_FORWARDED');
      return;
    }
    const wss = this.portStreamWss;
    if (!wss) {
      writeRawHttpError(socket, 503, 'Port forwarding is not available');
      return;
    }
    const identity: AdmittedIdentity = {
      remoteClientId: auth.client?.id ?? null,
      remoteClientTokenHash: auth.client?.tokenHash ?? null,
      workspaceCredentials: this.workspace
        ? {
          login: request.headers['tailscale-user-login'],
          authorization: getAuthorizationHeaderForRequest(request, url.searchParams.get('access_token')),
        }
        : null,
      glassesOrigin: null,
    };
    wss.handleUpgrade(request, socket, head, (client) => {
      this.trackAdmittedSocket(client, identity);
      // By name, so a service on either IPv4 or IPv6 loopback answers.
      const upstream = net.connect({ host: 'localhost', port });
      const stream = createWebSocketStream(client);
      pipelineCallback(stream, upstream, stream, () => {
        upstream.destroy();
        client.terminate();
      });
      client.once('close', () => upstream.destroy());
    });
  }

  /**
   * A removed pairing code, narrower visibility, a new password, a revoked glasses device or a
   * removed glasses origin closes the socket within one heartbeat.
   */
  private trackAdmittedSocket(client: WebSocket, identity: AdmittedIdentity): void {
    this.admittedSockets.set(client, identity);
    this.admittedSocketCheckTimer ??= setInterval(() => {
      for (const [stream, admitted] of this.admittedSockets) {
        if (!this.isStillAdmitted(admitted)) stream.terminate();
      }
    }, this.heartbeatIntervalMs);
    this.admittedSocketCheckTimer.unref?.();
    client.once('close', () => {
      this.admittedSockets.delete(client);
      if (this.admittedSockets.size === 0 && this.admittedSocketCheckTimer) {
        clearInterval(this.admittedSocketCheckTimer);
        this.admittedSocketCheckTimer = null;
      }
    });
  }

  private handleDeepgramProxySocket(client: WebSocket, deepgramApiKey: string): void {
    /** Tells the client why its stream ended, in an Error frame with a code, then closes it. */
    const refuse = (code: VoiceStreamErrorCode, message: string) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'Error', code, message }));
      client.close(1011);
    };
    const fix = 'Fix it in Pane on this computer: Settings › Integrations › Voice transcription.';
    const keyProblem = voiceKeyProblem('deepgramApiKey', deepgramApiKey);
    if (keyProblem) {
      refuse('ERR_VOICE_KEY_INVALID', `The Deepgram key saved on this computer can't be used. ${keyProblem.message} ${fix}`);
      return;
    }
    const upstream = new WebSocket(buildDeepgramListenUrl(this.deepgramListenEndpoint), {
      headers: {
        Authorization: `Token ${deepgramApiKey}`,
      },
    });
    const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];
    let closing = false;

    const closeBoth = (received?: number, receivedReason?: Buffer) => {
      if (closing) {
        return;
      }
      closing = true;
      // 1005, 1006 and 1015 only report a close that sent no code (a terminated socket); they can't be sent on.
      const forwardable = received !== undefined && received !== 1005 && received !== 1006 && received !== 1015;
      const code = forwardable ? received : undefined;
      const reason = forwardable ? receivedReason : undefined;
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
    // Deepgram answers a refused key with an HTTP status instead of upgrading.
    upstream.on('unexpected-response', (request, response) => {
      request.destroy();
      const status = response.statusCode ?? 0;
      if (closing) return;
      closing = true;
      if (status === 401 || status === 403) refuse('ERR_VOICE_KEY_REJECTED', `Deepgram rejected the key saved on this computer (HTTP ${status}). ${fix}`);
      else refuse('ERR_VOICE_UPSTREAM', `Deepgram refused the stream (HTTP ${status}).`);
    });
    upstream.on('error', (error) => {
      if (closing) return;
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'Error',
          code: 'ERR_VOICE_UPSTREAM' satisfies VoiceStreamErrorCode,
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
    if (this.workspace) {
      const refusal = this.admitWorkspace(request, this.workspace.pathSecret);
      if (refusal) {
        this.writeJson(response, refusal.statusCode, { ok: false, error: refusal.error } satisfies RemoteInvokeErrorPayload);
        return;
      }
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, withCorsHeaders());
      response.end();
      return;
    }

    const glasses = this.glassesAdmissions.get(request);
    if (glasses) {
      await this.handleGlassesRequest(request, response, url, glasses);
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

    if (url.pathname === '/media') {
      await this.handleMediaRequest(request, response, url);
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

    // The header check only sizes the upload; access can change while the body arrives.
    const auth = this.authenticateRequest(request, headerAuth.ok ? undefined : invokeRequest.token);
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
      return;
    }
    if (!this.workspace && WORKSPACE_ONLY_CHANNEL_PREFIXES.some((prefix) => invokeRequest.channel.startsWith(prefix))) {
      this.writeJson(response, 403, {
        ok: false,
        error: {
          message: 'Machine commands are available only to the owner\'s own devices through runpane workspace.',
          code: 'ERR_WORKSPACE_ONLY_COMMAND',
        },
      } satisfies RemoteInvokeErrorPayload);
      return;
    }

    // Glasses are paired, listed and revoked by their owner; the glasses themselves pair only
    // through the glasses path, with a pairing secret.
    if (invokeRequest.channel.startsWith('runpane:glasses:')) {
      if (invokeRequest.channel === GLASSES_COMMANDS.pair || !this.workspaceOwnerLogin(request)) {
        this.writeJson(response, 403, {
          ok: false,
          error: {
            message: 'Only this computer\'s owner can pair, list or revoke glasses, from their own Pane app or this computer.',
            code: 'ERR_GLASSES_OWNER_REQUIRED',
          },
        } satisfies RemoteInvokeErrorPayload);
        return;
      }
    }

    // Discovery probes peers as this computer's owner, so only that same identity may
    // request its view. A paired client or another tailnet user must use their own computer.
    if (invokeRequest.channel === 'runpane:workspaces:machines') {
      if (!this.workspaceOwnerLogin(request)) {
        this.writeJson(response, 403, {
          ok: false,
          error: {
            message: 'Find computers using an address on your own Tailscale login.',
            code: 'ERR_WORKSPACE_DISCOVERY_OWNER_REQUIRED',
          },
        } satisfies RemoteInvokeErrorPayload);
        return;
      }
    }

    const login = getSingleHeaderValue(request.headers['tailscale-user-login'])?.trim().toLowerCase();
    await this.respondToInvoke(request, response, invokeRequest.requestId, auth.client?.id ?? (login ? `login:${login}` : 'open'), () => this.commandRegistry.invokeRemote(
      invokeRequest.channel,
      this.getInvokeArgsForRequest(invokeRequest, auth, request),
    ));
  }

  /** Answers a write; one carrying a `requestId` runs once per client and id, and a repeat gets the first answer. */
  private async respondToInvoke(
    request: IncomingMessage,
    response: ServerResponse,
    requestId: string | undefined,
    client: string,
    run: () => ReturnType<PaneCommandRegistry['invokeRemote']>,
  ): Promise<void> {
    const remembered = requestId ? this.recentWrites.answer(client, requestId, () => answerInvoke(run)) : null;
    if (remembered === 'full') {
      this.writeJson(response, 503, {
        ok: false,
        error: {
          message: 'This computer is still holding answers to this device\'s recent actions, so it did not run this one yet.',
          code: REMOTE_WRITES_BUSY_CODE,
          next: 'Pane sends it again by itself in a moment.',
        },
      } satisfies RemoteInvokeErrorPayload);
      return;
    }
    const answer = remembered ? await remembered : (await answerInvoke(run)).answer;
    this.writeJson(response, answer.statusCode, answer.payload, request);
  }

  /** File previews for remote desktops; Range passes through so media can seek. */
  private async handleMediaRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      this.writeMethodNotAllowed(response, 'GET');
      return;
    }
    const auth = this.authenticateRequest(request);
    if (!auth.ok) {
      this.writeJson(response, auth.statusCode, auth);
      return;
    }
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    const range = request.headers.range;
    const media = await streamWorktreePreview(this.commandRegistry, {
      sessionId: url.searchParams.get('sessionId') ?? '',
      filePath: url.searchParams.get('filePath') ?? '',
    }, new Request(url, { method: request.method, headers: range ? { Range: range } : {}, signal: abort.signal }));
    const headers: http.OutgoingHttpHeaders = {};
    media.headers.forEach((value, name) => { headers[name] = value; });
    response.writeHead(media.status, withCorsHeaders(headers));
    if (!media.body) {
      response.end();
      return;
    }
    // SAFETY: the DOM and Node typings describe the same WHATWG ReadableStream.
    // A client that stops reading (a seek) closes the response; that ends the file read.
    await pipeline(Readable.fromWeb(media.body as NodeReadableStream<Uint8Array>), response).catch(() => {});
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

  private handleEventStreamRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    glassesClient?: NonNullable<GlassesAdmission['client']>,
  ): void {
    if (request.method !== 'GET') {
      this.writeMethodNotAllowed(response, 'GET');
      return;
    }

    const auth: RemoteRequestAuthResult = glassesClient
      ? { ok: true, client: glassesClient }
      : this.authenticateRequest(request, url.searchParams.get('access_token'));
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
    const ready: RemoteReadyEventPayload = {
      replay: 'none',
      resync: 'refetch-state-after-reconnect',
      timestamp: new Date().toISOString(),
      deduplicatesRequestIds: true,
    };
    if (this.paneVersion) ready.paneVersion = this.paneVersion;
    writeSseEvent(stream, 'ready', ready);

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
      workspaceCredentials: this.workspace && !glassesClient
        ? {
          login: request.headers['tailscale-user-login'],
          authorization: getAuthorizationHeaderForRequest(request, url.searchParams.get('access_token')),
        }
        : null,
      glassesOrigin: glassesClient?.origin ?? null,
    };
    this.eventClients.set(clientConnectionId, connectedClient);
    if (connectedClient.remoteRuntimeId && connectedClient.deviceLabel) {
      // A phone answers from an alert button with no stream open; it keeps the name it gave here.
      this.deviceLabelsByRuntime.set(connectedClient.remoteRuntimeId, connectedClient.deviceLabel);
    }
    this.publishConnectedClients();
    this.trackRemoteClientConnection(connectedClient, 'connected');
    this.sendHeartbeat(clientConnectionId);

    const cleanup = () => {
      this.dropEventClient(clientConnectionId);
    };

    request.on('close', cleanup);
    response.on('close', cleanup);
  }

  /**
   * Strips Serve's secret path prefix, or returns why the request is refused: direct loopback
   * callers and every browser request are.
   */
  private admitWorkspace(request: IncomingMessage, pathSecret: string): WorkspaceRefusal | null {
    const prefix = `/${pathSecret}`;
    const rawUrl = request.url ?? '/';
    if (rawUrl !== prefix && !rawUrl.startsWith(`${prefix}/`) && !rawUrl.startsWith(`${prefix}?`)) {
      return { statusCode: 404, error: { message: 'Not found', code: 'ERR_REMOTE_DAEMON_HTTP_NOT_FOUND' } };
    }
    const glasses = this.workspace?.glasses;
    const origin = request.headers.origin;
    const glassesToken = readGlassesToken(request);
    if (glasses && (glassesToken !== null || glasses.allowsOrigin(origin))) {
      const refusal = this.admitGlasses(request, glasses, glassesToken, rawUrl);
      if (refusal) return refusal;
      request.url = rawUrl.slice(prefix.length) || '/';
      return null;
    }
    // Serve signs every request from the owner's devices, including ones a web page sends from
    // the owner's browser; only Pane and the runpane CLI, which send no Origin, and the native
    // app, whose WebSockets send an Origin no browser can, may use workspaces. The glasses app
    // is admitted above, with its own token.
    if ((origin !== undefined && origin !== NATIVE_APP_WEBSOCKET_ORIGIN) || request.method === 'OPTIONS') {
      if (origin && origin !== NATIVE_APP_WEBSOCKET_ORIGIN) glasses?.noteRefusedOrigin(origin);
      return {
        statusCode: 403,
        error: { message: 'Workspaces answer the runpane CLI, not browsers.', code: 'ERR_WORKSPACE_BROWSER_REFUSED' },
      };
    }
    request.url = rawUrl.slice(prefix.length) || '/';
    return null;
  }

  /**
   * The glasses path: a request is admitted only with the owner's Tailscale identity, an Even
   * app origin, no Funnel, no credential in the URL, a source that is not locked out, and a valid
   * device token (or, for pairing alone, no token). Every refusal past the lockout is logged and
   * counted against the source.
   */
  private admitGlasses(request: IncomingMessage, glasses: GlassesAccess, token: string | null, rawUrl: string): WorkspaceRefusal | null {
    const origin = getSingleHeaderValue(request.headers.origin);
    if (request.method === 'OPTIONS') {
      // A preflight carries no credentials: an allowed origin gets CORS headers and no data.
      if (glasses.allowsOrigin(origin ?? undefined)) return null;
      return { statusCode: 403, error: { message: 'Workspaces answer the runpane CLI, not browsers.', code: 'ERR_WORKSPACE_BROWSER_REFUSED' } };
    }
    const source = glassesSource(
      getSingleHeaderValue(request.headers['tailscale-user-login']),
      getSingleHeaderValue(request.headers['x-forwarded-for']),
      request.socket.remoteAddress,
    );
    const lockedMs = glasses.lockedFor(source);
    if (lockedMs > 0) {
      const seconds = Math.ceil(lockedMs / 1000);
      return {
        statusCode: 429,
        error: {
          message: `This computer refused too many glasses requests from this device, so it is ignoring it for ${seconds} s.`,
          code: 'ERR_GLASSES_LOCKED_OUT',
          next: `Wait ${seconds} s. If you did not cause these, revoke the glasses in Pane's Settings › Remote Access.`,
        },
      };
    }
    const refuse = (reason: GlassesFailureReason, statusCode: number, code: string, message: string, next: string, detail?: string): WorkspaceRefusal => {
      glasses.recordFailure(source, reason, detail);
      return { statusCode, error: { message, code, next } };
    };
    if (request.headers['tailscale-funnel-request'] !== undefined || glasses.isFunnelOn()) {
      return refuse('funnel', 403, 'ERR_GLASSES_FUNNEL_REFUSED',
        'Tailscale Funnel is on for this computer\'s workspace port, so it is reachable from the internet; glasses work only inside your tailnet.',
        'Turn Funnel off for this port with "tailscale funnel reset" (or "tailscale funnel --https=8443 off"); glasses reconnect on their own.');
    }
    if (!glasses.allowsOrigin(origin ?? undefined)) {
      if (origin) glasses.noteRefusedOrigin(origin);
      return refuse('origin', 403, 'ERR_GLASSES_ORIGIN_REFUSED',
        `This computer accepts glasses tokens only from the Even app; this request came from ${origin ?? 'no origin'}.`,
        'Open Pane from the Even app. If this is the Even app, allow this origin on the computer in Settings › Remote Access › Devices.',
        `origin ${origin ?? 'none'}`);
    }
    if (new URL(rawUrl, 'http://localhost').searchParams.has('access_token')) {
      return refuse('credential-in-url', 400, 'ERR_GLASSES_CREDENTIAL_IN_URL',
        'Glasses credentials go only in the Authorization header or the WebSocket subprotocol, never in a URL; this request was refused.',
        'Update the Pane glasses app.');
    }
    // Serve sends exactly one login; a repeated header is not Serve's.
    if (Array.isArray(request.headers['tailscale-user-login']) || !this.workspaceOwnerLogin(request)) {
      return refuse('identity', 403, 'ERR_GLASSES_IDENTITY_REQUIRED',
        'Glasses work only through your own Tailscale login; this request came without it or from someone else.',
        'Sign the phone in to Tailscale with the same login as this computer.');
    }
    if (token === null) {
      this.glassesAdmissions.set(request, { client: null, source });
      return null;
    }
    const client = glasses.verifyToken(token);
    if (!client) {
      return refuse('token', 401, 'ERR_GLASSES_TOKEN_INVALID',
        'These glasses are not paired with this computer, or were revoked.',
        'Pair again from the Pane app: Settings › Glasses › Pair glasses.');
    }
    glasses.touch(client.id);
    this.glassesAdmissions.set(request, { client: { id: client.id, tokenHash: client.tokenHash, label: client.label, origin: origin ?? '' }, source });
    return null;
  }

  /** What an admitted glasses request may reach: pairing, its allowlisted commands, its scoped stream, and health. */
  private async handleGlassesRequest(request: IncomingMessage, response: ServerResponse, url: URL, admission: GlassesAdmission): Promise<void> {
    const glasses = this.workspace?.glasses;
    if (url.pathname === '/health') {
      this.handleHealthRequest(request, response);
      return;
    }
    if (url.pathname === '/events' && admission.client) {
      this.handleEventStreamRequest(request, response, url, admission.client);
      return;
    }
    if (url.pathname !== '/invoke' || !glasses) {
      this.writeJson(response, 403, {
        ok: false,
        error: { message: `Glasses can't use ${url.pathname} on this computer.`, code: 'ERR_GLASSES_ENDPOINT_REFUSED' },
      } satisfies RemoteInvokeErrorPayload);
      return;
    }
    if (request.method !== 'POST') {
      this.writeMethodNotAllowed(response, 'POST');
      return;
    }
    let invokeRequest: RemoteInvokeRequest;
    try {
      invokeRequest = await this.readInvokeRequest(request, admission.client ? MAX_AUTHENTICATED_REQUEST_BODY_BYTES : MAX_UNAUTHENTICATED_REQUEST_BODY_BYTES);
    } catch (error) {
      if (!(error instanceof RemoteDaemonBadRequestError)) throw error;
      this.writeJson(response, error.statusCode, { ok: false, error: { message: error.message, code: error.code } } satisfies RemoteInvokeErrorPayload);
      return;
    }
    const { channel } = invokeRequest;
    const refuse = (statusCode: number, code: string, message: string, next?: string) => {
      this.writeJson(response, statusCode, { ok: false, error: next ? { message, code, next } : { message, code } } satisfies RemoteInvokeErrorPayload);
    };
    // The body can arrive long after admission; a revoke, a removed origin or Funnel turned on meanwhile refuses it.
    const stillAdmitted = admission.client
      ? this.isStillAdmitted(glassesIdentity(admission.client))
      : glasses.allowsOrigin(getSingleHeaderValue(request.headers.origin) ?? undefined) && !glasses.isFunnelOn();
    if (!stillAdmitted) {
      refuse(403, 'ERR_GLASSES_ACCESS_WITHDRAWN', 'These glasses lost access to this computer while the request was arriving; it was not run.',
        'Check Settings › Remote Access › Devices on the computer, then pair again if the glasses were revoked.');
      return;
    }

    if (channel === GLASSES_COMMANDS.pair) {
      const secret = decodeOptionalBoundary(decodeOptionalBoundary(invokeRequest.args[0], boundary.jsonObject)?.secret, boundary.string);
      if (admission.client || !secret) {
        refuse(400, 'ERR_GLASSES_PAIR_BAD_REQUEST', 'Pairing takes one pairing secret and no device token.');
        return;
      }
      const paired = await glasses.pair(secret);
      if (!paired) {
        glasses.recordFailure(admission.source, 'pairing-secret');
        refuse(403, 'ERR_GLASSES_PAIRING_SECRET_INVALID',
          'This pairing code was already used or is more than 10 minutes old; these glasses were not paired with this computer.',
          'Make a new code in the Pane app: Settings › Glasses › Pair glasses, then paste it again.');
        return;
      }
      this.writeJson(response, 200, { ok: true, result: paired } satisfies RemoteInvokeSuccessPayload);
      return;
    }
    if (!admission.client) {
      glasses.recordFailure(admission.source, 'token');
      refuse(401, 'ERR_GLASSES_TOKEN_REQUIRED', 'Glasses need their device token for this.', 'Pair again from the Pane app: Settings › Glasses › Pair glasses.');
      return;
    }
    if (!GLASSES_CHANNELS.has(channel)) {
      glasses.recordFailure(admission.source, 'channel', channel);
      refuse(403, 'ERR_GLASSES_CHANNEL_REFUSED', `Glasses can't run ${channel}; they can list Panes, read and type into terminals, dictate, and answer Notify.`);
      return;
    }
    const client = admission.client;
    let args = invokeRequest.args;
    // The Notify answer is stamped with the glasses' own name, never one from the request.
    if (channel === 'notify:remote-command') args = [invokeRequest.args[0] ?? null, { device: client.label }];
    if (channel === 'runpane:panels:input') {
      const key = invokeRequest.args.length === 1 ? glassesKeyInput(invokeRequest.args[0]) : null;
      if (!key) {
        // Logged without the input, which could be anything the request carried.
        glasses.recordFailure(admission.source, 'key');
        refuse(400, 'ERR_GLASSES_KEY_REFUSED', 'Glasses can send only one key at a time: up, down, Enter, Esc, Tab or a digit from 1 to 9. Nothing was typed.',
          'Update the Pane glasses app, then try again.');
        return;
      }
      args = [key];
    }
    await this.respondToInvoke(request, response, invokeRequest.requestId, client.id, () => this.commandRegistry.invokeRemote(channel, args));
  }

  private authenticateRequest(request: IncomingMessage, token?: string | null): RemoteRequestAuthResult {
    if (this.workspace) {
      return authenticateWorkspaceRequest(
        request.headers['tailscale-user-login'],
        getAuthorizationHeaderForRequest(request, token),
        this.workspace.access(),
      );
    }
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
      // Glasses tokens are admitted only on the workspace listener, with their narrow scope.
      remoteConfig.host.clients.filter((client) => client.kind !== 'glasses'),
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

  private isStillAdmitted(client: AdmittedIdentity): boolean {
    const { remoteClientId, remoteClientTokenHash, workspaceCredentials } = client;
    if (client.glassesOrigin !== null) {
      // A revoked device, an origin the owner removed, or Funnel turned on ends the stream.
      const glasses = this.workspace?.glasses;
      return Boolean(glasses && remoteClientId && remoteClientTokenHash && !glasses.isFunnelOn()
        && glasses.isCurrent(remoteClientId, remoteClientTokenHash) && glasses.allowsOrigin(client.glassesOrigin));
    }
    if (this.workspace) {
      // Narrower visibility or a new password applies to clients that are already connected.
      return workspaceCredentials !== null && authenticateWorkspaceRequest(
        workspaceCredentials.login,
        workspaceCredentials.authorization,
        this.workspace.access(),
      ).ok;
    }
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
    // A revoked device loses its stream within one heartbeat, even when no event is sent.
    if (client.glassesOrigin !== null && !this.isStillAdmitted(client)) {
      this.dropEventClient(clientConnectionId);
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
    // The host's connected-client list belongs to the paired transport; this one would replace it.
    if (this.workspace) return;
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

  /**
   * The name other screens show for the device behind a request: the name its event stream gave,
   * else the name on the request, else one remembered from an earlier stream on this runtime,
   * else its pairing label or Tailscale login.
   */
  private senderDevice(auth: Extract<RemoteRequestAuthResult, { ok: true }>, request: IncomingMessage, runtimeIdFallback?: string | null): string {
    const runtimeId = getRemoteRuntimeIdFromRequest(request, runtimeIdFallback);
    const streams = [...this.eventClients.values()];
    const own = runtimeId ? streams.find(client => client.remoteRuntimeId === runtimeId) : undefined;
    const sameClient = auth.client ? streams.find(client => client.remoteClientId === auth.client?.id) : undefined;
    const known = runtimeId ? this.deviceLabelsByRuntime.get(runtimeId) : undefined;
    const login = decodeOptionalBoundary(request.headers['tailscale-user-login'], boundary.string)?.trim();
    // A phone answering from an alert button has no stream open; it names itself on the request.
    return own?.deviceLabel ?? getClientDeviceLabelFromHeaders(request) ?? known ?? sameClient?.deviceLabel
      ?? own?.label ?? sameClient?.label ?? auth.client?.label ?? (login || 'another device');
  }


  /** The request's Tailscale login when it is this workspace's owner, else null. */
  private workspaceOwnerLogin(request: IncomingMessage): string | null {
    const login = decodeOptionalBoundary(request.headers['tailscale-user-login'], boundary.string)?.trim().toLowerCase();
    const owner = this.workspace?.access()?.ownerLogin;
    return owner && login === owner.toLowerCase() ? login : null;
  }

  private getInvokeArgsForRequest(
    invokeRequest: RemoteInvokeRequest,
    auth: Extract<RemoteRequestAuthResult, { ok: true }>,
    request: IncomingMessage,
  ): JsonValue[] {
    const args = [...invokeRequest.args];
    const sharesKeys = invokeRequest.channel.startsWith('credentials:shared:');
    if (sharesKeys && this.workspace) {
      // Keys belong to the owner: a teammate this workspace lets in may neither read nor replace them.
      const owner = this.workspaceOwnerLogin(request);
      if (!owner) {
        throw new RemoteDaemonBadRequestError(
          'ERR_SHARED_CREDENTIALS_OWNER_REQUIRED',
          'Only this computer\'s owner can share keys with it. Sign in to Tailscale as the owner, or set the key on this computer.',
          403,
        );
      }
      return [args[0] ?? null, { clientId: `tailnet:${owner}` }];
    }
    const registersPush = invokeRequest.channel.startsWith('mobile:push-');
    if (registersPush && !auth.client && this.workspace) {
      // A phone on the owner's Tailscale login registers without a code, as the owner: it can
      // already open terminals here. Teammates the workspace lets in get no alerts.
      const owner = this.workspaceOwnerLogin(request);
      if (!owner) {
        throw new RemoteDaemonBadRequestError(
          'ERR_MOBILE_PUSH_OWNER_REQUIRED',
          'Only this computer\'s owner can get its alerts on a phone. Sign in to Tailscale on the phone as the owner, or connect with a code.',
          403,
        );
      }
      return [args[0] ?? null, { clientId: `tailnet:${owner}` }];
    }
    if (registersPush || sharesKeys) {
      if (!auth.client) {
        throw new RemoteDaemonBadRequestError(
          sharesKeys ? 'ERR_SHARED_CREDENTIALS_PAIRING_REQUIRED' : 'ERR_MOBILE_PUSH_PAIRING_REQUIRED',
          sharesKeys ? 'Sharing keys requires a paired device.' : 'Mobile notifications require an authenticated paired host.',
          403,
        );
      }
      // The second argument is server-owned, even if the client supplied extra args.
      return [args[0] ?? null, { clientId: auth.client.id }];
    }
    if (invokeRequest.channel === 'notify:remote-command') {
      // The second argument is server-owned: a sender can't answer in another device's name.
      return [args[0] ?? null, { device: this.senderDevice(auth, request, invokeRequest.runtimeId) }];
    }
    if (invokeRequest.channel !== 'terminal:setVisibility' && invokeRequest.channel !== 'terminal:ack') {
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

/** Runs one invoke. Refusals made before the command ran are not kept, so a resend after them runs. */
async function answerInvoke(run: () => ReturnType<PaneCommandRegistry['invokeRemote']>): Promise<{ answer: InvokeAnswer; keep: boolean }> {
  try {
    const result = await run();
    return { answer: { statusCode: 200, payload: { ok: true, result } satisfies RemoteInvokeSuccessPayload }, keep: true };
  } catch (error) {
    if (error instanceof RemoteDaemonBadRequestError) {
      return {
        answer: { statusCode: error.statusCode, payload: { ok: false, error: { message: error.message, code: error.code } } satisfies RemoteInvokeErrorPayload },
        keep: false,
      };
    }
    const failure = toPaneDaemonError(error, 'ERR_REMOTE_DAEMON_REQUEST_FAILED');
    return {
      answer: { statusCode: invokeFailureStatus(failure.code), payload: { ok: false, error: failure } satisfies RemoteInvokeErrorPayload },
      keep: failure.code !== 'ERR_UNKNOWN_CHANNEL' && failure.code !== 'ERR_UPDATE_QUIESCING',
    };
  }
}

/** Notify refusals: the host checked the answer and ran nothing, so a client says "Not sent" instead of retrying. */
const NOTIFY_REFUSAL_CODES = new Set(['ERR_NOTIFY_INVALID', 'ERR_NOTIFY_GONE', 'ERR_NOTIFY_EXPIRED', 'ERR_NOTIFY_ANSWERED', 'ERR_NOTIFY_NOT_SENT']);

function invokeFailureStatus(code: string): number {
  if (code === 'ERR_UNKNOWN_CHANNEL') return 404;
  return NOTIFY_REFUSAL_CODES.has(code) ? 409 : 500;
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
  pipelineCallback(gzipStream, response, () => {});
  return gzipStream;
}

function writeRawHttpError(
  socket: Duplex,
  statusCode: number,
  message: string,
  code = 'ERR_REMOTE_DAEMON_WEBSOCKET_FAILED',
): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }

  const body = JSON.stringify({
    ok: false,
    error: {
      message,
      code,
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
    case 404:
      return 'Not Found';
    case 500:
      return 'Internal Server Error';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Error';
  }
}

function buildDeepgramListenUrl(endpoint: string): string {
  const url = new URL(endpoint);
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
  const value = getSingleHeaderValue(request.headers['x-pane-client-device-label']);
  if (!value) return value;
  // Phones percent-encode their name; desktops send a plain hostname.
  try {
    return decodeURIComponent(value).slice(0, 80);
  } catch {
    return value;
  }
}

function getRemoteRuntimeIdFromHeaders(request: IncomingMessage): string | null {
  return getSingleHeaderValue(request.headers['x-pane-remote-runtime-id']);
}

function getRemoteRuntimeIdFromRequest(request: IncomingMessage, fallback?: string | null): string | null {
  return getRemoteRuntimeIdFromHeaders(request) ?? getSingleString(fallback);
}

/**
 * A glasses device token from the Authorization header, or from the WebSocket subprotocol list
 * (`pane-glasses, pgt_…`), where a browser WebSocket can carry it. Never from the URL or body.
 */
function readGlassesToken(request: IncomingMessage): string | null {
  const bearer = getSingleHeaderValue(request.headers.authorization)?.match(/^bearer\s+(\S+)$/i)?.[1];
  if (bearer?.startsWith(GLASSES_TOKEN_PREFIX)) return bearer;
  const protocols = (getSingleHeaderValue(request.headers['sec-websocket-protocol']) ?? '').split(',').map((value) => value.trim());
  if (!protocols.includes(GLASSES_WEBSOCKET_PROTOCOL)) return null;
  return protocols.find((value) => value.startsWith(GLASSES_TOKEN_PREFIX)) ?? null;
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
