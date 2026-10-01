import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { DaemonHealthResult } from './types';

interface WaitForDaemonHealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** The host's paired token: without it the daemon only says it answers, not its version or readiness. */
  token?: string;
}

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
  const url = `${baseUrl.replace(/\/+$/, '')}/health`;
  const started = Date.now();
  let last: Omit<DaemonHealthResult, 'elapsedMs'> = { ok: false };

  for (;;) {
    last = await probe(fetchImpl, url, requestTimeoutMs, options.token);
    const elapsedMs = Date.now() - started;
    if (last.ok || elapsedMs + intervalMs > timeoutMs) {
      return { ...last, elapsedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function probe(
  fetchImpl: typeof fetch,
  url: string,
  requestTimeoutMs: number,
  token: string | undefined,
): Promise<Omit<DaemonHealthResult, 'elapsedMs'>> {
  try {
    const response = await fetchImpl(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
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
