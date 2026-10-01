import { boundary, decodeBoundary, type JsonValue } from '../boundaryDecoder';

/**
 * The one GitHub REST transport both GitHub clients share: the laptop's (`githubApi.ts`, the user's own
 * credential) and the coordinator's broker (`coordinator/github/rest.ts`, App or fine-grained token). Node's
 * stdlib only, because the coordinator is deployed as this package's dist with no node_modules. It sends
 * the auth and API-version headers and a JSON body, applies the timeout, and parses the reply as JSON when
 * it is JSON. Every HTTP status resolves: which statuses are success, and what a failure or rate limit
 * means, stays with each caller. A network failure rejects with fetch's own error.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchLike = (url: string, init: { method: string; headers: Headers; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

interface GitHubJsonRequest {
  method: string;
  /** Full URL: the API base plus the route. */
  url: string;
  token: string;
  userAgent: string;
  body?: JsonValue;
  timeoutMs?: number;
}

interface GitHubJsonResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** The parsed JSON reply; undefined when it was empty or not JSON. */
  body: JsonValue | undefined;
}

export async function githubJsonRequest(fetchImpl: FetchLike, request: GitHubJsonRequest): Promise<GitHubJsonResponse> {
  const headers = new Headers({
    Authorization: `Bearer ${request.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': request.userAgent,
  });
  if (request.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: JsonValue | undefined;
  try {
    body = text ? decodeBoundary(JSON.parse(text), boundary.json) : undefined;
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, body };
}

const errorBodySchema = boundary.object({
  message: boundary.string,
  errors: boundary.optional(boundary.array(boundary.json)),
});
const errorItemSchema = boundary.object({ message: boundary.optional(boundary.string) });

/** One entry of GitHub's `errors[]`: an object with a message, or (rarely) a bare string. */
function errorDetail(item: JsonValue): string {
  try {
    return decodeBoundary(item, errorItemSchema).message ?? '';
  } catch {
    return String(item);
  }
}

/** GitHub's `{message, errors[]}` error body as one line, or null when that is not what came back. */
export function githubErrorMessage(body: JsonValue | undefined): string | null {
  let decoded;
  try {
    decoded = decodeBoundary(body, errorBodySchema);
  } catch {
    return null;
  }
  const details = (decoded.errors ?? []).map(errorDetail).filter(Boolean);
  return details.length > 0 ? `${decoded.message} (${details.join('; ')})` : decoded.message;
}
