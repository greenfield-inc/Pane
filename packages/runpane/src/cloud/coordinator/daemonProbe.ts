import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';
import type { DaemonHealth, DaemonProbe, SafeToStopAnswer, UpgradeAnswer, UpgradeTarget } from './types';

// Talks to a cloud Session's Pane daemon over the tailnet: GET /health (unauthenticated) and
// POST /invoke with the coordinator's own paired-client bearer token.

const SAFE_TO_STOP_CHANNEL = 'runpane:cloud:safe-to-stop';
const UPGRADE_CHANNEL = 'runpane:cloud:upgrade';

const healthSchema = boundary.object({
  ok: boundary.optional(boundary.boolean),
  status: boundary.optional(boundary.string),
  ready: boundary.optional(boundary.boolean),
  composersReady: boundary.optional(boundary.boolean),
  version: boundary.optional(boundary.nullable(boundary.string)),
  readiness: boundary.optional(boundary.nullable(boundary.object({
    state: boundary.optional(boundary.string),
    ready: boundary.optional(boundary.boolean),
  }))),
});

const invokeSchema = boundary.object({
  ok: boundary.boolean,
  result: boundary.optional(boundary.json),
  error: boundary.optional(boundary.object({
    message: boundary.optional(boundary.string),
    code: boundary.optional(boundary.string),
  })),
});

// The daemon's safe-to-stop result: blockers name the refusing condition; `flush` is non-null once the
// daemon has tried to checkpoint SQLite's WAL and fsync (which only happens when safe), and its
// `durable` is true only when every step succeeded. Daemons from before `durable` never confirm.
const safeToStopResultSchema = boundary.object({
  safe: boundary.boolean,
  blockers: boundary.optional(boundary.array(boundary.object({
    condition: boundary.optional(boundary.string),
    message: boundary.optional(boundary.string),
  }))),
  flush: boundary.optional(boundary.nullable(boundary.object({
    durable: boundary.optional(boundary.boolean),
  }))),
});

/**
 * Readiness means "agents are usable", not just "the HTTP server answers". Newer daemons report
 * `readiness.state` ("starting" | "ready" | "degraded"; degraded = awake, but some agent panels did
 * not come back). Their `status` stays "ready" for old clients, so it only counts for daemons without `readiness`.
 */
export function decodeHealth(body: JsonValue): DaemonHealth {
  const health = decodeBoundary(body, healthSchema);
  const version = health.version ?? null;
  const state = health.readiness?.state;
  if (state !== undefined) {
    return { reachable: true, ready: state !== 'starting', version, detail: state === 'ready' ? null : `readiness ${state}` };
  }
  if (health.readiness?.ready !== undefined) {
    return { reachable: true, ready: health.readiness.ready, version, detail: null };
  }
  const statusReady = health.status === undefined ? health.ok === true : health.status === 'ready';
  const ready = health.ready ?? (statusReady && (health.composersReady ?? true));
  return { reachable: true, ready, version, detail: 'daemon reports no readiness (older build)' };
}

export function decodeSafeToStop(result: JsonValue): SafeToStopAnswer {
  const decoded = decodeBoundary(result, safeToStopResultSchema);
  if (decoded.safe) return { kind: 'safe', checkpointed: decoded.flush?.durable === true };
  const reasons = (decoded.blockers ?? []).map((blocker) => (
    [blocker.condition, blocker.message].filter(Boolean).join(': ')
  ));
  return { kind: 'unsafe', reasons: reasons.length > 0 ? reasons : ['daemon reported unsafe without reasons'] };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class HttpDaemonProbe implements DaemonProbe {
  private readonly fetchImpl: FetchLike;
  private readonly healthTimeoutMs: number;
  private readonly invokeTimeoutMs: number;

  constructor(options: { fetchImpl?: FetchLike; healthTimeoutMs?: number; invokeTimeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.healthTimeoutMs = options.healthTimeoutMs ?? 4000;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 60_000;
  }

  async health(baseUrl: string): Promise<DaemonHealth> {
    try {
      const response = await this.fetchImpl(`${baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) return { reachable: false, error: `HTTP ${response.status}` };
      return decodeHealth(await response.json());
    } catch (error) {
      return { reachable: false, error: describeError(error) };
    }
  }

  async safeToStop(baseUrl: string, token: string): Promise<SafeToStopAnswer> {
    const answer = await this.invoke(baseUrl, token, SAFE_TO_STOP_CHANNEL, [{}]);
    if (answer.kind !== 'ok') return answer;
    try {
      return decodeSafeToStop(answer.result);
    } catch (error) {
      return { kind: 'error', error: `unexpected safe-to-stop result: ${describeError(error)}` };
    }
  }

  async upgrade(baseUrl: string, token: string, target: UpgradeTarget): Promise<UpgradeAnswer> {
    const answer = await this.invoke(baseUrl, token, UPGRADE_CHANNEL, [{ version: target.version, url: target.url, sha256: target.sha256 }]);
    return answer.kind === 'ok' ? { kind: 'started' } : answer;
  }

  private async invoke(
    baseUrl: string,
    token: string,
    channel: string,
    args: JsonValue[],
  ): Promise<{ kind: 'ok'; result: JsonValue } | { kind: 'unsupported' | 'error'; error: string }> {
    try {
      const response = await this.fetchImpl(`${baseUrl}/invoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args }),
        signal: AbortSignal.timeout(this.invokeTimeoutMs),
      });
      const payload = decodeBoundary(await response.json(), invokeSchema);
      if (payload.ok) return { kind: 'ok', result: payload.result ?? null };
      const code = payload.error?.code ?? `HTTP ${response.status}`;
      const message = `${code}: ${payload.error?.message ?? 'daemon request failed'}`;
      return code === 'ERR_UNKNOWN_CHANNEL' ? { kind: 'unsupported', error: message } : { kind: 'error', error: message };
    } catch (error) {
      return { kind: 'error', error: describeError(error) };
    }
  }
}

export function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = cause.cause instanceof Error ? ` (${cause.cause.message})` : '';
    return `${cause.message}${inner}`;
  }
  return String(cause);
}
