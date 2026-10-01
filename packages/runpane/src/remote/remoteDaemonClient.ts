// Ported from shared/remoteClient/remoteDaemonClient.ts (#736, greenfield-inc/Pane
// rn-pane-expo-app @ c391631c). packages/runpane cannot import shared/, so the
// invoke half is copied here like boundaryDecoder.ts. The CLI makes one-shot
// calls, so the SSE event stream, reconnect loop and status listeners are left out.
// The retry policy, error classes and invoke envelope match the original.
import http from 'node:http';
import https from 'node:https';
import { boundary, decodeBoundary, type JsonValue } from '../boundaryDecoder';

export interface RemoteHostProfile {
  id: string;
  label: string;
  baseUrl: string;
  token: string;
}

export interface RemoteHttpHeaders {
  Authorization: string;
  'Content-Type'?: 'application/json';
}

export interface RemoteHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: RemoteHttpHeaders;
  body?: string;
  /** Give up if the TCP/TLS connection has not opened by then. */
  connectTimeoutMs: number;
  /** Give up if the whole response has not arrived by then. */
  timeoutMs: number;
}

export interface RemoteHttpResponse {
  status: number;
  body: string;
}

/**
 * Sends one HTTP request. Rejects with `RemoteConnectError` when the connection
 * never opened, so the caller knows the host cannot have seen the request.
 */
export type RemoteHttpTransport = (request: RemoteHttpRequest) => Promise<RemoteHttpResponse>;

/** The host rejected the connection code. Retrying cannot help. */
export class RemoteAuthError extends Error {
  override name = 'RemoteAuthError';
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

/** The connection never opened, so the host did not receive the request. Safe to retry. */
export class RemoteConnectError extends Error {
  override name = 'RemoteConnectError';

  constructor(message: string, readonly code: string) {
    super(message);
  }
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
    })),
  }),
);

const INVOKE_ATTEMPTS = 4;
const REQUEST_RETRY_DELAY_MS = 2_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 6_000;

// Retry only reviewed reads. A command name or runtime ID cannot prove that
// replaying it is safe after the host applied it but its response was lost.
// The runpane:* entries are the CLI's read-only local-control channels.
const RETRYABLE_READ_CHANNELS = new Set([
  'sessions:get-all-with-projects',
  'sessions:get',
  'panels:list',
  'panels:getActive',
  'panels:checkInitialized',
  'panels:get-output',
  'projects:list-branches',
  'projects:detect-branch',
  'remote:pwa-affordances',
  'mobile:push-status',
  'runpane:workspace:state',
  'permission:getPending',
  'sessions:get-archived-with-projects',
  'terminal:getState',
  'runpane:doctor',
  'runpane:repos:list',
  'runpane:panes:list',
  'runpane:panels:list',
  'runpane:panels:screen',
  'runpane:panels:output',
  'runpane:sessions:list',
  'runpane:sessions:get',
  'runpane:ports:list',
]);

export interface RemoteDaemonClientOptions {
  profile: RemoteHostProfile;
  runtimeId: string;
  clientLabel: string;
  transport?: RemoteHttpTransport;
  connectTimeoutMs?: number;
  retryDelayMs?: number;
}

/** Client for a Pane daemon's HTTP `/invoke` and `/health` API. */
export class RemoteDaemonClient {
  readonly profile: RemoteHostProfile;
  private readonly transport: RemoteHttpTransport;
  private readonly runtimeId: string;
  private readonly clientLabel: string;
  private readonly connectTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: RemoteDaemonClientOptions) {
    this.profile = options.profile;
    this.transport = options.transport ?? nodeHttpTransport;
    this.runtimeId = options.runtimeId;
    this.clientLabel = options.clientLabel;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? REQUEST_RETRY_DELAY_MS;
  }

  /**
   * Invokes a daemon channel. A connection that never opened always surfaces as
   * `RemoteConnectError` (never retried here) so the caller can decide to wake
   * the host and resend. Anything that failed after the connection opened is
   * retried only for reviewed reads.
   */
  async invoke(channel: string, args: unknown[], options: { timeoutMs: number }): Promise<JsonValue | undefined> {
    const retryableRead = RETRYABLE_READ_CHANNELS.has(channel);
    const attempts = retryableRead ? INVOKE_ATTEMPTS : 1;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.transport({
          url: this.endpoint('invoke'),
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.profile.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channel, args, runtimeId: this.runtimeId, clientLabel: this.clientLabel }),
          connectTimeoutMs: this.connectTimeoutMs,
          timeoutMs: options.timeoutMs,
        });

        const payload = decodeInvokeResponse(parseJsonBody(response.body));
        const failure = payload?.ok === false ? payload.error : undefined;
        if (isAuthFailureResponse(response.status)) {
          // A 403 with a structured code is a policy refusal (e.g. a peer
          // calling a channel outside its allowlist), not a bad token.
          if (failure?.code && response.status === 403 && !failure.code.includes('AUTH')) {
            throw new RemoteRequestError(failure.message ?? 'Remote request was refused', response.status, failure.code);
          }
          throw new RemoteAuthError(getRemoteAuthFailureMessage(failure?.message));
        }
        if (response.status >= 200 && response.status < 300 && payload?.ok) {
          return payload.result;
        }

        const message = payload?.ok
          ? `Remote request failed with ${response.status}`
          : failure?.message ?? `Remote request failed with ${response.status}`;
        // The daemon's own error envelope means it ran the request and said no; only a response
        // without it (a proxy's error page) leaves a mutation's outcome unknown.
        if (!isRetryableResponse(response.status) || (failure?.code && !retryableRead)) {
          throw new RemoteRequestError(message, response.status, failure?.code ?? null);
        }
        lastError = new Error(message);
      } catch (error) {
        if (error instanceof RemoteAuthError || error instanceof RemoteRequestError || error instanceof RemoteConnectError) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error('Remote request failed');
      }

      if (attempt < attempts) {
        await delay(this.retryDelayMs * attempt);
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

  private endpoint(path: 'health' | 'invoke'): string {
    return `${this.profile.baseUrl.replace(/\/+$/, '')}/${path}`;
  }
}

function isAuthFailureResponse(status: number): boolean {
  return status === 401 || status === 403;
}

function getRemoteAuthFailureMessage(serverMessage?: string): string {
  const detail = serverMessage && serverMessage !== 'Remote request failed'
    ? ` (${serverMessage})`
    : '';
  return `This connection code is not accepted by the remote host${detail}. Create and copy a new code from Pane Settings > Remote Pane, then reconnect.`;
}

function parseJsonBody(body: string): JsonValue | null {
  try {
    return decodeBoundary(JSON.parse(body), boundary.json);
  } catch {
    return null;
  }
}

/** Returns null for a body that is not an invoke envelope, such as a proxy's error page. */
function decodeInvokeResponse(body: JsonValue | null) {
  try {
    return decodeBoundary(body, invokeResponseSchema);
  } catch {
    return null;
  }
}

function isRetryableResponse(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * node:http(s) transport. Unlike fetch it can tell "never connected" apart
 * from "connected, then failed", which decides whether a resend is safe.
 * No keep-alive agent: every call opens its own connection.
 */
function outgoingHeaders(request: RemoteHttpRequest): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { Authorization: request.headers.Authorization };
  if (request.headers['Content-Type']) headers['Content-Type'] = request.headers['Content-Type'];
  if (request.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(request.body));
  return headers;
}

export const nodeHttpTransport: RemoteHttpTransport = (request) => new Promise((resolve, reject) => {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  const requestFn = secure ? https.request : http.request;
  let opened = false;
  let settled = false;
  const finish = (outcome: { response: RemoteHttpResponse } | { error: Error }) => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    clearTimeout(totalTimer);
    if ('error' in outcome) {
      req.destroy();
      reject(outcome.error);
      return;
    }
    resolve(outcome.response);
  };

  const req = requestFn(url, {
    method: request.method,
    headers: outgoingHeaders(request),
    agent: false,
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => finish({ response: { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') } }));
    res.on('error', (error) => finish({ error }));
  });

  req.on('socket', (socket) => {
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      opened = true;
    });
  });
  req.on('error', (error: NodeJS.ErrnoException) => {
    if (!opened) {
      finish({ error: new RemoteConnectError(`Could not connect to ${url.host}: ${error.message}`, error.code ?? 'ECONNFAILED') });
      return;
    }
    finish({ error });
  });

  const connectTimer = setTimeout(() => {
    if (!opened) {
      finish({ error: new RemoteConnectError(`Timed out connecting to ${url.host} after ${request.connectTimeoutMs} ms`, 'ETIMEDOUT') });
    }
  }, request.connectTimeoutMs);
  const totalTimer = setTimeout(() => {
    finish({ error: new Error(`Timed out waiting for ${url.host} after ${request.timeoutMs} ms`) });
  }, request.timeoutMs);

  if (request.body !== undefined) {
    req.write(request.body);
  }
  req.end();
});
