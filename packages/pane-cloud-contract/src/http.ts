import { z } from 'zod';
import { CloudApiError, ContractViolationError, ErrorBody } from './errors';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type NoQuery = z.ZodObject<Record<never, never>>;

/**
 * One endpoint of either API. `path` uses `:name` placeholders. The client and the stub servers both
 * read these, so a route's schemas are the contract for its request and its success response.
 */
export interface Route<B extends z.ZodType = z.ZodType, Q extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  /** Whether the request must carry `Authorization: Bearer <token>`. */
  readonly auth: boolean;
  readonly body: B | null;
  readonly query: Q | null;
  readonly response: R;
  /** The status of a success response. */
  readonly status: number;
}

export function route<R extends z.ZodType, B extends z.ZodType = z.ZodUndefined, Q extends z.ZodType = NoQuery>(definition: {
  id: string;
  method: HttpMethod;
  path: string;
  auth: boolean;
  body?: B;
  query?: Q;
  response: R;
  status?: number;
}): Route<B, Q, R> {
  return {
    id: definition.id,
    method: definition.method,
    path: definition.path,
    auth: definition.auth,
    body: definition.body ?? null,
    query: definition.query ?? null,
    response: definition.response,
    status: definition.status ?? 200,
  };
}

type RouteBody<T> = T extends Route<infer B, z.ZodType, z.ZodType> ? z.input<B> : never;
type RouteQuery<T> = T extends Route<z.ZodType, infer Q, z.ZodType> ? z.input<Q> : never;
export type RouteResponse<T> = T extends Route<z.ZodType, z.ZodType, infer R> ? z.output<R> : never;

export interface ClientConfig {
  baseUrl: string;
  /** Bearer token for routes that need a signed-in caller. */
  token?: string;
  fetch?: typeof fetch;
}

interface CallInput<T> {
  params?: Record<string, string>;
  body?: RouteBody<T>;
  query?: RouteQuery<T>;
}

const QueryValues = z.record(z.string(), z.union([z.string(), z.number(), z.undefined()]));

function fillPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${path}`);
    return encodeURIComponent(value);
  });
}

/**
 * Calls one route and returns its parsed response. Throws CloudApiError for an error the server
 * reported, and ContractViolationError for any response outside the contract.
 */
export async function callRoute<T extends Route>(config: ClientConfig, target: T, input: CallInput<T> = {}): Promise<RouteResponse<T>> {
  const url = new URL(config.baseUrl.replace(/\/$/, '') + fillPath(target.path, input.params));
  for (const [key, value] of Object.entries(QueryValues.parse(input.query ?? {}))) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const headers = new Headers({ accept: 'application/json' });
  if (config.token) headers.set('authorization', `Bearer ${config.token}`);
  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(input.body);
  }
  const response = await (config.fetch ?? fetch)(url, { method: target.method, headers, body });
  const text = await response.text();
  let json: z.output<ReturnType<typeof z.json>> | undefined;
  try {
    json = text === '' ? undefined : z.json().parse(JSON.parse(text));
  } catch {
    throw new ContractViolationError(target.id, `status ${response.status} with a body that is not JSON`);
  }
  if (response.status !== target.status) {
    const error = ErrorBody.safeParse(json);
    if (!error.success || response.status < 400) {
      throw new ContractViolationError(target.id, `unexpected status ${response.status}`);
    }
    const { code, message, next } = error.data.error;
    const thrown = new CloudApiError(code, message, next);
    if (thrown.status !== response.status) {
      throw new ContractViolationError(target.id, `error ${code} sent with status ${response.status}, not ${thrown.status}`);
    }
    throw thrown;
  }
  const parsed = target.response.safeParse(json);
  if (!parsed.success) throw new ContractViolationError(target.id, z.prettifyError(parsed.error));
  // SAFETY: target.response is the schema RouteResponse<T> is inferred from, and it just parsed the body.
  return parsed.data as RouteResponse<T>;
}
