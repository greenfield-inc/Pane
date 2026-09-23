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

const DAEMON_EVENT_PREFIXES = [
  'archive:',
  'folder:',
  'panel:',
  'project:',
  'resource-monitor:',
  'orchestration-sessions:',
  'session:',
  'sessions:',
  'terminal:',
] as const;

const DAEMON_EVENT_EXACT_CHANNELS = new Set<string>([
  'git-status-loading',
  'git-status-updated',
  'logs:output',
  'permission:request',
  'permission:resolved',
  'process:ended',
  'project-script-changed',
  'project-script-closing',
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
  decoder: PaneDaemonFrameDecoder;
  pendingFrames: string[];
  pendingBytes: number;
  waitingForDrain: boolean;
  eventFilter: string[] | null;
}

type PaneDaemonClientWrite = (clientId: string, socket: net.Socket, encodedFrame: string) => boolean;

const UNIX_SOCKET_DIRECTORY_MODE = 0o700;
const UNIX_SOCKET_FILE_MODE = 0o600;
const MAX_PENDING_BYTES_PER_CLIENT = 4 * 1024 * 1024;
const daemonEventFilterRequestSchema = boundary.object({
  include: boundary.nullable(boundary.array(boundary.string)),
});

export class PaneDaemonServer {
  private server: net.Server | null = null;
  private readonly clients = new Map<string, ConnectedPaneDaemonClient>();
  private readonly endpoint: PaneDaemonEndpoint;
  private nextClientId = 1;

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
  ) {
    this.endpoint = getPaneDaemonEndpoint(appDirectory, platform);
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
      const socketDirectory = path.dirname(this.endpoint.path);
      fs.mkdirSync(socketDirectory, { recursive: true, mode: UNIX_SOCKET_DIRECTORY_MODE });
      fs.chmodSync(socketDirectory, UNIX_SOCKET_DIRECTORY_MODE);
      if (fs.existsSync(this.endpoint.path)) {
        const unixSocketStatus = await probeUnixSocketPath(this.endpoint.path);
        if (unixSocketStatus === 'active') {
          throw new Error(`Pane daemon server is already listening on ${this.endpoint.path}`);
        }

        fs.unlinkSync(this.endpoint.path);
      }
    }

    const server = net.createServer((socket) => {
      this.attachClient(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        server.removeListener('listening', handleListening);
        this.server = null;
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
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;

    for (const clientId of [...this.clients.keys()]) {
      this.dropClient(clientId);
    }

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (this.endpoint.transport === 'unix' && fs.existsSync(this.endpoint.path)) {
      fs.unlinkSync(this.endpoint.path);
    }
  }

  private attachClient(socket: net.Socket): void {
    const clientId = String(this.nextClientId++);
    const client: ConnectedPaneDaemonClient = {
      socket,
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
      this.clients.delete(clientId);
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
      : await this.buildResponseFrame(frame);
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
  ): Promise<PaneDaemonSuccessResponseFrame | PaneDaemonErrorResponseFrame> {
    try {
      const result = await this.commandRegistry.invoke(frame.channel, frame.args);
      return {
        type: 'response',
        id: frame.id,
        ok: true,
        result: result === undefined ? undefined : serializeJsonTransport(result, boundary.json),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes('No Pane daemon command registered')
        ? 'ERR_UNKNOWN_CHANNEL'
        : 'ERR_DAEMON_REQUEST_FAILED';

      return {
        type: 'response',
        id: frame.id,
        ok: false,
        error: {
          message,
          code,
        },
      };
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
