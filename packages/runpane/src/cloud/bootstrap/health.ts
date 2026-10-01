import { boundary, decodeBoundary } from '../../boundaryDecoder';
import { nodeHttpTransport, RemoteRequestError, type RemoteHttpTransport } from '../../remote/remoteDaemonClient';
import type { DaemonHealthResult } from './types';

interface WaitForDaemonHealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** The host's paired token: without it the daemon only says it answers, not its version or readiness. */
  token?: string;
  /** Carries the token; the default refuses to send it over plain HTTP off the tailnet. */
  transport?: RemoteHttpTransport;
}

const PLAIN_HTTP_OFF_TAILNET = 'ERR_PLAIN_HTTP_OFF_TAILNET';

/**
 * Polls `GET <baseUrl>/health` (with the paired token when given) until the daemon reports ready or the timeout
 * passes. Ready means HTTP 200 with `ok: true` and, when the daemon reports readiness,
 * `readiness.state` "ready" or "degraded" (degraded is usable); older daemons only report
 * `status: "ready"`.
 */
export async function waitForDaemonHealth(
  baseUrl: string,
  options: WaitForDaemonHealthOptions = {},
): Promise<DaemonHealthResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const transport = options.transport ?? nodeHttpTransport;
  let token = options.token;
  const url = `${baseUrl.replace(/\/+$/, '')}/health`;
  const started = Date.now();
  let last: Omit<DaemonHealthResult, 'elapsedMs'> = { ok: false };

  for (;;) {
    try {
      last = token ? await probeWithToken(transport, url, requestTimeoutMs, token) : await probe(fetchImpl, url, requestTimeoutMs);
    } catch {
      // The token may not leave over this route (plain HTTP off the tailnet): ask without it instead.
      token = undefined;
      last = await probe(fetchImpl, url, requestTimeoutMs);
    }
    const elapsedMs = Date.now() - started;
    if (last.ok || elapsedMs + intervalMs > timeoutMs) {
      return { ...last, elapsedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Throws only when the transport refuses the route; every other failure is a not-ready answer. */
async function probeWithToken(
  transport: RemoteHttpTransport,
  url: string,
  requestTimeoutMs: number,
  token: string,
): Promise<Omit<DaemonHealthResult, 'elapsedMs'>> {
  try {
    const response = await transport({
      url,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      connectTimeoutMs: requestTimeoutMs,
      timeoutMs: requestTimeoutMs,
    });
    if (response.status !== 200) return { ok: false, status: response.status };
    return { status: response.status, ...interpretHealthBody(decodeBoundary(JSON.parse(response.body), healthPayloadSchema)) };
  } catch (error) {
    if (error instanceof RemoteRequestError && error.code === PLAIN_HTTP_OFF_TAILNET) throw error;
    return { ok: false };
  }
}

async function probe(
  fetchImpl: typeof fetch,
  url: string,
  requestTimeoutMs: number,
): Promise<Omit<DaemonHealthResult, 'elapsedMs'>> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (response.status !== 200) {
      return { ok: false, status: response.status };
    }
    return { status: response.status, ...interpretHealthBody(decodeBoundary(await response.json(), healthPayloadSchema)) };
  } catch {
    return { ok: false };
  }
}

const healthPayloadSchema = boundary.object({
  ok: boundary.optional(boundary.boolean),
  status: boundary.optional(boundary.string),
  version: boundary.optional(boundary.string),
  readiness: boundary.optional(boundary.object({ state: boundary.optional(boundary.string) })),
});

/** The `/health` fields bootstrap reads; newer daemons add `readiness`. */
interface HealthPayload {
  ok?: boolean;
  status?: string;
  version?: string;
  readiness?: { state?: string };
}

interface HealthInterpretation {
  ok: boolean;
  version?: string;
  readiness?: string;
}

export function interpretHealthBody(body: HealthPayload): HealthInterpretation {
  const readiness = body.readiness ? body.readiness.state : body.status;
  const ready = body.readiness
    ? readiness === 'ready' || readiness === 'degraded'
    : readiness === 'ready';
  return { ok: body.ok === true && ready, version: body.version, readiness };
}
