import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../../boundaryDecoder';
import type { CoordinatorRef } from '../../remote/hostDirectory';

/**
 * The GitHub broker on the `runpane cloud` coordinator (coordinator/github/broker.ts), as a cloud Session calls it:
 * with the Session's own `rpc1` caller token from its peers list. The broker holds the GitHub
 * credential; nothing here ever sees more than a read-only, one-repository installation token.
 */

/** The coordinator's request body limit; a push bundle travels base64 inside JSON. */
export const MAX_BROKER_BODY_BYTES = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 10 * 60_000;

type BrokerMode = 'app' | 'pat' | 'off';

interface BrokerStatus {
  mode: BrokerMode;
  app: string | null;
  /** Repositories the credential reaches (App installation or PAT). */
  repos: string[];
  /** What this Session may do, when the broker says (peer callers). */
  caller: { host: string | null; repos: string[]; branchPrefix: string | null } | null;
}

export interface PushResult {
  /** The branch GitHub now has, `cloud/<host>/<branch>`. */
  ref: string;
  sha: string;
  compareUrl: string | null;
  outcome: string;
}

export interface ItemResult {
  number: number;
  url: string;
  state: string | null;
}

export class BrokerError extends Error {
  override name = 'BrokerError';

  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

const errorSchema = boundary.object({
  ok: boundary.literal(false),
  code: boundary.optional(boundary.string),
  message: boundary.optional(boundary.string),
});

const statusSchema = boundary.object({
  mode: boundary.enumeration('app', 'pat', 'off'),
  app: boundary.optional(boundary.nullable(boundary.object({
    slug: boundary.optional(boundary.nullable(boundary.string)),
  }))),
  repos: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  caller: boundary.optional(boundary.nullable(boundary.object({
    host: boundary.optional(boundary.nullable(boundary.string)),
    repos: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
    namespace: boundary.optional(boundary.nullable(boundary.string)),
    branchPrefix: boundary.optional(boundary.nullable(boundary.string)),
  }))),
});

const tokenSchema = boundary.object({ token: boundary.nonEmptyString, expiresAt: boundary.optional(boundary.nullable(boundary.string)) });

const pushSchema = boundary.object({
  /** v1: `branch` is `cloud/<host>/<b>` and `ref` is `refs/heads/cloud/<host>/<b>`. */
  branch: boundary.optional(boundary.string),
  ref: boundary.nonEmptyString,
  sha: boundary.nonEmptyString,
  compareUrl: boundary.optional(boundary.nullable(boundary.string)),
  outcome: boundary.optional(boundary.string),
});

const itemSchema = boundary.object({
  number: boundary.number,
  url: boundary.optional(boundary.nullable(boundary.string)),
  html_url: boundary.optional(boundary.nullable(boundary.string)),
  state: boundary.optional(boundary.nullable(boundary.string)),
});

const readSchema = boundary.object({ data: boundary.json });

/** GET /cloud/github/status, for Sessions and for the laptop's user caller alike. */
export function decodeBrokerStatus(value: JsonValue | undefined): BrokerStatus {
  const body = decodeBoundary(value, statusSchema);
  return {
    mode: body.mode,
    // v1 sends app as {id, slug, installationId}.
    app: body.app?.slug ?? null,
    repos: body.repos ?? [],
    caller: body.caller
      ? { host: body.caller.host ?? null, repos: body.caller.repos ?? [], branchPrefix: body.caller.namespace ?? body.caller.branchPrefix ?? null }
      : null,
  };
}

type Method = 'GET' | 'POST' | 'PATCH';

export class BrokerClient {
  constructor(
    private readonly coordinator: CoordinatorRef,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get baseUrl(): string {
    return this.coordinator.baseUrl.replace(/\/+$/u, '');
  }

  async status(): Promise<BrokerStatus> {
    return decodeBrokerStatus(await this.call('GET', '/cloud/github/status'));
  }

  async readToken(repo: string): Promise<{ token: string; expiresAt: string | null }> {
    const body = decodeBoundary(await this.call('POST', '/cloud/github/token', { repo }), tokenSchema);
    return { token: body.token, expiresAt: body.expiresAt ?? null };
  }

  async push(request: { repo: string; branch: string; bundle: Buffer; force: boolean }): Promise<PushResult> {
    const payload: JsonObject = { repo: request.repo, branch: request.branch, bundle: request.bundle.toString('base64') };
    if (request.force) payload.force = true;
    const body = decodeBoundary(await this.call('POST', '/cloud/github/push', payload, PUSH_TIMEOUT_MS), pushSchema);
    const ref = body.branch || body.ref.replace(/^refs\/heads\//u, '');
    return { ref, sha: body.sha, compareUrl: body.compareUrl ?? null, outcome: body.outcome ?? 'pushed' };
  }

  createPull(request: { repo: string; branch: string; base?: string; title: string; body: string }): Promise<ItemResult> {
    const payload: JsonObject = { repo: request.repo, branch: request.branch, title: request.title, body: request.body, draft: true };
    if (request.base) payload.base = request.base;
    return this.item('POST', '/cloud/github/pulls', payload);
  }

  editPull(number: number, request: { repo: string; title?: string; body?: string; state?: 'open' | 'closed' }): Promise<ItemResult> {
    return this.item('PATCH', `/cloud/github/pulls/${number}`, compact(request));
  }

  createIssue(request: { repo: string; title: string; body: string; labels?: string[] }): Promise<ItemResult> {
    const payload: JsonObject = { repo: request.repo, title: request.title, body: request.body };
    if (request.labels && request.labels.length > 0) payload.labels = request.labels;
    return this.item('POST', '/cloud/github/issues', payload);
  }

  editIssue(number: number, request: { repo: string; title?: string; body?: string; state?: 'open' | 'closed' }): Promise<ItemResult> {
    return this.item('PATCH', `/cloud/github/issues/${number}`, compact(request));
  }

  async comment(request: { repo: string; number: number; body: string }): Promise<{ url: string | null }> {
    const body = decodeBoundary(await this.call('POST', '/cloud/github/comments', { ...request }), boundary.object({
      url: boundary.optional(boundary.nullable(boundary.string)),
      html_url: boundary.optional(boundary.nullable(boundary.string)),
    }));
    return { url: body.url ?? body.html_url ?? null };
  }

  /** `path` is a repository-relative REST path such as `pulls/12` or `issues?state=open` (v1: GET /cloud/github/read/<owner>/<name>/<path>). */
  async read(repo: string, path: string): Promise<JsonValue> {
    const [route, query] = path.replace(/^\/+/u, '').split('?', 2);
    return decodeBoundary(await this.call('GET', `/cloud/github/read/${repo}/${route}${query ? `?${query}` : ''}`), readSchema).data;
  }

  /** POST /cloud/secrets/fetch: this Session's manifest secrets, values included (decoded by the caller). */
  fetchSecrets(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JsonValue> {
    return this.call('POST', '/cloud/secrets/fetch', {}, timeoutMs);
  }

  /** GET /cloud/secrets/status: the coordinator's secrets service as this Session sees it (names only). */
  secretsStatus(): Promise<JsonValue> {
    return this.call('GET', '/cloud/secrets/status');
  }

  private async item(method: Method, path: string, payload: JsonObject): Promise<ItemResult> {
    const body = decodeBoundary(await this.call(method, path, payload), itemSchema);
    return { number: body.number, url: body.url ?? body.html_url ?? '', state: body.state ?? null };
  }

  private async call(method: Method, path: string, payload?: JsonObject, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<JsonValue> {
    const text = payload === undefined ? undefined : JSON.stringify(payload);
    if (text !== undefined && Buffer.byteLength(text) > MAX_BROKER_BODY_BYTES) {
      throw new BrokerError(`The request is ${Buffer.byteLength(text)} bytes; the coordinator takes at most ${MAX_BROKER_BODY_BYTES}.`, 'too-large', 413);
    }
    const headers = new Headers({ Authorization: `Bearer ${this.coordinator.token}` });
    if (text !== undefined) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: text,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BrokerError(`Could not reach the runpane cloud coordinator at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, 'unreachable', 0);
    }
    const raw = await response.text();
    let parsed: JsonValue | undefined;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const failure = decodeFailure(parsed);
    if (!response.ok || failure) {
      let message = failure?.message ?? `The coordinator answered HTTP ${response.status}.`;
      if (!failure && response.status === 404) {
        message = `The coordinator has no ${path.startsWith('/cloud/secrets/') ? 'secrets service' : 'GitHub broker'} (it answered 404); it needs a newer runpane build (runpane cloud coordinator deploy).`;
      }
      throw new BrokerError(message, failure?.code ?? `http-${response.status}`, response.status);
    }
    if (parsed === undefined) throw new BrokerError(`The coordinator answered ${response.status} with a body that is not JSON.`, 'bad-response', response.status);
    return parsed;
  }
}

/** The broker's `{ok: false, code, message}` answer, or null for anything else. */
function decodeFailure(value: JsonValue | undefined): { code?: string; message?: string } | null {
  try {
    const failure = decodeBoundary(value, errorSchema);
    return { code: failure.code, message: failure.message };
  } catch {
    return null;
  }
}

function compact(request: { repo: string; title?: string; body?: string; state?: 'open' | 'closed' }): JsonObject {
  const payload: JsonObject = { repo: request.repo };
  if (request.title !== undefined) payload.title = request.title;
  if (request.body !== undefined) payload.body = request.body;
  if (request.state !== undefined) payload.state = request.state;
  return payload;
}
