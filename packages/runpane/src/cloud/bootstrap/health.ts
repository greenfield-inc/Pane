import { boundary, decodeBoundary } from '../../boundaryDecoder';

export interface DaemonHealthResult {
  ok: boolean;
  status?: number;
  elapsedMs: number;
  version?: string;
  /** `readiness.state` when the daemon reports it, else the `status` field. */
  readiness?: string;
}

interface WaitForDaemonHealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls the daemon's unauthenticated `GET <baseUrl>/health` until it reports ready or the timeout
 * passes. Ready means HTTP 200 with `ok: true` and `readiness.state` "ready" or "degraded" when the
 * daemon reports readiness, else `status: "ready"`.
 */
export async function waitForDaemonHealth(
  baseUrl: string,
  options: WaitForDaemonHealthOptions = {},
): Promise<DaemonHealthResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${baseUrl.replace(/\/+$/u, '')}/health`;
  const started = Date.now();

  for (;;) {
    const last = await probe(fetchImpl, url, requestTimeoutMs);
    const elapsedMs = Date.now() - started;
    if (last.ok || elapsedMs + intervalMs > timeoutMs) {
      return { ...last, elapsedMs };
    }
    await sleep(intervalMs);
  }
}

async function probe(fetchImpl: typeof fetch, url: string, requestTimeoutMs: number): Promise<Omit<DaemonHealthResult, 'elapsedMs'>> {
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

type HealthPayload = ReturnType<typeof healthPayloadSchema.decode>;

function interpretHealthBody(body: HealthPayload): Omit<DaemonHealthResult, 'elapsedMs' | 'status'> {
  const readiness = body.readiness ? body.readiness.state : body.status;
  const ready = body.readiness
    ? readiness === 'ready' || readiness === 'degraded'
    : readiness === 'ready';
  return { ok: body.ok === true && ready, version: body.version, readiness };
}
