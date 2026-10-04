import { randomBytes } from 'node:crypto';
import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '../boundaryDecoder';
import {
  CLOUD_SIZES,
  CloudProviderError,
  PERSONAL_ORG,
  type CloudProvider,
  type CloudSandbox,
  type CloudSandboxState,
  type CloudSize,
  type CreateSandboxRequest,
  type SandboxCommandResult,
  type SandboxHandle,
} from './provider';

/**
 * boat.dev REST adapter (OpenAPI: https://boat.dev/api/v1). Gotchas it encodes, all seen live:
 * - create has no name field, so a create is followed by PATCH { name };
 * - DELETE needs `X-Ascii-Confirm-Delete: <sandboxId>`;
 * - POST /commands takes one command string and caps a synchronous run at 600 s, so scripts are
 *   uploaded with PUT /files and run as `bash <file>`;
 * - `idle` means ready; `archived` means stopped.
 */

const BOAT_API_BASE_URL = 'https://boat.dev/api/v1';
const MAX_COMMAND_TIMEOUT_SECONDS = 600;
/** boat's login user is `user`; bootstrap keeps its 0700 state dir here. */
const SCRIPT_DIR = '/home/user/.runpane-cloud';
const RETRY_DELAYS_MS = [500, 1_500, 4_000];

export interface BoatProviderOptions {
  apiKey: string;
  /**
   * The wallet every call is scoped to (`X-Boat-Org`), and the one a create bills (body `org`).
   * Omitted, boat applies the account's active wallet, which anyone can change from the dashboard.
   */
  org?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface CreateBody {
  type: CloudSize;
  ttlSeconds: null;
  noEnv: true;
  org?: string;
}

type BoatRequestBody =
  | CreateBody
  | { name: string }
  | { path: string; content: string; encoding: 'base64' }
  | { command: string; timeoutSeconds: number }
  | Record<string, never>;

interface BoatRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: BoatRequestBody;
  headers?: Record<string, string>;
  /** Safe to resend: reads, and creates carrying an Idempotency-Key. */
  retry?: boolean;
  /** Send without the wallet header (X-Boat-Org). */
  withoutWallet?: boolean;
}

interface BoatResponse {
  status: number;
  body: JsonValue | undefined;
}

const optionalText = boundary.optional(boundary.nullable(boundary.string));

const sandboxSchema = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.optional(boundary.string),
  state: boundary.optional(boundary.string),
  type: boundary.optional(boundary.string),
  error: optionalText,
  createdAt: optionalText,
  /** The organization billed, or null when the owner (personal) is billed. */
  team: boundary.optional(boundary.nullable(boundary.object({ id: boundary.nonEmptyString, name: boundary.string }))),
});
type BoatSandbox = ReturnType<typeof sandboxSchema.decode>;

const sandboxEnvelopeSchema = boundary.object({ sandbox: boundary.optional(sandboxSchema) });

const sandboxListSchema = boundary.object({
  sandboxes: boundary.optional(boundary.array(sandboxSchema)),
  nextCursor: optionalText,
});

const commandResultSchema = boundary.object({
  exitCode: boundary.optional(boundary.nullable(boundary.number)),
  stdout: boundary.optional(boundary.string),
  stderr: boundary.optional(boundary.string),
  timedOut: boundary.optional(boundary.boolean),
});
const commandEnvelopeSchema = boundary.object({ result: boundary.optional(commandResultSchema) });

const accountFields = {
  email: optionalText,
  username: optionalText,
  id: optionalText,
};
const meSchema = boundary.object({ ...accountFields, user: boundary.optional(boundary.object(accountFields)) });

const orgListSchema = boundary.object({
  orgs: boundary.array(boundary.object({
    id: boundary.nonEmptyString,
    name: boundary.string,
    type: boundary.string,
    active: boundary.optional(boundary.boolean),
  })),
});

const errorFields = { code: boundary.optional(boundary.string), message: boundary.optional(boundary.string) };
const errorSchema = boundary.object({ ...errorFields, error: boundary.optional(boundary.object(errorFields)) });

export function createBoatProvider(options: BoatProviderOptions): CloudProvider {
  const baseUrl = (options.baseUrl ?? BOAT_API_BASE_URL).replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(request: BoatRequest): Promise<BoatResponse> {
    const attempts = request.retry ? RETRY_DELAYS_MS.length + 1 : 1;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 4_000);
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${options.apiKey}`);
      headers.set('Accept', 'application/json');
      if (options.org && !request.withoutWallet && !headers.has('X-Boat-Org')) headers.set('X-Boat-Org', options.org);
      if (request.body) headers.set('Content-Type', 'application/json');
      try {
        const response = await fetchImpl(`${baseUrl}${request.path}`, {
          method: request.method,
          headers,
          body: request.body ? JSON.stringify(request.body) : undefined,
        });
        const body = parseJson(await response.text());
        if (response.status >= 500 && attempt < attempts - 1) {
          lastError = boatError(request, response.status, body);
          continue;
        }
        return { status: response.status, body };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error(`boat ${request.method} ${request.path} failed`);
  }

  async function call(request: BoatRequest, okStatuses: readonly number[] = [200, 201, 202]): Promise<JsonValue | undefined> {
    const response = await send(request);
    if (!okStatuses.includes(response.status)) throw boatError(request, response.status, response.body);
    return response.body;
  }

  function decode<Value>(body: JsonValue | undefined, schema: BoundarySchema<Value>, request: Pick<BoatRequest, 'method' | 'path'>): Value {
    try {
      return decodeBoundary(body, schema);
    } catch (error) {
      throw new CloudProviderError(
        `boat ${request.method} ${request.path.split('?')[0]} returned an unexpected body: ${error instanceof Error ? error.message : 'unknown'}`,
        0,
      );
    }
  }

  /** boat wraps a sandbox as `{ sandbox }` on most calls, and returns it bare on some. */
  function decodeSandbox(body: JsonValue | undefined, request: Pick<BoatRequest, 'method' | 'path'>): CloudSandbox {
    const envelope = decode(body, sandboxEnvelopeSchema, request);
    return toCloudSandbox(envelope.sandbox ?? decode(body, sandboxSchema, request));
  }

  async function getSandbox(sandboxId: string, withoutWallet = false): Promise<CloudSandbox> {
    const request: BoatRequest = { method: 'GET', path: `/sandboxes/${encodeId(sandboxId)}`, retry: true, withoutWallet };
    const response = await send(request);
    if (response.status === 404) return goneSandbox(sandboxId);
    if (response.status !== 200) throw boatError(request, response.status, response.body);
    return decodeSandbox(response.body, request);
  }

  function handle(sandboxId: string): SandboxHandle {
    const writeFile = async (path: string, content: string): Promise<void> => {
      await call({
        method: 'PUT',
        path: `/sandboxes/${encodeId(sandboxId)}/files`,
        body: { path, content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
      });
    };
    return {
      id: sandboxId,
      writeFile,
      async runScript(script, runOptions): Promise<SandboxCommandResult> {
        const timeoutSeconds = Math.min(
          Math.max(1, Math.floor(runOptions?.timeoutSeconds ?? MAX_COMMAND_TIMEOUT_SECONDS)),
          MAX_COMMAND_TIMEOUT_SECONDS,
        );
        const file = `${SCRIPT_DIR}/run-${randomBytes(6).toString('hex')}.sh`;
        await writeFile(file, script);
        const request: BoatRequest = {
          method: 'POST',
          path: `/sandboxes/${encodeId(sandboxId)}/commands`,
          body: { command: `bash ${file}; rc=$?; rm -f ${file}; exit $rc`, timeoutSeconds },
        };
        const body = await call(request);
        const result = decode(body, commandEnvelopeSchema, request).result ?? decode(body, commandResultSchema, request);
        return {
          exitCode: result.exitCode ?? null,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          timedOut: result.timedOut === true,
        };
      },
    };
  }

  return {
    name: 'boat',
    async verifyCredentials() {
      const request: BoatRequest = { method: 'GET', path: '/me', retry: true };
      const me = decode(await call(request), meSchema, request);
      const user = me.user ?? me;
      return { account: user.email ?? user.username ?? user.id ?? 'boat account' };
    },
    async listOrgs() {
      const request: BoatRequest = { method: 'GET', path: '/orgs', retry: true };
      const { orgs } = decode(await call(request), orgListSchema, request);
      return orgs.map((org) => ({
        ...(org.type === 'personal' ? PERSONAL_ORG : { id: org.id, name: org.name }),
        active: org.active === true,
      }));
    },
    async create(request: CreateSandboxRequest) {
      const body: CreateBody = { type: request.size, ttlSeconds: null, noEnv: true };
      const org = request.org ?? options.org;
      if (org) body.org = org;
      const createRequest: BoatRequest = {
        method: 'POST',
        path: '/sandboxes',
        body,
        headers: org ? { 'Idempotency-Key': request.idempotencyKey, 'X-Boat-Org': org } : { 'Idempotency-Key': request.idempotencyKey },
        retry: true,
      };
      const sandbox = decodeSandbox(await call(createRequest), createRequest);
      if (sandbox.name !== request.name) {
        try {
          await call({ method: 'PATCH', path: `/sandboxes/${encodeId(sandbox.id)}`, body: { name: request.name }, retry: true });
        } catch {
          // boat's create takes no name. Throwing here would lose a billed sandbox that no prefix match
          // finds again; return it under its real (empty) name so the caller records it by id first.
          return sandbox;
        }
      }
      return { ...sandbox, name: request.name };
    },
    get: (sandboxId) => getSandbox(sandboxId),
    getWithoutWallet: (sandboxId) => getSandbox(sandboxId, true),
    async list() {
      const sandboxes: CloudSandbox[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
        const request: BoatRequest = { method: 'GET', path: `/sandboxes${query}`, retry: true };
        const listed = decode(await call(request), sandboxListSchema, request);
        const items = listed.sandboxes ?? [];
        sandboxes.push(...items.map(toCloudSandbox));
        if (!listed.nextCursor || items.length === 0) break;
        cursor = listed.nextCursor;
      }
      return sandboxes;
    },
    async rename(sandboxId, name) {
      await call({ method: 'PATCH', path: `/sandboxes/${encodeId(sandboxId)}`, body: { name }, retry: true });
    },
    async stop(sandboxId) {
      await call({ method: 'POST', path: `/sandboxes/${encodeId(sandboxId)}/stop`, body: {} });
    },
    async resume(sandboxId) {
      await call({ method: 'POST', path: `/sandboxes/${encodeId(sandboxId)}/resume`, body: {} });
    },
    async destroy(sandboxId) {
      await call(
        {
          method: 'DELETE',
          path: `/sandboxes/${encodeId(sandboxId)}`,
          headers: { 'X-Ascii-Confirm-Delete': sandboxId },
        },
        [200, 202, 204, 404],
      );
    },
    handle,
  };
}

function toCloudState(providerState: string): CloudSandboxState {
  switch (providerState) {
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
    default:
      return 'error';
  }
}

function toCloudSandbox(record: BoatSandbox): CloudSandbox {
  const providerState = record.state ?? 'unknown';
  const sandbox: CloudSandbox = {
    id: record.id,
    name: record.name ?? '',
    state: toCloudState(providerState),
    providerState,
    size: CLOUD_SIZES.find((size) => size === record.type),
    error: record.error ?? null,
    createdAt: record.createdAt ?? null,
  };
  // `team` absent: boat did not say. null: the owner's personal wallet pays.
  if (record.team !== undefined) sandbox.org = record.team ? { id: record.team.id, name: record.team.name } : PERSONAL_ORG;
  return sandbox;
}

function goneSandbox(sandboxId: string): CloudSandbox {
  return { id: sandboxId, name: '', state: 'gone', providerState: 'not_found' };
}

function boatError(request: Pick<BoatRequest, 'method' | 'path'>, status: number, body: JsonValue | undefined): CloudProviderError {
  let code: string | undefined;
  let message = '';
  try {
    const decoded = decodeBoundary(body, errorSchema);
    code = decoded.code ?? decoded.error?.code;
    message = decoded.message ?? decoded.error?.message ?? '';
  } catch {
    // Error bodies are informational only.
  }
  return new CloudProviderError(
    `boat ${request.method} ${request.path.split('?')[0]} failed with HTTP ${status}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`,
    status,
    code,
  );
}

function parseJson(text: string): JsonValue | undefined {
  if (!text.trim()) return undefined;
  try {
    return decodeBoundary(JSON.parse(text), boundary.json);
  } catch {
    return undefined;
  }
}

function encodeId(sandboxId: string): string {
  return encodeURIComponent(sandboxId);
}
