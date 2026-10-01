import { boundary, decodeBoundary } from '../../boundaryDecoder';
import type { JsonValue } from '../../boundaryDecoder';
import type { CoordinatorProvider, ProviderSandbox, ProviderSandboxState } from './types';

// Minimal boat.dev client for the coordinator. It needs only sandbox.read, sandbox.stop and sandbox.resume,
// which is exactly what the coordinator's scoped key grants. There is deliberately no delete here.

const sandboxSchema = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.optional(boundary.nullable(boundary.string)),
  state: boundary.string,
  createdAt: boundary.optional(boundary.nullable(boundary.string)),
  updatedAt: boundary.optional(boundary.nullable(boundary.string)),
  team: boundary.optional(boundary.nullable(boundary.object({ id: boundary.nonEmptyString }))),
});

const listSchema = boundary.object({
  sandboxes: boundary.array(sandboxSchema),
  pageInfo: boundary.optional(boundary.nullable(boundary.object({
    nextCursor: boundary.optional(boundary.nullable(boundary.string)),
  }))),
});

const infoSchema = boundary.object({ sandbox: sandboxSchema });

export function mapBoatState(state: string): ProviderSandboxState {
  switch (state) {
    case 'init':
    case 'provisioning':
    case 'provisioned':
    case 'cloning':
      return 'starting';
    case 'ready':
    case 'idle':
    case 'running':
      return 'running';
    case 'archiving':
      return 'stopping';
    case 'archived':
      return 'stopped';
    case 'error':
    case 'cancelled':
      return 'failed';
    default:
      return 'failed';
  }
}

function toProviderSandbox(raw: {
  id: string;
  name?: string | null;
  state: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  team?: { id: string } | null;
}): ProviderSandbox {
  return {
    id: raw.id,
    name: raw.name ?? '',
    state: mapBoatState(raw.state),
    rawState: raw.state,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    org: raw.team === undefined ? null : raw.team?.id ?? 'personal',
  };
}

export class BoatProviderError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'BoatProviderError';
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface BoatProviderOptions {
  apiBase: string;
  apiKey: string;
  /** The wallet calls are scoped to (X-Boat-Org) when a call names none; null/undefined: the account's active wallet. */
  org?: string | null;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

export class BoatCoordinatorProvider implements CoordinatorProvider {
  readonly kind = 'boat';
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: BoatProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async list(): Promise<ProviderSandbox[]> {
    const result: ProviderSandbox[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const body = await this.request('GET', `/sandboxes?${query.toString()}`);
      const decoded = decodeBoundary(body, listSchema);
      result.push(...decoded.sandboxes.map(toProviderSandbox));
      cursor = decoded.pageInfo?.nextCursor ?? null;
      if (!cursor) return result;
    }
    throw new BoatProviderError('boat sandbox list did not finish after 50 pages', 0, 'pagination');
  }

  async get(sandboxId: string, org?: string | null): Promise<ProviderSandbox> {
    try {
      const body = await this.request('GET', `/sandboxes/${encodeURIComponent(sandboxId)}`, org);
      return toProviderSandbox(decodeBoundary(body, infoSchema).sandbox);
    } catch (error) {
      if (error instanceof BoatProviderError && error.status === 404) {
        return { id: sandboxId, name: '', state: 'missing', rawState: 'not_found', createdAt: null, updatedAt: null };
      }
      throw error;
    }
  }

  async stop(sandboxId: string, org?: string | null): Promise<void> {
    await this.request('POST', `/sandboxes/${encodeURIComponent(sandboxId)}/stop`, org);
  }

  async resume(sandboxId: string, org?: string | null): Promise<void> {
    // boat's resume takes no Idempotency-Key; the wake service single-flights resumes and treats 409 as "already resuming".
    await this.request('POST', `/sandboxes/${encodeURIComponent(sandboxId)}/resume`, org);
  }

  private async request(method: 'GET' | 'POST', pathAndQuery: string, org?: string | null): Promise<JsonValue> {
    const headers = new Headers({ Authorization: `Bearer ${this.options.apiKey}`, Accept: 'application/json' });
    const wallet = org ?? this.options.org;
    if (wallet) headers.set('X-Boat-Org', wallet);
    if (method === 'POST') headers.set('Content-Type', 'application/json');
    const response = await this.fetchImpl(`${this.options.apiBase}${pathAndQuery}`, {
      method,
      headers,
      // boat's stop and resume take optional options; the coordinator always sends none.
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    let parsed: JsonValue = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code = readErrorCode(parsed);
      const detail = readErrorMessage(parsed);
      throw new BoatProviderError(
        `boat ${method} ${pathAndQuery.split('?')[0]} failed: HTTP ${response.status}${code ? ` (${code})` : ''}`
          + (detail ? `: ${detail}` : ''),
        response.status,
        code,
      );
    }
    return parsed;
  }
}

// boat errors come as `{error: "code"}` or `{error: {code}}`.
const boatErrorCodeReaders = [
  (value: JsonValue) => decodeBoundary(value, boundary.object({ error: boundary.string })).error,
  (value: JsonValue) => decodeBoundary(value, boundary.object({ error: boundary.object({ code: boundary.string }) })).error.code,
];

/** boat's human message, e.g. which start-limit window (minute/hour/day) refused a resume. */
function readErrorMessage(parsed: JsonValue): string | null {
  try {
    return decodeBoundary(parsed, boundary.object({ message: boundary.string })).message;
  } catch {
    return null;
  }
}

function readErrorCode(parsed: JsonValue): string | null {
  for (const read of boatErrorCodeReaders) {
    try {
      return read(parsed);
    } catch {
      // Not this shape; try the next one.
    }
  }
  return null;
}
