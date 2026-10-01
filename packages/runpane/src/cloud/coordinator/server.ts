import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonObject, JsonValue } from '../../boundaryDecoder';
import { authenticateCaller } from './callerAuth';
import type { Caller } from './callerAuth';
import { describeError } from './daemonProbe';
import type { DirectoryWriter } from './directory';
import type { GitHubBroker } from './github/broker';
import { BrokerError } from './github/policy';
import type { IdleCheckReport } from './idleStop';
import type { ReconcileReport } from './reconciler';
import type { SecretsService } from './secrets/service';
import type { AlertSink, Clock, CoordinatorAlert, SessionDirectory } from './types';
import type { WakeCaller, WakeResult } from './wake';

const MAX_BODY_BYTES = 256 * 1024;
const PEER_REQUESTS_PER_MINUTE = 60;

const wakeBodySchema = boundary.object({
  host: boundary.nonEmptyString,
  wait: boundary.optional(boundary.boolean),
  timeoutMs: boundary.optional(boundary.number),
});

const runBodySchema = boundary.object({ dryRun: boundary.optional(boundary.boolean) });

export interface CoordinatorApi {
  status(host: string): Promise<WakeResult>;
  wake(host: string, request: { wait: boolean; timeoutMs?: number }, caller: WakeCaller): Promise<WakeResult>;
  reconcile(options: { dryRun?: boolean }): Promise<ReconcileReport>;
  idleCheck(options: { dryRun?: boolean }): Promise<IdleCheckReport>;
}

export interface CoordinatorServerOptions {
  api: CoordinatorApi;
  directory: SessionDirectory;
  directoryWriter: DirectoryWriter | null;
  alerts: AlertSink;
  clock: Clock;
  secret: string;
  revokedCallers: readonly string[];
  version: string;
  log?: (line: string) => void;
  /** The GitHub broker behind /cloud/github/* (it answers "off" until a credential is configured). */
  github?: GitHubBroker;
  /** The Doppler secrets service behind /cloud/secrets/* (it answers "off" until a token is configured). */
  secrets?: SecretsService;
}

interface ErrorBody {
  ok: false;
  code: string;
  message: string;
}

type ResponseBody =
  | WakeResult
  | ErrorBody
  | { ok: true; service: string; version: string }
  | { ok: true; alerts: CoordinatorAlert[] }
  | { ok: true; report: ReconcileReport | IdleCheckReport }
  | { ok: true; sessions: number }
  | JsonObject;

const FAILURE_STATUS = {
  'unknown-host': 404,
  'directory-unreadable': 503,
  'runaway-guard': 429,
  'wake-rate-limited': 429,
  'resume-history-invalid': 503,
  'resume-history-busy': 503,
  'peer-wake-refused': 403,
  'provider-rate-limited': 429,
  'provider-error': 502,
} as const;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/**
 * The coordinator's HTTP API, served on its tailnet address only.
 * Peers (cloud Sessions) may call status and wake; `user:*` callers (the laptop CLI) may also run
 * reconcile / idle-check, read alerts and replace the directory.
 */
export function createCoordinatorServer(options: CoordinatorServerOptions): http.Server {
  const peerWindows = new Map<string, number[]>();
  const log = options.log ?? ((line: string) => console.log(line));

  const rateLimitPeer = (caller: Caller): void => {
    if (caller.role !== 'peer') return;
    const now = options.clock.now();
    const recent = (peerWindows.get(caller.id) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= PEER_REQUESTS_PER_MINUTE) {
      throw new HttpError(429, 'rate-limited', `caller ${caller.id} exceeded ${PEER_REQUESTS_PER_MINUTE} requests per minute`);
    }
    recent.push(now);
    peerWindows.set(caller.id, recent);
  };

  const requireUser = (caller: Caller): void => {
    if (caller.role !== 'user') throw new HttpError(403, 'forbidden', 'this endpoint is only for user callers');
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://coordinator.invalid');
    if (url.pathname === '/health' && request.method === 'GET') {
      writeJson(response, 200, { ok: true, service: 'runpane-cloud-coordinator', version: options.version });
      return;
    }
    if (!url.pathname.startsWith('/cloud/')) throw new HttpError(404, 'not-found', `no endpoint ${url.pathname}`);

    const auth = await authenticateCaller(request.headers.authorization, {
      secret: options.secret,
      revokedCallers: options.revokedCallers,
      isKnownPeer: async (callerId) => {
        const directory = await options.directory.read();
        return directory.ok && directory.entries.some((entry) => entry.sessionId === callerId);
      },
    });
    if (!auth.ok) throw new HttpError(auth.status, auth.code, auth.message);
    const { caller } = auth;
    rateLimitPeer(caller);

    if (url.pathname.startsWith('/cloud/github/') && options.github) {
      // The broker binds peers to their tailnet node, applies its allowlist and audits every call.
      const answer = await options.github.handle({
        method: request.method ?? 'GET',
        path: url.pathname.slice('/cloud/github/'.length),
        query: url.searchParams,
        caller,
        remoteAddress: request.socket.remoteAddress ?? '',
        readBody: (limitBytes) => readJson(request, limitBytes).catch((cause: unknown) => {
          if (cause instanceof HttpError) throw new BrokerError('too-large', `the request body is larger than ${limitBytes} bytes`);
          throw new BrokerError('bad-request', `the request body is not JSON: ${describeError(cause)}`);
        }),
      });
      writeJson(response, answer.status, answer.body);
      return;
    }

    if (url.pathname.startsWith('/cloud/secrets/') && options.secrets) {
      // Binds peers to their node, reads the manifest, applies the user's policy and audits (names only).
      const answer = await options.secrets.handle({
        method: request.method ?? 'GET',
        path: url.pathname.slice('/cloud/secrets/'.length),
        query: url.searchParams,
        caller,
        remoteAddress: request.socket.remoteAddress ?? '',
      });
      writeJson(response, answer.status, answer.body);
      return;
    }

    const route = `${request.method ?? 'GET'} ${url.pathname}`;
    switch (route) {
      case 'GET /cloud/status': {
        const host = url.searchParams.get('host') ?? '';
        if (!host) throw new HttpError(400, 'bad-request', 'host query parameter is required');
        writeWakeResult(response, await options.api.status(host));
        return;
      }
      case 'POST /cloud/wake': {
        const body = decodeBoundary(await readJson(request), wakeBodySchema);
        log(`[coordinator] wake ${body.host} requested by ${caller.id}`);
        writeWakeResult(response, await options.api.wake(body.host, { wait: body.wait ?? true, timeoutMs: body.timeoutMs }, caller));
        return;
      }
      case 'GET /cloud/alerts': {
        requireUser(caller);
        const limit = Number(url.searchParams.get('limit') ?? '50');
        writeJson(response, 200, { ok: true, alerts: options.alerts.recent(Number.isFinite(limit) ? limit : 50) });
        return;
      }
      case 'POST /cloud/reconcile': {
        requireUser(caller);
        const body = decodeBoundary(await readJson(request), runBodySchema);
        writeJson(response, 200, { ok: true, report: await options.api.reconcile({ dryRun: body.dryRun }) });
        return;
      }
      case 'POST /cloud/idle-check': {
        requireUser(caller);
        const body = decodeBoundary(await readJson(request), runBodySchema);
        writeJson(response, 200, { ok: true, report: await options.api.idleCheck({ dryRun: body.dryRun }) });
        return;
      }
      case 'PUT /cloud/directory': {
        requireUser(caller);
        if (!options.directoryWriter) throw new HttpError(405, 'read-only', 'this coordinator has a read-only directory');
        const sessions = await options.directoryWriter.replace(await readJson(request));
        log(`[coordinator] directory replaced by ${caller.id}: ${sessions} Session(s)`);
        writeJson(response, 200, { ok: true, sessions });
        return;
      }
      default:
        throw new HttpError(404, 'not-found', `no endpoint ${route}`);
    }
  };

  return http.createServer((request, response) => {
    handle(request, response).catch((cause: unknown) => {
      if (cause instanceof HttpError) {
        writeJson(response, cause.status, { ok: false, code: cause.code, message: cause.message });
        return;
      }
      const badInput = cause instanceof SyntaxError || (cause instanceof Error && cause.name === 'BoundaryDecodeError')
        || (cause instanceof Error && cause.message.startsWith('duplicate sessionId'));
      writeJson(response, badInput ? 400 : 500, { ok: false, code: badInput ? 'bad-request' : 'internal', message: describeError(cause) });
    });
  });
}

function writeWakeResult(response: ServerResponse, result: WakeResult): void {
  writeJson(response, result.ok ? 200 : FAILURE_STATUS[result.code], result);
}

function writeJson(response: ServerResponse, status: number, body: ResponseBody): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, limitBytes = MAX_BODY_BYTES): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limitBytes) throw new HttpError(413, 'too-large', 'request body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length === 0 ? {} : JSON.parse(text);
}
