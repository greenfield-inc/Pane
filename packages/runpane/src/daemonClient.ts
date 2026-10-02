import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { BoundarySchema, JsonValue } from './boundaryDecoder';

interface PaneDaemonRequestFrame {
  type: 'request';
  id: number;
  channel: string;
  args: unknown[];
}

interface PaneDaemonSuccessResponseFrame {
  type: 'response';
  id: number;
  ok: true;
  result?: JsonValue;
}

interface PaneDaemonErrorResponseFrame {
  type: 'response';
  id: number;
  ok: false;
  error: {
    message: string;
    code?: string;
  };
}

interface PaneDaemonEventFrame {
  type: 'event';
  channel: string;
  args: unknown[];
}

type PaneDaemonFrame =
  | PaneDaemonRequestFrame
  | PaneDaemonSuccessResponseFrame
  | PaneDaemonErrorResponseFrame
  | PaneDaemonEventFrame;

export interface PaneDaemonEndpoint {
  transport: 'pipe' | 'unix';
  path: string;
}

interface InvokeOptions {
  paneDir?: string;
  timeoutMs?: number;
  eventInclude?: string[] | null;
}

interface TimeoutReference {
  current?: ReturnType<typeof setTimeout>;
}

type InvokeOutcome<Value> = { result: Value } | { error: Error };

const FRAME_DELIMITER = '\n';
const UNIX_SOCKET_BASE_DIRECTORY = '/tmp';
const DAEMON_SOCKET_FILENAME = 'daemon.sock';
const DEFAULT_TIMEOUT_MS = 130_000;

const paneDaemonFrameSchema: BoundarySchema<PaneDaemonFrame> = boundary.union(
  boundary.object({
    type: boundary.literal('request'),
    id: boundary.number,
    channel: boundary.string,
    args: boundary.array(boundary.json),
  }),
  boundary.object({
    type: boundary.literal('response'),
    id: boundary.number,
    ok: boundary.literal(true),
    result: boundary.optional(boundary.json),
  }),
  boundary.object({
    type: boundary.literal('response'),
    id: boundary.number,
    ok: boundary.literal(false),
    error: boundary.object({
      message: boundary.string,
      code: boundary.optional(boundary.string),
    }),
  }),
  boundary.object({
    type: boundary.literal('event'),
    channel: boundary.string,
    args: boundary.array(boundary.json),
  }),
);

export class PaneDaemonClientError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'PaneDaemonClientError';
  }
}

export function resolvePaneDirectory(paneDir?: string): string {
  return paneDir ?? process.env.PANE_DIR ?? process.env.FOOZOL_DIR ?? path.join(os.homedir(), '.pane');
}

export function getPaneDaemonEndpoint(appDirectory: string, platform: NodeJS.Platform = process.platform): PaneDaemonEndpoint {
  const resolvedAppDirectory = resolveAppDirectory(appDirectory, platform);

  if (platform === 'win32') {
    return {
      transport: 'pipe',
      path: getWindowsPipeName(resolvedAppDirectory),
    };
  }

  return {
    transport: 'unix',
    path: path.posix.join(getUnixSocketDirectoryName(resolvedAppDirectory), DAEMON_SOCKET_FILENAME),
  };
}

export async function invokeDaemon<T>(
  channel: string,
  args: unknown[] = [],
  resultSchema: BoundarySchema<T>,
  options: InvokeOptions = {},
): Promise<T> {
  const endpoint = getPaneDaemonEndpoint(resolvePaneDirectory(options.paneDir));
  const request: PaneDaemonRequestFrame = {
    type: 'request',
    id: 1,
    channel,
    args,
  };
  const eventFilterRequest: PaneDaemonRequestFrame = {
    type: 'request', id: 0, channel: 'daemon:events', args: [{ include: options.eventInclude ?? [] }],
  };

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(endpoint.path);
    const decoder = new PaneDaemonFrameDecoder();
    let settled = false;
    const timeoutRef: TimeoutReference = {};

    const settle = (outcome: InvokeOutcome<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      if ('error' in outcome) {
        reject(outcome.error);
        return;
      }
      resolve(outcome.result);
    };

    timeoutRef.current = setTimeout(() => {
      settle({ error: new PaneDaemonClientError(`Timed out waiting for Pane daemon response on ${endpoint.path}`, 'ERR_RUNPANE_DAEMON_TIMEOUT') });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    socket.once('connect', () => {
      socket.write(encodePaneDaemonFrame(eventFilterRequest));
      socket.write(encodePaneDaemonFrame(request));
    });

    socket.on('data', (chunk) => {
      try {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (frame.type !== 'response' || frame.id !== request.id) {
            continue;
          }
          if (frame.ok) {
            settle({ result: decodeBoundary(frame.result, resultSchema) });
            return;
          }
          settle({ error: new PaneDaemonClientError(frame.error.message, frame.error.code) });
          return;
        }
      } catch (error) {
        settle({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'ERR_RUNPANE_DAEMON_CONNECT_FAILED';
      settle({ error: new PaneDaemonClientError(`Could not connect to Pane daemon at ${endpoint.path}: ${error.message}`, code) });
    });

    socket.once('close', () => {
      if (!settled) {
        settle({ error: new PaneDaemonClientError(`Pane daemon closed the connection before responding at ${endpoint.path}`, 'ERR_RUNPANE_DAEMON_CLOSED') });
      }
    });
  });
}

function resolveAppDirectory(appDirectory: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return path.win32.resolve(appDirectory);
  }
  return path.posix.resolve(appDirectory);
}

function getWindowsPipeName(appDirectory: string): string {
  const hash = createHash('sha256')
    .update(appDirectory.toLowerCase())
    .digest('hex')
    .slice(0, 16);

  return `\\\\.\\pipe\\pane-daemon-${hash}`;
}

function getUnixSocketDirectoryName(appDirectory: string): string {
  const hash = createHash('sha256')
    .update(appDirectory)
    .digest('hex')
    .slice(0, 16);
  const uidSuffix = process.getuid ? `-${process.getuid()}` : '';

  return path.posix.join(UNIX_SOCKET_BASE_DIRECTORY, `pane-daemon${uidSuffix}-${hash}`);
}

function encodePaneDaemonFrame(frame: PaneDaemonFrame): string {
  return `${JSON.stringify(frame)}${FRAME_DELIMITER}`;
}

class PaneDaemonFrameDecoder {
  private buffer = '';
  private decoder = new StringDecoder('utf8');

  push(chunk: string | Buffer): PaneDaemonFrame[] {
    this.buffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk;

    const frames: PaneDaemonFrame[] = [];
    let delimiterIndex = this.buffer.indexOf(FRAME_DELIMITER);

    while (delimiterIndex !== -1) {
      const rawFrame = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + FRAME_DELIMITER.length);

      if (rawFrame.trim().length > 0) {
        frames.push(parseFrame(rawFrame));
      }

      delimiterIndex = this.buffer.indexOf(FRAME_DELIMITER);
    }

    return frames;
  }
}

function parseFrame(rawFrame: string): PaneDaemonFrame {
  return decodeBoundary(JSON.parse(rawFrame), paneDaemonFrameSchema);
}
