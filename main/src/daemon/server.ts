import fs from 'fs';
import net from 'net';
import path from 'path';
import type { PaneEventSink } from '../core/eventSink';
import type { PaneCommandRegistry } from './commandRegistry';
import { encodePaneDaemonFrame, PaneDaemonFrameDecoder } from './socketFraming';
import { getPaneDaemonEndpoint, type PaneDaemonEndpoint } from './socketPath';
import type {
  PaneDaemonErrorResponseFrame,
  PaneDaemonRequestFrame,
  PaneDaemonSuccessResponseFrame,
} from '../../../shared/types/daemon';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { serializeJsonTransport } from './jsonTransport';
import { toPaneDaemonError } from '../../../shared/paneError';

const DAEMON_EVENT_PREFIXES = [
  'agent-chat:',
  'chat-tab:',
  'archive:',
  'folder:',
  'loops:',
  'todos:',
  'panel:',
  'ports:',
  'project:',
  'resource-monitor:',
  'orchestration-sessions:',
  'session:',
  'sessions:',
  'terminal:',
] as const;

const DAEMON_EVENT_EXACT_CHANNELS = new Set<string>([
  // Autopilot's snapshot, so the phone's Autopilot row and walk bar follow the desktop.
  'autopilot:changed',
  'ssh:route-progress',
  'git-status-loading',
  // A member Pane's reports and exits, for a Session on another computer (`RemoteMemberEvents`).
  'workspace:entry',
  'git-status-updated',
  'logs:output',
  'notes:changed',
  'notify:shared-changed',
  'pane:focus-requested',
  'pane:open-link',
  'permission:request',
  'permission:resolved',
  'process:ended',
  'project-script-changed',
  'project-script-closing',
  'remote:settings-changed',
  'remote:update-intent',
  'session-log',
  'session-logs-cleared',
  'script-closing',
  'script-session-changed',
]);

export function isPaneDaemonEventChannel(channel: string): boolean {
  if (DAEMON_EVENT_EXACT_CHANNELS.has(channel)) {
    return true;
  }

  return DAEMON_EVENT_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

interface ConnectedPaneDaemonClient {
  socket: net.Socket;
  lifetime: AbortController;
  decoder: PaneDaemonFrameDecoder;
  pendingFrames: string[];
  pendingBytes: number;
  waitingForDrain: boolean;
  eventFilter: string[] | null;
}

type PaneDaemonClientWrite = (clientId: string, socket: net.Socket, encodedFrame: string) => boolean;

const UNIX_SOCKET_DIRECTORY_MODE = 0o700;
const UNIX_SOCKET_FILE_MODE = 0o600;
/**
 * How often a running Pane checks that its Unix socket still exists, and re-creates it if not.
 * The runpane CLIs quote this in their missing-socket error (`daemonClient.ts`, `daemon_client.py`).
 */
const PANE_DAEMON_SOCKET_CHECK_INTERVAL_MS = 5_000;
const MAX_PENDING_BYTES_PER_CLIENT = 4 * 1024 * 1024;
const daemonEventFilterRequestSchema = boundary.object({
  include: boundary.nullable(boundary.array(boundary.string)),
});

export class PaneDaemonServer {
  private server: net.Server | null = null;
  private readonly clients = new Map<string, ConnectedPaneDaemonClient>();
  private readonly endpoint: PaneDaemonEndpoint;
  private nextClientId = 1;
  private unixSocketWatch: NodeJS.Timeout | null = null;
  private restoringUnixSocket = false;
  private readonly unixSocketCheckIntervalMs: number;

  private readonly daemonEventSink: PaneEventSink = {
    send: (channel: string, ...args: unknown[]) => {
      if (!isPaneDaemonEventChannel(channel) || this.clients.size === 0) {
        return;
      }

      const interestedClients = [...this.clients.entries()]
        .filter(([, client]) => client.eventFilter === null || client.eventFilter.some(prefix => channel.startsWith(prefix)));
      if (interestedClients.length === 0) return;

      const encodedFrame = encodePaneDaemonFrame({
        type: 'event',
        channel,
        args: serializeJsonTransport(args, boundary.array(boundary.json)),
      });

      for (const [clientId] of interestedClients) {
        this.writeFrame(clientId, encodedFrame);
      }
    },
  };

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    appDirectory: string,
    platform: NodeJS.Platform = process.platform,
    private readonly clientWrite: PaneDaemonClientWrite = (_clientId, socket, encodedFrame) => socket.write(encodedFrame),
    options: { unixSocketCheckIntervalMs?: number } = {},
  ) {
    this.endpoint = getPaneDaemonEndpoint(appDirectory, platform);
    this.unixSocketCheckIntervalMs = options.unixSocketCheckIntervalMs ?? PANE_DAEMON_SOCKET_CHECK_INTERVAL_MS;
  }

  getEndpoint(): PaneDaemonEndpoint {
    return this.endpoint;
  }

  getEventSink(): PaneEventSink {
    return this.daemonEventSink;
  }

  hasSubscribers(): boolean {
    return this.clients.size > 0;
  }

  getSubscriberCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('Pane daemon server is already running');
    }

    if (this.endpoint.transport === 'unix') {
      this.createUnixSocketDirectory();
      if (fs.existsSync(this.endpoint.path)) {
        const unixSocketStatus = await probeUnixSocketPath(this.endpoint.path);
        if (unixSocketStatus === 'active') {
          throw new Error(`Pane daemon server is already listening on ${this.endpoint.path}`);
        }

        fs.unlinkSync(this.endpoint.path);
      }
    }

    this.server = await this.listen();
    this.startUnixSocketWatch();
  }

  private async listen(): Promise<net.Server> {
    const server = net.createServer((socket) => {
      this.attachClient(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        reject(error);
      };

      const handleListening = () => {
        server.removeListener('error', handleError);
        if (this.endpoint.transport === 'unix') {
          fs.chmodSync(this.endpoint.path, UNIX_SOCKET_FILE_MODE);
        }
        resolve();
      };

      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(this.endpoint.path);
    });

    server.on('error', (error) => {
      console.error('[Pane daemon] Server error:', error);
    });
    return server;
  }

  private createUnixSocketDirectory(): void {
    const socketDirectory = path.dirname(this.endpoint.path);
    fs.mkdirSync(socketDirectory, { recursive: true, mode: UNIX_SOCKET_DIRECTORY_MODE });
    fs.chmodSync(socketDirectory, UNIX_SOCKET_DIRECTORY_MODE);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.stopUnixSocketWatch();

    for (const clientId of [...this.clients.keys()]) {
      this.dropClient(clientId);
    }

    if (!server) {
      // Never listened: the socket file, if any, is another Pane's, and removing it would
      // make the next Pane on this data directory believe it owns it.
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    if (this.endpoint.transport === 'unix' && fs.existsSync(this.endpoint.path)) {
      fs.unlinkSync(this.endpoint.path);
    }
  }

  /**
   * Re-creates the Unix socket, and its folder, when something deleted them while Pane runs
   * (a cleanup of /tmp, say). The listener keeps serving the deleted file's clients, but no
   * new client can find it, so the local runpane CLI and MCP server would fail with ENOENT
   * until Pane restarts. Clients already connected stay connected. A file someone else put
   * at the path, such as another Pane on this data directory, is left alone. Windows named
   * pipes cannot be deleted this way, so they are never touched.
   * Resolves true when it listened again.
   */
  async restoreUnixSocketIfMissing(): Promise<boolean> {
    const previous = this.server;
    if (this.endpoint.transport !== 'unix' || !previous || this.restoringUnixSocket || fs.existsSync(this.endpoint.path)) {
      return false;
    }

    this.restoringUnixSocket = true;
    try {
      // Closing a Unix listener removes whatever file is at its path, so the listener on the
      // deleted file closes before its replacement listens. Its clients keep their connections.
      if (previous.listening) {
        previous.close();
      }
      this.createUnixSocketDirectory();
      const replacement = await this.listen();
      if (this.server !== previous) {
        // Stopped while this call listened.
        replacement.close();
        return false;
      }
      this.server = replacement;
      console.warn(`[Pane daemon] Re-created the local socket at ${this.endpoint.path}: it was deleted while Pane ran.`);
      return true;
    } catch (error) {
      console.error(`[Pane daemon] Could not re-create the local socket at ${this.endpoint.path}; it will try again in ${this.unixSocketCheckIntervalMs / 1000} s:`, error);
      return false;
    } finally {
      this.restoringUnixSocket = false;
    }
  }

  private startUnixSocketWatch(): void {
    if (this.endpoint.transport !== 'unix') {
      return;
    }

    this.unixSocketWatch = setInterval(() => {
      void this.restoreUnixSocketIfMissing();
    }, this.unixSocketCheckIntervalMs);
    // The check must never keep the process alive on its own.
    this.unixSocketWatch.unref();
  }

  private stopUnixSocketWatch(): void {
    if (this.unixSocketWatch) {
      clearInterval(this.unixSocketWatch);
      this.unixSocketWatch = null;
    }
  }

  private attachClient(socket: net.Socket): void {
    const clientId = String(this.nextClientId++);
    const client: ConnectedPaneDaemonClient = {
      socket,
      lifetime: new AbortController(),
      decoder: new PaneDaemonFrameDecoder(),
      pendingFrames: [],
      pendingBytes: 0,
      waitingForDrain: false,
      eventFilter: null,
    };

    this.clients.set(clientId, client);

    socket.on('data', (chunk) => {
      try {
        const frames = client.decoder.push(chunk);
        for (const frame of frames) {
          if (frame.type !== 'request') {
            socket.destroy(new Error(`Pane daemon clients must send request frames, received "${frame.type}"`));
            return;
          }

          void this.handleRequest(clientId, frame);
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.on('drain', () => {
      this.flushPendingFrames(clientId);
    });

    socket.on('error', () => {
      this.dropClient(clientId);
    });

    socket.on('close', () => {
      this.dropClient(clientId);
      try {
        client.decoder.finish();
      } catch {
        // The client closed mid-frame. Treat it as a disconnected subscriber.
      }
    });
  }

  private dropClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    this.clients.delete(clientId);
    client.lifetime.abort(new Error('Pane daemon client disconnected'));
    client.pendingFrames.length = 0;
    client.pendingBytes = 0;
    client.waitingForDrain = false;
    if (!client.socket.destroyed) {
      client.socket.destroy();
    }
  }

  private async handleRequest(clientId: string, frame: PaneDaemonRequestFrame): Promise<void> {
    const response = frame.channel === 'daemon:events'
      ? this.buildEventFilterResponse(clientId, frame)
      : await this.buildResponseFrame(frame, this.clients.get(clientId)?.lifetime.signal);
    const client = this.clients.get(clientId);

    if (!client || client.socket.destroyed) {
      return;
    }

    this.writeFrame(clientId, encodePaneDaemonFrame(response));
  }

  private buildEventFilterResponse(
    clientId: string,
    frame: PaneDaemonRequestFrame,
  ): PaneDaemonSuccessResponseFrame | PaneDaemonErrorResponseFrame {
    const client = this.clients.get(clientId);
    if (!client) {
      return daemonError(frame.id, 'Pane daemon client disconnected', 'ERR_DAEMON_REQUEST_FAILED');
    }

    const request = decodeOptionalBoundary(frame.args[0], daemonEventFilterRequestSchema);
    if (!request) {
      return daemonError(frame.id, 'daemon:events include must be null or an array of channel prefixes', 'ERR_DAEMON_REQUEST_FAILED');
    }

    const { include } = request;
    client.eventFilter = include === null ? null : [...include];
    return {
      type: 'response',
      id: frame.id,
      ok: true,
      result: {
        ok: true,
        include: client.eventFilter,
        muted: Array.isArray(client.eventFilter) && client.eventFilter.length === 0,
      },
    };
  }

  private writeFrame(clientId: string, encodedFrame: string): void {
    const client = this.clients.get(clientId);
    if (!client || client.socket.destroyed) {
      return;
    }

    if (client.waitingForDrain || client.pendingFrames.length > 0) {
      this.queuePendingFrame(clientId, encodedFrame);
      return;
    }

    try {
      const accepted = this.clientWrite(clientId, client.socket, encodedFrame);
      if (!accepted) {
        client.waitingForDrain = true;
      }
    } catch {
      this.dropClient(clientId);
    }
  }

  private queuePendingFrame(clientId: string, encodedFrame: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.pendingFrames.push(encodedFrame);
    client.pendingBytes += Buffer.byteLength(encodedFrame);
    if (client.pendingBytes > MAX_PENDING_BYTES_PER_CLIENT) {
      this.dropClient(clientId);
    }
  }

  private flushPendingFrames(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client || client.socket.destroyed) {
      return;
    }

    client.waitingForDrain = false;
    while (client.pendingFrames.length > 0) {
      const nextFrame = client.pendingFrames.shift();
      if (!nextFrame) {
        break;
      }

      client.pendingBytes -= Buffer.byteLength(nextFrame);
      try {
        const accepted = this.clientWrite(clientId, client.socket, nextFrame);
        if (!accepted) {
          client.waitingForDrain = true;
          return;
        }
      } catch {
        this.dropClient(clientId);
        return;
      }
    }
  }

  private async buildResponseFrame(
    frame: PaneDaemonRequestFrame,
    signal?: AbortSignal,
  ): Promise<PaneDaemonSuccessResponseFrame | PaneDaemonErrorResponseFrame> {
    try {
      const result = signal
        ? await this.commandRegistry.invokeConnected(frame.channel, frame.args, signal, frame.caller)
        : await this.commandRegistry.invoke(frame.channel, frame.args);
      return {
        type: 'response',
        id: frame.id,
        ok: true,
        result: result === undefined ? undefined : serializeJsonTransport(result, boundary.json),
      };
    } catch (error) {
      return { type: 'response', id: frame.id, ok: false, error: toPaneDaemonError(error, 'ERR_DAEMON_REQUEST_FAILED') };
    }
  }
}

function daemonError(
  id: number,
  message: string,
  code: string,
): PaneDaemonErrorResponseFrame {
  return { type: 'response', id, ok: false, error: { message, code } };
}

async function probeUnixSocketPath(socketPath: string): Promise<'active' | 'stale'> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    const settle = (result: 'active' | 'stale') => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(result);
    };

    socket.once('connect', () => settle('active'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT' || error.code === 'ENOTSOCK') {
        settle('stale');
        return;
      }

      reject(error);
    });
  });
}

const DAEMON_PROBE_TIMEOUT_MS = 1_000;

/**
 * Whether another Pane already serves this data directory's daemon endpoint.
 * Anything but a clear "nobody is there" (an unexpected error, no answer within
 * a second) counts as yes, so callers skip destructive work when unsure.
 */
export async function isPaneDaemonListening(appDirectory: string): Promise<boolean> {
  const endpointPath = getPaneDaemonEndpoint(appDirectory).path;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'active'>((resolve) => {
    timer = setTimeout(() => resolve('active'), DAEMON_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([probeUnixSocketPath(endpointPath), timeout]) === 'active';
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}
