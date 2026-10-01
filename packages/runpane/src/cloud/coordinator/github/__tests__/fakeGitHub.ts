import { execFileSync, spawn } from 'node:child_process';
import { createPublicKey, createVerify, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * A faithful stand-in for GitHub, for the broker's tests and its live proof without real GitHub.
 * Self-contained (node built-ins only) so it can also run on a box:
 *
 *   node fakeGitHub.js --root <dir> --port 8787 --app-id 42 --public-key app.pub.pem --repo owner/name
 *
 * - git: real smart HTTP from `git http-backend` over bare repositories, with GitHub's auth model
 *   (Basic `x-access-token:<token>`; fetch needs contents:read, push needs contents:write on that
 *   repository) and a pre-receive hook that, like GitHub for a token without the `workflows`
 *   permission, refuses commits that touch `.github/workflows/`.
 * - REST: the App endpoints (RS256 JWT verified against the App's public key; installation tokens
 *   that expire and are limited to the repositories and permissions asked for, 422 beyond the
 *   installation's), repos, pulls, issues, comments, labels, and the read endpoints the broker proxies.
 * - `GET /_fake/state` shows refs, pulls, issues, comments and every request, for assertions and evidence.
 */

type Level = 'read' | 'write';
type Permissions = Record<string, Level>;

interface TokenRecord {
  kind: 'installation' | 'pat';
  repos: string[] | null;
  permissions: Permissions;
  expiresAt: number;
}

interface PullRecord {
  number: number;
  title: string;
  body: string;
  head: string;
  headRepo: string;
  base: string;
  draft: boolean;
  state: 'open' | 'closed';
  merged: boolean;
}

interface IssueRecord {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
}

interface RepoRecord {
  fullName: string;
  dir: string;
  defaultBranch: string;
  labels: string[];
  pulls: PullRecord[];
  issues: IssueRecord[];
  comments: Array<{ id: number; issue: number; body: string }>;
  nextNumber: number;
}

export interface FakeRequestLog {
  method: string;
  path: string;
  auth: 'jwt' | 'installation' | 'pat' | 'none' | 'invalid';
  permissions?: Permissions;
  status: number;
}

/** The request fields the fake reads (the broker is its only client). */
interface RequestBody {
  repositories?: string[];
  permissions?: Permissions;
  title?: string;
  body?: string;
  head?: string;
  base?: string;
  draft?: boolean;
  labels?: string[];
  state?: 'open' | 'closed';
}

interface TokenLookup {
  kind: FakeRequestLog['auth'];
  record?: TokenRecord;
}

interface JwtHeader {
  alg?: string;
}

interface JwtClaims {
  iss?: string | number;
  iat?: number;
  exp?: number;
}

export interface FakeGitHubOptions {
  root: string;
  appId?: string;
  /** PEM of the App's public key; without it, App endpoints answer 401. */
  appPublicKey?: string;
  installationId?: number;
  /** What the installation was granted. */
  installationPermissions?: Permissions;
  /** Lifetime of installation tokens (GitHub: 1 h). */
  tokenTtlMs?: number;
  /** The installation's repository_selection: "selected" (default) or "all". */
  repositorySelection?: 'selected' | 'all';
  now?: () => number;
}

const DEFAULT_PERMISSIONS = { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } satisfies Permissions;

export class FakeGitHub {
  readonly repos = new Map<string, RepoRecord>();
  readonly tokens = new Map<string, TokenRecord>();
  readonly requests: FakeRequestLog[] = [];
  /** Every access_tokens request as sent (`requestedPermissions` null = the body had no permissions: all of the grant). */
  readonly minted: Array<{ repositories: string[] | null; requestedPermissions: Permissions | null; permissions: Permissions; expiresAt: string }> = [];
  /** The next REST call answers 403 "API rate limit exceeded" (GitHub's primary rate limit). */
  rateLimitNext = false;
  private server: http.Server | null = null;
  private readonly appKey: KeyObject | null;
  private readonly now: () => number;
  baseUrl = '';

  constructor(private readonly options: FakeGitHubOptions) {
    this.appKey = options.appPublicKey ? createPublicKey(options.appPublicKey) : null;
    this.now = options.now ?? (() => Date.now());
    fs.mkdirSync(options.root, { recursive: true });
  }

  get installationId(): number {
    return this.options.installationId ?? 4242;
  }

  get installationPermissions(): Permissions {
    return this.options.installationPermissions ?? DEFAULT_PERMISSIONS;
  }

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error: Error) => {
        if (!response.headersSent) this.json(response, 500, { message: error.message });
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(port, host, resolve));
    // SAFETY: a server listening on a TCP host and port reports an AddressInfo (not a pipe name).
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://${host}:${address.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** A fine-grained PAT for these repositories (the broker's PAT mode). */
  addPat(token: string, repos: string[], permissions: Permissions = DEFAULT_PERMISSIONS): void {
    this.tokens.set(token, { kind: 'pat', repos: repos.map((repo) => repo.toLowerCase()), permissions, expiresAt: Number.MAX_SAFE_INTEGER });
  }

  /** Commits `files` (path -> text; null deletes) onto `branch` (created from the default branch if new). */
  commitFiles(fullName: string, branch: string, files: ReadonlyMap<string, string | null>, message = 'update'): string {
    const repo = this.repos.get(fullName.toLowerCase());
    if (!repo) throw new Error(`no fake repo ${fullName}`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-commit-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: work, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    try {
      git(['init', '-q', '.']);
      git(['fetch', '-q', repo.dir, `+refs/heads/*:refs/remotes/origin/*`]);
      const exists = git(['branch', '-r', '--list', `origin/${branch}`]) !== '';
      git(['checkout', '-q', '-B', branch, `origin/${exists ? branch : repo.defaultBranch}`]);
      for (const [file, text] of files) {
        const target = path.join(work, file);
        if (text === null) fs.rmSync(target, { force: true });
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, text);
        }
      }
      git(['add', '-A']);
      git(['commit', '-q', '--allow-empty', '-m', message]);
      // The seed's workflow is already there; the hook only refuses new workflow changes.
      git(['push', '-q', repo.dir, `HEAD:refs/heads/${branch}`]);
      return git(['rev-parse', 'HEAD']);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** Creates a bare repository with one commit on the default branch (a README and a CI workflow). */
  createRepo(fullName: string, options: { defaultBranch?: string; labels?: string[] } = {}): RepoRecord {
    const [owner, name] = fullName.split('/');
    const dir = path.join(this.options.root, owner, `${name}.git`);
    const defaultBranch = options.defaultBranch ?? 'master';
    fs.mkdirSync(dir, { recursive: true });
    const git = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    git(['init', '-q', '--bare', `--initial-branch=${defaultBranch}`, '.']);
    git(['config', 'http.receivepack', 'true']);
    git(['config', 'uploadpack.allowFilter', 'true']);
    git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    git(['config', 'receive.denyDeletes', 'false']);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-seed-'));
    try {
      git(['init', '-q', `--initial-branch=${defaultBranch}`, '.'], work);
      fs.writeFileSync(path.join(work, 'README.md'), `# ${fullName}\n`);
      fs.mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(work, '.github', 'workflows', 'ci.yml'), 'on: push\njobs: {}\n');
      git(['add', '-A'], work);
      git(['commit', '-q', '-m', 'initial'], work);
      git(['push', '-q', dir, `HEAD:refs/heads/${defaultBranch}`], work);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    // Installed after the seed, which itself carries a workflow.
    fs.writeFileSync(path.join(dir, 'hooks', 'pre-receive'), PRE_RECEIVE_HOOK, { mode: 0o755 });
    const record: RepoRecord = { fullName, dir, defaultBranch, labels: options.labels ?? ['bug', 'runpane-cloud'], pulls: [], issues: [], comments: [], nextNumber: 1 };
    this.repos.set(fullName.toLowerCase(), record);
    return record;
  }

  /** `refs/heads/...` -> sha, straight from the bare repository. */
  refs(fullName: string): Record<string, string> {
    const repo = this.repos.get(fullName.toLowerCase());
    if (!repo) return {};
    const out = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: repo.dir, env: gitEnv() }).toString();
    return Object.fromEntries(out.split('\n').filter(Boolean).map((line) => {
      const [ref, sha] = line.split(' ');
      return [ref, sha];
    }));
  }

  // ---------------------------------------------------------------- dispatch

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    if (url.pathname === '/_fake/state') {
      this.json(response, 200, this.snapshot());
      return;
    }
    const gitMatch = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(url.pathname);
    if (gitMatch) {
      await this.git(request, response, `${gitMatch[1]}/${gitMatch[2]}`, gitMatch[3], url);
      return;
    }
    await this.rest(request, response, url);
  }

  private snapshot() {
    return {
      repos: [...this.repos.values()].map((repo) => ({
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        refs: this.refs(repo.fullName),
        pulls: repo.pulls,
        issues: repo.issues.map((issue) => ({ ...issue, bodyLength: issue.body.length, body: issue.body })),
        comments: repo.comments,
      })),
      minted: this.minted,
      requests: this.requests,
    };
  }

  private json<Body>(response: ServerResponse, status: number, body: Body): void {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private log(entry: FakeRequestLog): void {
    this.requests.push(entry);
  }

  // ---------------------------------------------------------------- auth

  private verifyJwt(token: string): boolean {
    if (!this.appKey) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [header, payload, signature] = parts;
    try {
      const head: JwtHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      const claims: JwtClaims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (head.alg !== 'RS256') return false;
      if (!createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(this.appKey, Buffer.from(signature, 'base64url'))) return false;
      const now = Math.floor(this.now() / 1000);
      if (String(claims.iss) !== String(this.options.appId ?? '')) return false;
      if (claims.exp === undefined || claims.iat === undefined || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) return false;
      // GitHub: exp at most 10 minutes after iat, and not expired; iat not in the future.
      if (claims.exp <= now || claims.exp - claims.iat > 600 || claims.iat > now + 60) return false;
      return true;
    } catch {
      return false;
    }
  }

  private tokenFor(raw: string | undefined): TokenLookup {
    if (!raw) return { kind: 'none' };
    if (raw.split('.').length === 3 && raw.startsWith('ey')) return { kind: this.verifyJwt(raw) ? 'jwt' : 'invalid' };
    const record = this.tokens.get(raw);
    if (!record || record.expiresAt <= this.now()) return { kind: 'invalid' };
    return { kind: record.kind, record };
  }

  private allows(record: TokenRecord | undefined, repo: string, permission: string, level: Level): boolean {
    if (!record) return false;
    if (record.repos && !record.repos.includes(repo.toLowerCase())) return false;
    if (permission === 'metadata') return true;
    const has = record.permissions[permission];
    return has === 'write' || (has === 'read' && level === 'read');
  }

  // ---------------------------------------------------------------- git smart HTTP

  private async git(request: IncomingMessage, response: ServerResponse, fullName: string, action: string, url: URL): Promise<void> {
    const repo = this.repos.get(fullName.toLowerCase());
    const service = action === 'info/refs' ? url.searchParams.get('service') : action;
    const header = request.headers.authorization ?? '';
    const basic = /^Basic\s+(.+)$/iu.exec(header);
    const password = basic ? Buffer.from(basic[1], 'base64').toString('utf8').split(':').slice(1).join(':') : undefined;
    const auth = this.tokenFor(password);
    const logPath = `${url.pathname}${url.search}`;
    if (!repo) {
      this.log({ method: request.method ?? 'GET', path: logPath, auth: auth.kind, status: 404 });
      response.writeHead(404).end('Repository not found.');
      return;
    }
    if (auth.kind === 'none') {
      this.log({ method: request.method ?? 'GET', path: logPath, auth: auth.kind, status: 401 });
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' }).end();
      return;
    }
    const level: Level = service === 'git-receive-pack' ? 'write' : 'read';
    if (!this.allows(auth.record, repo.fullName, 'contents', level)) {
      this.log({ method: request.method ?? 'GET', path: logPath, auth: auth.kind, permissions: auth.record?.permissions, status: 403 });
      response.writeHead(403).end(`Permission to ${repo.fullName}.git denied.`);
      return;
    }
    this.log({ method: request.method ?? 'GET', path: logPath, auth: auth.kind, permissions: auth.record?.permissions, status: 200 });
    const env: NodeJS.ProcessEnv = {
      ...gitEnv(),
      GIT_PROJECT_ROOT: this.options.root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      REQUEST_METHOD: request.method ?? 'GET',
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      REMOTE_USER: 'x-access-token',
      REMOTE_ADDR: '127.0.0.1',
      GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
      HTTP_CONTENT_ENCODING: String(request.headers['content-encoding'] ?? ''),
      FAKE_ALLOW_WORKFLOWS: auth.record?.permissions.workflows === 'write' ? '1' : '0',
    };
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    request.pipe(child.stdin);
    let headerBuffer = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        response.write(chunk);
        return;
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const separator = headerBuffer.indexOf('\r\n\r\n');
      const alt = headerBuffer.indexOf('\n\n');
      const end = separator >= 0 ? separator : alt;
      if (end < 0) return;
      const skip = separator >= 0 ? 4 : 2;
      const lines = headerBuffer.subarray(0, end).toString('utf8').split(/\r?\n/u);
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const index = line.indexOf(':');
        if (index < 0) continue;
        const name = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      headersDone = true;
      response.write(headerBuffer.subarray(end + skip));
    });
    child.stderr.on('data', () => undefined);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    if (!headersDone) response.writeHead(500);
    response.end();
  }

  // ---------------------------------------------------------------- REST

  private async readJson(request: IncomingMessage): Promise<RequestBody> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const parsed: RequestBody = text ? JSON.parse(text) : {};
    return parsed;
  }

  private async rest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? 'GET';
    const bearer = /^(?:Bearer|token)\s+(\S+)$/iu.exec(request.headers.authorization ?? '')?.[1];
    const auth = this.tokenFor(bearer);
    const route = url.pathname;
    const reply = <Body>(status: number, body: Body) => {
      this.log({ method, path: `${route}${url.search}`, auth: auth.kind, permissions: auth.record?.permissions, status });
      this.json(response, status, body);
    };
    if (auth.kind === 'none' || auth.kind === 'invalid') {
      reply(401, { message: 'Bad credentials' });
      return;
    }
    if (this.rateLimitNext) {
      this.rateLimitNext = false;
      this.log({ method, path: route, auth: auth.kind, status: 403 });
      response.writeHead(403, { 'Content-Type': 'application/json', 'x-ratelimit-remaining': '0' });
      response.end(JSON.stringify({ message: 'API rate limit exceeded for installation.' }));
      return;
    }
    const body = method === 'GET' ? {} : await this.readJson(request);

    // App-level endpoints: JWT only.
    if (route.startsWith('/app')) {
      if (auth.kind !== 'jwt') {
        reply(401, { message: 'A JSON web token could not be decoded' });
        return;
      }
      if (method === 'GET' && route === '/app') return reply(200, { id: Number(this.options.appId), slug: 'runpane-cloud-fake', name: 'runpane cloud (fake)' });
      const installation = { id: this.installationId, permissions: this.installationPermissions, repository_selection: this.options.repositorySelection ?? 'selected' };
      if (method === 'GET' && route === '/app/installations') return reply(200, [installation]);
      if (method === 'GET' && route === `/app/installations/${this.installationId}`) return reply(200, installation);
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(route);
      if (method === 'POST' && mint) {
        if (Number(mint[1]) !== this.installationId) return reply(404, { message: 'Not Found' });
        const requestedRepos = body.repositories ?? null;
        const requested = body.permissions ?? this.installationPermissions;
        for (const [name, level] of Object.entries(requested)) {
          const has = this.installationPermissions[name];
          if (!has || (level === 'write' && has !== 'write')) {
            return reply(422, { message: `The permissions requested are not granted to this installation.`, errors: [{ message: `${name}:${level}` }] });
          }
        }
        const installed = [...this.repos.values()];
        const repos = requestedRepos
          ? installed.filter((repo) => requestedRepos.some((name) => repo.fullName.split('/')[1].toLowerCase() === name.toLowerCase()))
          : installed;
        if (requestedRepos && repos.length !== requestedRepos.length) return reply(422, { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' });
        const token = `ghs_fake${randomBytes(18).toString('hex')}`;
        const expiresAt = this.now() + (this.options.tokenTtlMs ?? 3_600_000);
        this.tokens.set(token, {
          kind: 'installation',
          repos: requestedRepos ? repos.map((repo) => repo.fullName.toLowerCase()) : null,
          permissions: requested,
          expiresAt,
        });
        const expires = new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/u, 'Z');
        this.minted.push({ repositories: requestedRepos, requestedPermissions: body.permissions ?? null, permissions: requested, expiresAt: expires });
        return reply(201, { token, expires_at: expires, permissions: requested, repository_selection: requestedRepos ? 'selected' : 'all' });
      }
      return reply(404, { message: 'Not Found' });
    }

    if (method === 'GET' && route === '/installation/repositories') {
      if (auth.kind !== 'installation') return reply(403, { message: 'Resource not accessible by integration' });
      const repos = [...this.repos.values()].filter((repo) => !auth.record?.repos || auth.record.repos.includes(repo.fullName.toLowerCase()));
      return reply(200, { total_count: repos.length, repositories: repos.map((repo) => ({ full_name: repo.fullName })) });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/u.exec(route);
    if (!repoMatch) return reply(404, { message: 'Not Found' });
    const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
    const rest = repoMatch[3] ?? '';
    const repo = this.repos.get(fullName.toLowerCase());
    if (rest === '/installation' && method === 'GET') {
      if (auth.kind !== 'jwt') return reply(401, { message: 'A JSON web token could not be decoded' });
      return repo ? reply(200, { id: this.installationId, permissions: this.installationPermissions }) : reply(404, { message: 'Not Found' });
    }
    if (!repo || auth.kind === 'jwt' || !this.allows(auth.record, fullName, 'metadata', 'read')) return reply(404, { message: 'Not Found' });
    const need = (permission: string, level: Level): boolean => {
      if (this.allows(auth.record, fullName, permission, level)) return true;
      reply(403, { message: 'Resource not accessible by integration' });
      return false;
    };
    // GET /repos/:o/:r/contents/<path>?ref=: a file from the bare repository (default branch without ref).
    if (rest.startsWith('/contents/') && method === 'GET') {
      if (!need('contents', 'read')) return;
      const filePath = decodeURIComponent(rest.slice('/contents/'.length));
      const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
      const show = (spec: string): Buffer | null => {
        try {
          return execFileSync('git', ['cat-file', '-p', spec], { cwd: repo.dir, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
          return null;
        }
      };
      const content = show(`${ref}:${filePath}`);
      if (!content) return reply(404, { message: 'Not Found' });
      const sha = execFileSync('git', ['rev-parse', `${ref}:${filePath}`], { cwd: repo.dir, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      return reply(200, { type: 'file', path: filePath, sha, encoding: 'base64', content: content.toString('base64') });
    }
    // Like GitHub: creating or updating a PR reads its head and base refs, which needs contents:read.
    const refsReadable = (): boolean => {
      if (this.allows(auth.record, fullName, 'contents', 'read')) return true;
      reply(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'not all refs are readable' }], documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request' });
      return false;
    };
    const html = (kind: string, number: number) => `https://github.com/${repo.fullName}/${kind}/${number}`;
    const pullJson = (pull: PullRecord) => ({
      number: pull.number,
      html_url: html('pull', pull.number),
      state: pull.state,
      draft: pull.draft,
      merged: pull.merged,
      merged_at: pull.merged ? '2026-09-30T12:00:00Z' : null,
      title: pull.title,
      body: pull.body,
      head: { ref: pull.head, sha: this.refs(repo.fullName)[`refs/heads/${pull.head}`] ?? null, repo: { full_name: pull.headRepo } },
      base: { ref: pull.base },
    });
    const issueJson = (issue: IssueRecord) => ({ number: issue.number, html_url: html('issues', issue.number), state: issue.state, title: issue.title, body: issue.body, labels: issue.labels.map((name) => ({ name })) });
    const numbered = /^\/(pulls|issues)\/(\d+)(\/[a-z-]+)?$/u.exec(rest);

    if (rest === '' && method === 'GET') {
      return reply(200, { full_name: repo.fullName, default_branch: repo.defaultBranch, private: true, permissions: { admin: false, push: true, pull: true } });
    }
    if (rest.startsWith('/labels') && method === 'GET') {
      if (!need('issues', 'read')) return;
      return reply(200, repo.labels.map((name) => ({ name })));
    }
    if (rest === '/pulls' && method === 'POST') {
      if (!need('pull_requests', 'write') || !refsReadable()) return;
      const head = String(body.head ?? '');
      if (!this.refs(repo.fullName)[`refs/heads/${head}`]) return reply(422, { message: 'Validation Failed', errors: [{ message: `No commits between ${String(body.base)} and ${head}` }] });
      const pull: PullRecord = {
        number: repo.nextNumber++,
        title: String(body.title ?? ''),
        body: String(body.body ?? ''),
        head,
        headRepo: repo.fullName,
        base: String(body.base ?? repo.defaultBranch),
        draft: body.draft === true,
        state: 'open',
        merged: false,
      };
      repo.pulls.push(pull);
      return reply(201, pullJson(pull));
    }
    if (rest === '/pulls' && method === 'GET') {
      if (!need('pull_requests', 'read')) return;
      return reply(200, repo.pulls.map(pullJson));
    }
    if (rest === '/issues' && method === 'POST') {
      if (!need('issues', 'write')) return;
      const labels = body.labels ?? [];
      if (labels.some((label) => !repo.labels.includes(label))) return reply(422, { message: 'Validation Failed' });
      const issue: IssueRecord = { number: repo.nextNumber++, title: String(body.title ?? ''), body: String(body.body ?? ''), labels, state: 'open' };
      repo.issues.push(issue);
      return reply(201, issueJson(issue));
    }
    if (rest === '/issues' && method === 'GET') {
      if (!need('issues', 'read')) return;
      return reply(200, [...repo.issues.map(issueJson), ...repo.pulls.map((pull) => ({ ...pullJson(pull), pull_request: { url: html('pull', pull.number) } }))]);
    }
    if (numbered) {
      const [, kind, raw, sub = ''] = numbered;
      const n = Number(raw);
      const pull = repo.pulls.find((candidate) => candidate.number === n);
      const issue = repo.issues.find((candidate) => candidate.number === n);
      if (kind === 'pulls') {
        if (!pull) return reply(404, { message: 'Not Found' });
        if (sub === '/merge' && method === 'PUT') {
          if (!need('contents', 'write')) return;
          pull.merged = true;
          pull.state = 'closed';
          return reply(200, { merged: true });
        }
        if (sub === '' && method === 'GET') return need('pull_requests', 'read') ? reply(200, pullJson(pull)) : undefined;
        if (sub === '' && method === 'PATCH') {
          if (!need('pull_requests', 'write') || !refsReadable()) return;
          if (body.title !== undefined) pull.title = body.title;
          if (body.body !== undefined) pull.body = body.body;
          if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
          return reply(200, pullJson(pull));
        }
        if ((sub === '/files' || sub === '/reviews') && method === 'GET') return need('pull_requests', 'read') ? reply(200, []) : undefined;
        return reply(404, { message: 'Not Found' });
      }
      // /issues/:n covers pull requests too, as on GitHub.
      if (sub === '/comments' && method === 'POST') {
        if (!pull && !issue) return reply(404, { message: 'Not Found' });
        if (!this.allows(auth.record, fullName, 'issues', 'write') && !(pull && this.allows(auth.record, fullName, 'pull_requests', 'write'))) {
          return reply(403, { message: 'Resource not accessible by integration' });
        }
        const comment = { id: 9000 + repo.comments.length, issue: n, body: String(body.body ?? '') };
        repo.comments.push(comment);
        return reply(201, { id: comment.id, html_url: `${html(pull ? 'pull' : 'issues', n)}#issuecomment-${comment.id}` });
      }
      if (sub === '/comments' && method === 'GET') {
        if (!need('issues', 'read')) return;
        return reply(200, repo.comments.filter((comment) => comment.issue === n));
      }
      if (sub === '' && method === 'GET') {
        if (!need('issues', 'read')) return;
        if (issue) return reply(200, issueJson(issue));
        if (pull) return reply(200, { ...pullJson(pull), pull_request: { url: html('pull', n) } });
        return reply(404, { message: 'Not Found' });
      }
      if (sub === '' && method === 'PATCH') {
        if (!need('issues', 'write')) return;
        if (!issue) return reply(404, { message: 'Not Found' });
        if (body.title !== undefined) issue.title = body.title;
        if (body.body !== undefined) issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        return reply(200, issueJson(issue));
      }
      return reply(404, { message: 'Not Found' });
    }
    const commits = /^\/commits\/(.+)\/(status|check-runs)$/u.exec(rest);
    if (commits && method === 'GET') {
      if (!need(commits[2] === 'status' ? 'statuses' : 'checks', 'read')) return;
      return reply(200, commits[2] === 'status' ? { state: 'pending', statuses: [] } : { total_count: 0, check_runs: [] });
    }
    if (rest === '/actions/runs' && method === 'GET') {
      if (!need('actions', 'read')) return;
      return reply(200, { total_count: 0, workflow_runs: [] });
    }
    return reply(404, { message: 'Not Found' });
  }
}

/** Like GitHub for a token without `workflows`: refuse new commits that change .github/workflows/. */
const PRE_RECEIVE_HOOK = `#!/bin/sh
[ "$FAKE_ALLOW_WORKFLOWS" = "1" ] && exit 0
zero=0000000000000000000000000000000000000000
while read old new ref; do
  [ "$new" = "$zero" ] && continue
  if [ "$old" = "$zero" ]; then range="$new --not --all"; else range="$old..$new"; fi
  for c in $(git rev-list $range); do
    if git diff-tree --no-commit-id --name-only -r --root "$c" | grep -q '^\\.github/workflows/'; then
      echo "refusing to allow a GitHub App to create or update workflow without \\\`workflows\\\` permission" >&2
      exit 1
    fi
  done
done
exit 0
`;

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'fake',
    GIT_AUTHOR_EMAIL: 'fake@example.invalid',
    GIT_COMMITTER_NAME: 'fake',
    GIT_COMMITTER_EMAIL: 'fake@example.invalid',
  };
}

async function main(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = flag('--root') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fake-github-'));
  const publicKeyFile = flag('--public-key');
  const fake = new FakeGitHub({
    root,
    appId: flag('--app-id'),
    appPublicKey: publicKeyFile ? fs.readFileSync(publicKeyFile, 'utf8') : undefined,
  });
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--repo') fake.createRepo(argv[index + 1]);
  }
  const base = await fake.start(Number(flag('--port') ?? 8787), flag('--host') ?? '127.0.0.1');
  console.log(JSON.stringify({ apiBaseUrl: base, gitBaseUrl: base, root, repos: [...fake.repos.keys()] }));
}

// Run as a program (the live proof copies the compiled file to a box); tests import it instead.
if (/fakeGitHub\.js$/u.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
