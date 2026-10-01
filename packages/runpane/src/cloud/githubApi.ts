import { execFile, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { boundary, decodeBoundary, type BoundarySchema, type JsonObject, type JsonValue } from '../boundaryDecoder';
import { githubErrorMessage, githubJsonRequest, type FetchLike } from './githubTransport';
import type { GitHubTokenSource } from './store';

/**
 * The laptop side of `runpane cloud github|git`: GitHub's REST API with the user's own credential, and
 * the local git that pushes a Session's work. The credential stays on this machine: it is never written
 * into a sandbox, a remote URL, a command line or a log. `github.ts` holds the commands; tests fake this.
 */

export interface GitHubRepoInfo {
  /** owner/name as GitHub spells it. */
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** Whether this credential may add deploy keys (repository admin). */
  admin: boolean;
}

interface GitHubDeployKey {
  id: number;
  title: string;
  readOnly: boolean;
}

export interface GitHubApi {
  getRepo(repo: string): Promise<GitHubRepoInfo>;
  addDeployKey(repo: string, key: { title: string; key: string; readOnly: boolean }): Promise<GitHubDeployKey>;
  /** Resolves false when the key was already gone (404). */
  deleteDeployKey(repo: string, keyId: number): Promise<boolean>;
  /** null when the key does not exist (404). */
  getDeployKey(repo: string, keyId: number): Promise<GitHubDeployKey | null>;
  /** github.com's SSH host keys as known_hosts lines, from GET /meta (fetched over TLS). */
  sshKnownHosts(): Promise<string[]>;
}

export interface BundlePushRequest {
  /** owner/name */
  repo: string;
  token: string;
  /** Git bundle holding `bundleRef`; absent when GitHub already has every commit of `head`. */
  bundle?: Buffer;
  bundleRef: string;
  head: string;
  /** Commits the bundle builds on; GitHub has them, so they are fetched shallowly first. */
  prerequisites: string[];
  /** Full ref to create or update, e.g. refs/heads/cloud/rp-abc/feature. */
  targetRef: string;
  force: boolean;
}

/** git push --porcelain's flag for the ref: new, fast-forward, forced, or already there. */
export type BundlePushOutcome = 'created' | 'fast-forward' | 'forced' | 'up-to-date';

export interface GitHubPort {
  /** The laptop's credential: `--token-file`, else `gh auth token`. Never printed. */
  resolveToken(source: GitHubTokenSource): Promise<string>;
  api(token: string): GitHubApi;
  pushBundle(request: BundlePushRequest): Promise<BundlePushOutcome>;
}

const GITHUB_API = 'https://api.github.com';
const API_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10 * 60_000;

const repoSchema = boundary.object({
  full_name: boundary.nonEmptyString,
  private: boundary.boolean,
  default_branch: boundary.nonEmptyString,
  permissions: boundary.optional(boundary.object({ admin: boundary.optional(boundary.boolean) })),
});

const deployKeySchema = boundary.object({
  id: boundary.number,
  title: boundary.optional(boundary.string),
  read_only: boundary.optional(boundary.boolean),
});

const metaSchema = boundary.object({ ssh_keys: boundary.array(boundary.nonEmptyString) });

class GitHubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function createGitHubApi(token: string, fetchImpl: FetchLike = fetch): GitHubApi {
  async function request(method: 'GET' | 'POST' | 'DELETE', route: string, body?: JsonObject, okStatuses = [200, 201, 204]) {
    const response = await githubJsonRequest(fetchImpl, { method, url: `${GITHUB_API}${route}`, token, userAgent: 'runpane-cloud', body, timeoutMs: API_TIMEOUT_MS });
    if (!okStatuses.includes(response.status)) {
      const message = githubErrorMessage(response.body);
      throw new GitHubApiError(`GitHub ${method} ${route} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`, response.status);
    }
    return { status: response.status, body: response.body };
  }

  function decode<Value>(body: JsonValue | undefined, schema: BoundarySchema<Value>, route: string): Value {
    try {
      return decodeBoundary(body, schema);
    } catch (error) {
      throw new GitHubApiError(`GitHub ${route} returned an unexpected body: ${error instanceof Error ? error.message : 'unknown'}`, 0);
    }
  }

  const toKey = (key: ReturnType<typeof deployKeySchema.decode>): GitHubDeployKey => ({ id: key.id, title: key.title ?? '', readOnly: key.read_only !== false });

  return {
    async getRepo(repo) {
      const route = `/repos/${repo}`;
      const info = decode((await request('GET', route)).body, repoSchema, route);
      return { fullName: info.full_name, private: info.private, defaultBranch: info.default_branch, admin: info.permissions?.admin === true };
    },
    async addDeployKey(repo, key) {
      const route = `/repos/${repo}/keys`;
      const created = await request('POST', route, { title: key.title, key: key.key, read_only: key.readOnly });
      return toKey(decode(created.body, deployKeySchema, route));
    },
    async deleteDeployKey(repo, keyId) {
      const result = await request('DELETE', `/repos/${repo}/keys/${keyId}`, undefined, [204, 404]);
      return result.status === 204;
    },
    async getDeployKey(repo, keyId) {
      const route = `/repos/${repo}/keys/${keyId}`;
      const result = await request('GET', route, undefined, [200, 404]);
      return result.status === 404 ? null : toKey(decode(result.body, deployKeySchema, route));
    },
    async sshKnownHosts() {
      const meta = decode((await request('GET', '/meta')).body, metaSchema, '/meta');
      return meta.ssh_keys.map((key) => `github.com ${key}`);
    },
  };
}

const execFileAsync = promisify(execFile);

async function readTokenSource(source: GitHubTokenSource, readSecretFile: (file: string) => Promise<string>): Promise<string> {
  if (source.kind === 'file') return (await readSecretFile(source.path)).trim();
  if (source.kind === 'stdin') return (await readSecretFile('-')).trim();
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 15_000 });
    return stdout.trim();
  } catch {
    throw new Error('No GitHub credential: sign in with `gh auth login`, or pass --token-file <file> (a token that can manage the repository\'s deploy keys and push).');
  }
}

/**
 * Pushes `head` to `targetRef` from a throwaway bare repository: the commits GitHub already has are
 * fetched shallowly by id, the rest come from the bundle. The token reaches git only through the
 * environment of a credential helper, never argv or the remote URL.
 */
export async function pushBundle(request: BundlePushRequest, remoteBase = 'https://github.com'): Promise<BundlePushOutcome> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'runpane-cloud-push-'));
  const url = `${remoteBase}/${request.repo}.git`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    RUNPANE_CLOUD_GITHUB_TOKEN: request.token,
  };
  const git = async (args: string[]): Promise<string> => {
    const result = spawnSync('git', [
      '-c', 'credential.helper=',
      '-c', 'credential.helper=!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$RUNPANE_CLOUD_GITHUB_TOKEN"; }; f',
      ...args,
    ], { cwd: work, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(gitFailure(result.stderr || result.error?.message || `git ${args[0]} exited ${String(result.status)}`, request.token));
    }
    return result.stdout;
  };
  try {
    await git(['init', '-q', '--bare', '.']);
    if (request.prerequisites.length > 0) {
      await git(['fetch', '-q', '--depth=1', '--no-tags', '--no-write-fetch-head', url, ...request.prerequisites]);
    }
    if (request.bundle) {
      const bundlePath = path.join(work, 'session.bundle');
      await fs.writeFile(bundlePath, request.bundle, { mode: 0o600 });
      await git(['fetch', '-q', '--no-write-fetch-head', bundlePath, `${request.bundleRef}:refs/runpane/push`]);
      const fetched = (await git(['rev-parse', 'refs/runpane/push'])).trim();
      if (fetched !== request.head) throw new Error(`the bundle holds ${fetched}, expected ${request.head}`);
    } else if (!request.prerequisites.includes(request.head)) {
      throw new Error(`no bundle and ${request.head} is not among the commits to fetch`);
    }
    const out = await git(['push', '--porcelain', url, `${request.force ? '+' : ''}${request.head}:${request.targetRef}`]);
    const line = out.split('\n').find((candidate) => candidate.includes(`:${request.targetRef}`)) ?? '';
    switch (line[0]) {
      case '*': return 'created';
      case '+': return 'forced';
      case '=': return 'up-to-date';
      default: return 'fast-forward';
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** git's stderr, with the token scrubbed in case a helper or remote ever echoed it. */
function gitFailure(stderr: string, token: string): string {
  const message = stderr.trim().split(token).join('***');
  return `git push from this machine failed: ${message.split('\n').slice(-6).join(' ').trim()}`;
}

export function createGitHubPort(readSecretFile: (file: string) => Promise<string>): GitHubPort {
  return {
    async resolveToken(source) {
      const token = await readTokenSource(source, readSecretFile);
      if (!token) throw new Error('The GitHub token is empty.');
      return token;
    },
    api: (token) => createGitHubApi(token),
    pushBundle: (request) => pushBundle(request),
  };
}
