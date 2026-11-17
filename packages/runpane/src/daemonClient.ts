import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import tls, { type PeerCertificate } from 'node:tls';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { BoundarySchema, JsonValue } from './boundaryDecoder';

interface PaneDaemonRequestFrame {
  type: 'request';
  id: number;
  channel: string;
  args: unknown[];
  caller?: { paneId?: string; panelId?: string };
}

/**
 * The Pane and tab this runpane runs in, from the environment Pane gives its agents. Pane uses it
 * only to refuse what an agent may not do (Autopilot answering an approval), never to grant.
 */
function daemonCaller(env: NodeJS.ProcessEnv = process.env): PaneDaemonRequestFrame['caller'] {
  const paneId = env.PANE_SESSION_ID?.trim();
  const panelId = env.PANE_PANEL_ID?.trim();
  if (!paneId && !panelId) return undefined;
  const caller: NonNullable<PaneDaemonRequestFrame['caller']> = {};
  if (paneId) caller.paneId = paneId;
  if (panelId) caller.panelId = panelId;
  return caller;
}

/** What `/invoke` on another machine takes from runpane. */
interface RemoteInvokeBody { channel: string; args: unknown[]; caller?: PaneDaemonRequestFrame['caller'] }

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
    next?: string;
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
  /** Ask this machine's Pane even while `runpane workspace <machine>` routes calls elsewhere. */
  thisMachine?: boolean;
  /** `Infinity` waits as long as the call takes, for requests that wait on a person. */
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
      next: boundary.optional(boundary.string),
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
    readonly connectionFailure = false,
    readonly next?: string,
  ) {
    super(message);
    this.name = 'PaneDaemonClientError';
  }
}

/** Decodes a daemon result; a shape this runpane does not know is a version mismatch, reported as one. */
function decodeResult<T>(channel: string, result: JsonValue | undefined, resultSchema: BoundarySchema<T>): T {
  try {
    return decodeBoundary(result, resultSchema);
  } catch (error) {
    throw new PaneDaemonClientError(
      `Pane answered ${channel}, but this runpane could not read the result (${error instanceof Error ? error.message : String(error)}). Pane ran the command; only reading its answer failed. This usually means runpane and Pane are different versions.`,
      'ERR_RUNPANE_RESULT_UNREADABLE',
      false,
      'Compare the versions with `runpane doctor` and update the older one, then check the result in Pane before running the command again.',
    );
  }
}

/** The doctor command for the Pane this call used, so it checks the same instance. */
function doctorCommand(paneDir: string | undefined): string {
  if (!paneDir) return '`runpane doctor`';
  return `\`runpane doctor --pane-dir ${/^[\w./:@\\-]+$/.test(paneDir) ? paneDir : `'${paneDir.replace(/'/g, `'\\''`)}'`}\``;
}

/**
 * How soon a running Pane re-creates a deleted Unix socket: PANE_DAEMON_SOCKET_CHECK_INTERVAL_MS
 * in main/src/daemon/server.ts. The Python CLI quotes the same number (`daemon_client.py`).
 */
const DAEMON_SOCKET_RECREATE_SECONDS = 5;

/**
 * No socket where Pane listens. Either Pane is not running, or something deleted its socket while
 * it ran (a /tmp cleanup); a running Pane re-creates it within seconds, and an older one only on
 * restart. The wording matches the Python CLI's.
 */
function missingUnixSocketError(socketPath: string, appDirectory: string, paneDir: string | undefined): PaneDaemonClientError {
  return new PaneDaemonClientError(
    `No Pane daemon socket at ${socketPath} (ENOENT). Pane is not running for ${appDirectory}, or its socket was deleted while it ran; a running Pane re-creates it within ${DAEMON_SOCKET_RECREATE_SECONDS} s. Nothing was changed.`,
    'ENOENT',
    true,
    `Open Pane on this machine. If it is already open, wait ${DAEMON_SOCKET_RECREATE_SECONDS} s and try again; if it still fails, quit and reopen Pane. Then check the connection with ${doctorCommand(paneDir)}.`,
  );
}

/** Why runpane could not reach Pane at all; nothing reached Pane. */
function connectError(endpoint: PaneDaemonEndpoint, appDirectory: string, error: NodeJS.ErrnoException, paneDir: string | undefined): PaneDaemonClientError {
  // Pane creates its data folder on first launch, so without one Pane has never run here.
  const paneHasRun = fs.existsSync(appDirectory);
  if (endpoint.transport === 'unix' && error.code === 'ENOENT' && paneHasRun) {
    return missingUnixSocketError(endpoint.path, appDirectory, paneDir);
  }
  return new PaneDaemonClientError(
    `Could not connect to Pane daemon at ${endpoint.path} (${error.code ?? error.message}). Pane is not running for ${appDirectory}, or it was started with a different PANE_DIR. Nothing was changed.`,
    error.code ?? 'ERR_RUNPANE_DAEMON_CONNECT_FAILED',
    true,
    paneHasRun
      ? `Open Pane on this machine, then check the connection with ${doctorCommand(paneDir)}.`
      : `Pane has not run on this machine yet. Install Pane from https://runpane.com (free), open it, then restart this agent session so its Pane tools connect.`,
  );
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

const ROUTE_LABELS = new Map([
  ['lan', 'Same network'], ['tailscale', 'Tailscale'], ['ssh', 'SSH'], ['public', 'Public URL'], ['relay', 'Pane relay'],
]);

/** A route kind as Settings names it. */
export function routeLabel(kind: string): string {
  return ROUTE_LABELS.get(kind) ?? kind;
}

/** One way to reach another machine's Pane. */
export interface RemoteRoute {
  /** `lan`, `tailscale`, `ssh`, `public` or `relay`. */
  kind: string;
  baseUrl: string;
  /** Sent as a bearer: a link token, or a Tailscale route's password. Without one a Tailscale machine checks the login. */
  token?: string;
  /** Relay and same-network routes: base64url SHA-256 of the computer's SubjectPublicKeyInfo. Any other key is refused before the token is sent. */
  fingerprint?: string;
}

/** Another machine's Pane (see `runpane workspace`), with its routes in the order they are tried. */
export interface RemoteDaemonTarget {
  machine: string;
  routes: RemoteRoute[];
}

/**
 * How long a route has to connect (TCP, plus TLS for https) before the next route is tried. Three
 * dead routes and a working fourth still answer within 10 seconds. The last route has no such
 * bound: nothing comes after it.
 */
const ROUTE_CONNECT_TIMEOUT_MS = 2_500;
/** A computer on this network connects in milliseconds; an address that only looks local waits on ARP. */
const LAN_ROUTE_CONNECT_TIMEOUT_MS = 1_500;

/**
 * A certificate check that also requires the linked computer's own key, so a certificate issued
 * to anyone else for the same name (such as by whoever runs its relay's DNS) is refused.
 */
function pinnedServerIdentity(fingerprint: string, machine: string): (host: string, certificate: PeerCertificate) => Error | undefined {
  return (host, certificate) => {
    const identity = tls.checkServerIdentity(host, certificate);
    if (identity) return identity;
    const key = new X509Certificate(certificate.raw).publicKey.export({ format: 'der', type: 'spki' });
    if (createHash('sha256').update(key).digest('base64url') === fingerprint) return undefined;
    return Object.assign(new Error(`${machine} presented a key it did not link with, so runpane did not send the request`), { code: 'ERR_KEY_PIN_MISMATCH' });
  };
}

// A type alias, not an interface, so it passes as Node's header record.
type InvokeHeaders = { 'Content-Type': string; Authorization?: string };

/** A route's reply, or how it failed. `connected: false` means the request never left this machine. */
type RouteOutcome =
  | { reply: { status: number; text: string } }
  | { error: Error; connected: boolean };

/** POSTs `/invoke` on one route, with its key pinned when it has one. */
function postRoute(
  route: RemoteRoute,
  machine: string,
  headers: InvokeHeaders,
  body: string,
  timeoutMs: number,
  connectTimeoutMs: number | undefined,
): Promise<RouteOutcome> {
  return new Promise((resolve) => {
    const url = `${route.baseUrl.replace(/\/+$/u, '')}/invoke`;
    const secure = url.startsWith('https:');
    const signal = Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
    let connected = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const markConnected = () => {
      connected = true;
      clearTimeout(connectTimer);
    };
    // A fresh connection per call: a pooled one would keep this process alive after its last call.
    const options: https.RequestOptions = { method: 'POST', headers, signal, agent: false };
    if (route.fingerprint) options.checkServerIdentity = pinnedServerIdentity(route.fingerprint, machine);
    const request = (secure ? https : http).request(url, options, (response) => {
      markConnected();
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ reply: { status: response.statusCode ?? 502, text } }));
      response.on('error', (error) => resolve({ error, connected }));
    });
    if (connectTimeoutMs !== undefined) {
      connectTimer = setTimeout(() => {
        request.destroy(Object.assign(new Error(`no connection within ${connectTimeoutMs / 1000} s`), { code: 'ERR_ROUTE_CONNECT_TIMEOUT' }));
      }, connectTimeoutMs);
    }
    request.on('socket', (socket) => socket.once(secure ? 'secureConnect' : 'connect', markConnected));
    request.on('error', (error) => {
      clearTimeout(connectTimer);
      resolve({ error: signal?.aborted && signal.reason instanceof Error ? signal.reason : error, connected });
    });
    request.end(body);
  });
}

const remoteInvokeResponseSchema = boundary.union(
  boundary.object({ ok: boundary.literal(true), result: boundary.optional(boundary.json) }),
  boundary.object({ ok: boundary.literal(false), error: boundary.object({ message: boundary.string, code: boundary.optional(boundary.string), next: boundary.optional(boundary.string) }) }),
);

let routedTarget: RemoteDaemonTarget | null = null;
let routedToSelf = false;

/** Sends every later daemon call in this process to another machine (`runpane workspace <machine> <command>`). */
export function routeDaemonCallsTo(target: RemoteDaemonTarget | null, self = false): void {
  routedTarget = target;
  routedToSelf = self;
}

/** The other machine daemon calls go to, or null when they stay on this one (this machine named by its own name included). */
export function routedOtherMachine(): string | null {
  return routedTarget && !routedToSelf ? routedTarget.machine : null;
}

/** The route that last answered for each target, tried first on its next call. */
const answeredRoutes = new WeakMap<RemoteDaemonTarget, RemoteRoute>();

/** The route that answered this target's last call, if one did. */
export function answeringRoute(target: RemoteDaemonTarget): RemoteRoute | undefined {
  return answeredRoutes.get(target);
}

function routeName(route: RemoteRoute): string {
  return `${routeLabel(route.kind)} (${route.baseUrl})`;
}

/**
 * Calls `channel` on another machine's Pane. Routes are tried in order: one that does not connect,
 * whose Pane is not running, or that refuses the credential gives way to the next. A request that
 * reached a Pane never goes to a second route, so nothing runs twice.
 */
export async function invokeRemoteDaemon<T>(
  target: RemoteDaemonTarget,
  channel: string,
  args: unknown[],
  resultSchema: BoundarySchema<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  // The caller goes to other machines too, so their guard refuses what this tab may not do (D-66).
  const body: RemoteInvokeBody = { channel, args };
  const caller = daemonCaller();
  if (caller) body.caller = caller;
  const text = JSON.stringify(body);
  const remembered = answeredRoutes.get(target);
  const routes = remembered && target.routes.includes(remembered)
    ? [remembered, ...target.routes.filter((route) => route !== remembered)]
    : target.routes;
  if (!routes.length) {
    throw new PaneDaemonClientError(
      `${target.machine} has no saved route, so runpane cannot reach it. Nothing was changed.`,
      'ERR_WORKSPACE_UNREACHABLE',
      false,
      'Add a route in Pane: Settings › Remote Access › Computers › Add route.',
    );
  }
  const missed: string[] = [];
  let refusal: PaneDaemonClientError | undefined;
  for (const [index, route] of routes.entries()) {
    const headers: InvokeHeaders = { 'Content-Type': 'application/json' };
    if (route.token) headers.Authorization = `Bearer ${route.token}`;
    const last = index === routes.length - 1;
    const outcome = await postRoute(route, target.machine, headers, text, timeoutMs, last ? undefined : route.kind === 'lan' ? LAN_ROUTE_CONNECT_TIMEOUT_MS : ROUTE_CONNECT_TIMEOUT_MS);
    const answer = readRouteOutcome(target.machine, route, channel, timeoutMs, outcome);
    if ('result' in answer) {
      answeredRoutes.set(target, route);
      return decodeResult(channel, answer.result, resultSchema);
    }
    missed.push(routes.length > 1 ? `${routeName(route)}: ${answer.missed}` : answer.missed);
    refusal = answer.refusal;
  }
  if (refusal) throw refusal;
  throw new PaneDaemonClientError(
    routes.length > 1
      ? `Could not reach Pane on ${target.machine} by any route: ${missed.join('; ')}. Pane must be running there. Nothing was changed.`
      : `Could not reach Pane on ${target.machine} (${routes[0].baseUrl}): ${missed[0]}. Pane must be running there with workspaces on. Nothing was changed.`,
    'ERR_WORKSPACE_UNREACHABLE',
    false,
    'Check the machine with `runpane workspace list`.',
  );
}

/**
 * What one route's attempt means: Pane's result, a miss the next route may retry (the request
 * never reached a Pane, or was refused before it ran), or a failure after the request was sent.
 */
function readRouteOutcome(
  machine: string,
  route: RemoteRoute,
  channel: string,
  timeoutMs: number,
  outcome: RouteOutcome,
): { result: JsonValue | undefined } | { missed: string; refusal?: PaneDaemonClientError } {
  const lost = (detail: string) => new PaneDaemonClientError(
    `Lost the reply from Pane on ${machine} (${route.baseUrl}): ${detail}. The request was sent, so Pane there may have finished ${channel}.`,
    'ERR_WORKSPACE_UNREACHABLE',
    false,
    'Check whether the command took effect there before running it again; see the machine\'s status with `runpane workspace list`.',
  );
  if ('error' in outcome) {
    const { error } = outcome;
    const timedOut = error.name === 'TimeoutError';
    if (!outcome.connected) return { missed: timedOut ? `no connection within ${timeoutMs} ms` : errorDetail(error) };
    if (timedOut) {
      throw new PaneDaemonClientError(
        `${machine} did not answer within ${timeoutMs} ms. It may still finish ${channel}.`,
        'ERR_WORKSPACE_TIMEOUT',
        false,
        'Check whether the command took effect there before running it again; see the machine\'s status with `runpane workspace list`.',
      );
    }
    throw lost(errorDetail(error));
  }
  const { status, text } = outcome.reply;
  let payload: ReturnType<typeof remoteInvokeResponseSchema.decode>;
  try {
    payload = decodeBoundary(JSON.parse(text), remoteInvokeResponseSchema);
  } catch {
    // tailscale serve answers 502 itself when nothing listens behind it.
    if (status === 502) return { missed: 'Pane is not running there' };
    throw lost(`HTTP ${status} with a reply this runpane cannot read`);
  }
  if (payload.ok) return { result: payload.result };
  // The machine's own visibility setting refused this login; only its owner can change that.
  const fix = payload.error.code === 'ERR_WORKSPACE_IDENTITY_REFUSED'
    ? ' Its owner can let you in from Pane on that machine: Settings → Remote Access → Access → Who can connect → Everyone on tailnet.'
    : '';
  const failure = new PaneDaemonClientError(`${machine}: ${payload.error.message}${fix}`, payload.error.code, false, payload.error.next);
  // A refused credential ran nothing, so another route (with its own credential) may still answer.
  if (status === 401 || status === 403) return { missed: payload.error.message, refusal: failure };
  throw failure;
}

function errorDetail(error: Error): string {
  return error.cause instanceof Error ? error.cause.message : error.message;
}

export async function invokeDaemon<T>(
  channel: string,
  args: unknown[] = [],
  resultSchema: BoundarySchema<T>,
  options: InvokeOptions = {},
): Promise<T> {
  if (routedTarget && !options.thisMachine) {
    return invokeRemoteDaemon(routedTarget, channel, args, resultSchema, options.timeoutMs);
  }
  const appDirectory = resolvePaneDirectory(options.paneDir);
  const endpoint = getPaneDaemonEndpoint(appDirectory);
  const caller = daemonCaller();
  const request: PaneDaemonRequestFrame = {
    type: 'request',
    id: 1,
    channel,
    args,
  };
  if (caller) request.caller = caller;
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

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (Number.isFinite(timeoutMs)) {
      timeoutRef.current = setTimeout(() => {
        settle({ error: new PaneDaemonClientError(
          `Timed out waiting for Pane daemon response on ${endpoint.path}. Pane may be busy, and it may still finish ${channel}.`,
          'ERR_RUNPANE_DAEMON_TIMEOUT',
          false,
          `Check whether the command took effect before running it again; if Pane stays unresponsive, run ${doctorCommand(options.paneDir)}.`,
        ) });
      }, timeoutMs);
    }

    let sent = false;
    socket.once('connect', () => {
      sent = true;
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
            settle({ result: decodeResult(channel, frame.result, resultSchema) });
            return;
          }
          settle({ error: new PaneDaemonClientError(frame.error.message, frame.error.code, false, frame.error.next) });
          return;
        }
      } catch (error) {
        settle({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'ERR_RUNPANE_DAEMON_CONNECT_FAILED';
      settle({ error: sent
        ? new PaneDaemonClientError(
          `Lost the connection to Pane daemon at ${endpoint.path} after ${channel} was sent (${error.code ?? error.message}). Pane may have finished it.`,
          code,
          false,
          `Check whether the command took effect before running it again; then check the connection with ${doctorCommand(options.paneDir)}.`,
        )
        : connectError(endpoint, appDirectory, error, options.paneDir) });
    });

    socket.once('close', () => {
      if (!settled) {
        settle({ error: new PaneDaemonClientError(
          `Pane daemon at ${endpoint.path} closed the connection after ${channel} was sent and before it answered. Pane may have finished it.`,
          'ERR_RUNPANE_DAEMON_CLOSED',
          false,
          `Check whether the command took effect before running it again; if Pane quit, open it and run ${doctorCommand(options.paneDir)}.`,
        ) });
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
