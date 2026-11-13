import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { CloudApiError } from '../errors';
import type { Route, RouteResponse } from '../http';

interface HandlerInput<T> {
  params: Record<string, string>;
  body: T extends Route<infer B, z.ZodType, z.ZodType> ? z.output<B> : never;
  query: T extends Route<z.ZodType, infer Q, z.ZodType> ? z.output<Q> : never;
  /** The bearer token, or null when the request carried none. */
  token: string | null;
}

type Handler<T> = (input: HandlerInput<T>) => RouteResponse<T> | Promise<RouteResponse<T>>;

export interface BoundRoute {
  route: Route;
  handle: Handler<Route>;
}

export function bind<T extends Route>(target: T, handle: Handler<T>): BoundRoute {
  // SAFETY: the server only calls handle with input parsed by target's own schemas.
  return { route: target, handle: handle as Handler<Route> };
}

const JsonBody = z.json();
type JsonBody = z.output<typeof JsonBody>;

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    const segment = want[i] ?? '';
    const actual = got[i] ?? '';
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual);
    else if (segment !== actual) return null;
  }
  return params;
}

async function readJson(request: IncomingMessage): Promise<JsonBody | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    // SAFETY: an IncomingMessage with no encoding set yields Buffer chunks.
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JsonBody.parse(JSON.parse(text));
  } catch {
    throw new CloudApiError('invalid_request', 'The request body is not JSON.', 'Send a JSON body.');
  }
}

function send(response: ServerResponse, status: number, json: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(json);
}

function check<S extends z.ZodType>(what: string, schema: S, value: JsonBody | undefined): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CloudApiError('invalid_request', `The ${what} does not match the contract: ${z.prettifyError(parsed.error)}`, 'Fix the request to match the contract and send it again.');
  }
  return parsed.data;
}

/**
 * An HTTP server for a list of bound routes. It checks each request against its route's schemas and
 * each handler's answer against the route's response schema, so a stub cannot drift from the contract.
 */
export function createRouteServer(routes: BoundRoute[]): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://stub');
      try {
        let matched: { bound: BoundRoute; params: Record<string, string> } | null = null;
        for (const bound of routes) {
          if (bound.route.method !== request.method) continue;
          const params = matchPath(bound.route.path, url.pathname);
          if (params) {
            matched = { bound, params };
            break;
          }
        }
        if (!matched) throw new CloudApiError('invalid_request', `No route for ${request.method} ${url.pathname}.`, 'Check the method and path against the contract.');
        const { route: target, handle } = matched.bound;
        const authorization = request.headers.authorization ?? '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
        if (target.auth && !token) throw new CloudApiError('unauthenticated', 'This call needs a signed-in account.', 'Sign in and send the token as a Bearer token.');
        const rawBody = await readJson(request);
        const body = target.body ? check('body', target.body, rawBody) : undefined;
        const query = target.query ? check('query', target.query, Object.fromEntries(url.searchParams)) : {};
        const result = await handle({ params: matched.params, body, query, token });
        const answer = target.response.safeParse(result);
        if (!answer.success) throw new Error(`stub answered ${target.id} outside the contract: ${z.prettifyError(answer.error)}`);
        send(response, target.status, JSON.stringify(answer.data));
      } catch (error) {
        const failure = error instanceof CloudApiError ? error : new CloudApiError('internal', error instanceof Error ? error.message : String(error), 'This is a stub bug; report it.');
        send(response, failure.status, JSON.stringify(failure.toBody()));
      }
    })();
  });
}

export interface RunningStub {
  url: string;
  close(): Promise<void>;
}

export async function listen(server: Server): Promise<RunningStub> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo, not a pipe name.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
