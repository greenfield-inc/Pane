import { boundary, decodeBoundary } from '../boundaryDecoder';
import type { CoordinatorRef } from './hostDirectory';
import { DEFAULT_CONNECT_TIMEOUT_MS, nodeHttpTransport, type RemoteHttpHeaders, type RemoteHttpTransport } from './remoteDaemonClient';

/** `awake` is the coordinator's success answer; the other four are the plan's sleep states. */
type CloudHostStatus = 'awake' | 'asleep' | 'waking' | 'daemon-down' | 'lost';

export interface CloudHostState {
  status: CloudHostStatus;
  baseUrl?: string;
  detail?: string;
}

const hostStateSchema = boundary.union(
  boundary.object({
    ok: boundary.literal(true),
    status: boundary.enumeration('awake', 'asleep', 'waking', 'daemon-down', 'lost'),
    baseUrl: boundary.optional(boundary.nullable(boundary.string)),
    detail: boundary.optional(boundary.nullable(boundary.string)),
  }),
  boundary.object({
    ok: boundary.literal(false),
    code: boundary.optional(boundary.string),
    message: boundary.optional(boundary.string),
  }),
);

export class CoordinatorError extends Error {
  override name = 'CoordinatorError';

  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/**
 * Talks to the `runpane cloud` coordinator (src/cloud/coordinator):
 * `GET /cloud/status?host=` never wakes; `POST /cloud/wake` resumes and waits for /health.
 */
export class CoordinatorClient {
  constructor(
    private readonly coordinator: CoordinatorRef,
    private readonly transport: RemoteHttpTransport = nodeHttpTransport,
  ) {}

  status(host: string): Promise<CloudHostState> {
    return this.call('GET', `/cloud/status?host=${encodeURIComponent(host)}`, undefined, 30_000);
  }

  wake(host: string, waitMs: number): Promise<CloudHostState> {
    return this.call('POST', '/cloud/wake', JSON.stringify({ host, wait: true, timeoutMs: waitMs }), waitMs + 15_000);
  }

  private async call(method: 'GET' | 'POST', path: string, body: string | undefined, timeoutMs: number): Promise<CloudHostState> {
    const headers: RemoteHttpHeaders = { Authorization: `Bearer ${this.coordinator.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await this.transport({
        url: `${this.coordinator.baseUrl.replace(/\/+$/, '')}${path}`,
        method,
        headers,
        body,
        connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
        timeoutMs,
      });
    } catch (error) {
      throw new CoordinatorError(
        `Could not reach the runpane cloud coordinator at ${this.coordinator.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        'ERR_RUNPANE_COORDINATOR_UNREACHABLE',
      );
    }
    let decoded;
    try {
      decoded = decodeBoundary(JSON.parse(response.body), hostStateSchema);
    } catch {
      decoded = null;
    }
    if (response.status === 401 || response.status === 403) {
      const reason = decoded && !decoded.ok && decoded.message ? ` (${decoded.message})` : '';
      throw new CoordinatorError(`The runpane cloud coordinator rejected this caller token${reason}.`, 'ERR_RUNPANE_COORDINATOR_AUTH');
    }
    if (!decoded) {
      throw new CoordinatorError(`The runpane cloud coordinator answered ${response.status} with an unreadable body.`, 'ERR_RUNPANE_COORDINATOR_BAD_RESPONSE');
    }
    if (!decoded.ok) {
      // unknown-host means the coordinator's directory has no such Session.
      if (decoded.code === 'unknown-host') return { status: 'lost', detail: decoded.message ?? 'unknown host' };
      throw new CoordinatorError(decoded.message ?? `Coordinator error ${decoded.code ?? response.status}`, `ERR_RUNPANE_COORDINATOR_${(decoded.code ?? 'ERROR').toUpperCase().replace(/-/g, '_')}`);
    }
    const state: CloudHostState = { status: decoded.status };
    if (decoded.baseUrl) state.baseUrl = decoded.baseUrl;
    if (decoded.detail) state.detail = decoded.detail;
    return state;
  }
}
