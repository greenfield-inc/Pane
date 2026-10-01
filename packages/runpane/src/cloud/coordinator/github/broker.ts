import { boundary, decodeBoundary } from '../../../boundaryDecoder';
import type { BoundarySchema, JsonObject, JsonValue } from '../../../boundaryDecoder';
import type { Caller } from '../callerAuth';
import type { Clock, DirectoryEntry, SessionDirectory } from '../types';
import type { GitHubAudit, GitHubAuditEntry } from './audit';
import { HourlyLimiter } from './audit';
import type { GitHubCredential, Permissions } from './credentials';
import type { GitPusher } from './gitPush';
import {
  BrokerError,
  carriesMarker,
  cleanTitle,
  inNamespace,
  isSha,
  namespacedBranch,
  namespaceOf,
  parseReadPath,
  requireAllowedRepo,
  sessionHost,
  validBranchName,
  withFooter,
} from './policy';
import type { GitHubRest } from './rest';
import { nodeMismatch } from './whois';
import type { TailnetNode, WhoisResolver } from './whois';

/**
 * The coordinator's GitHub broker: cloud Sessions push branches and open
 * PRs, issues and comments through it, with the user's GitHub App or fine-grained PAT, which never
 * leaves the coordinator. It is an allowlist: a Session writes only branches under its own
 * `cloud/<host>/`, only in the repos its directory entry names, and never the default branch,
 * tags, deletes, workflow files, merges or reviews.
 */

interface BrokerLimits {
  pushesPerSessionPerHour: number;
  writesPerSessionPerHour: number;
  readsPerSessionPerHour: number;
  writesPerHour: number;
}

interface BrokerSettings {
  mode: 'app' | 'pat';
  apiBaseUrl: string;
  gitBaseUrl: string;
  allowReadyPulls: boolean;
  limits: BrokerLimits;
}

interface GitHubBrokerDeps {
  /** null: no `github` config, the broker is off. */
  settings: BrokerSettings | null;
  /** null with `credentialError`: configured, but the credential could not be loaded. */
  credential: GitHubCredential | null;
  credentialError: string | null;
  rest: GitHubRest;
  git: GitPusher;
  directory: SessionDirectory;
  whois: WhoisResolver;
  audit: GitHubAudit;
  clock: Clock;
  log?: (line: string) => void;
}

interface BrokerCall {
  method: string;
  /** The path after `/cloud/github/`, e.g. `pulls/12`. */
  path: string;
  query: URLSearchParams;
  caller: Caller;
  remoteAddress: string;
  readBody(limitBytes: number): Promise<JsonValue>;
}

/** A repository file's text and its blob sha (which changes whenever the file does). */
export interface RepoFile {
  text: string;
  sha: string;
}

interface BrokerAnswer {
  status: number;
  body: JsonObject;
}

/**
 * Creating or updating a pull request makes GitHub read its head and base refs: with only
 * pull_requests:write it answers 422 "not all refs are readable" (seen live).
 */
const PULL_WRITE = { pull_requests: 'write', contents: 'read' } as const satisfies Permissions;

/** 50 MiB of bundle, base64-encoded, plus the JSON around it. */
const PUSH_BODY_LIMIT = 72 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const BODY_LIMIT = 1024 * 1024;
const MAX_TEXT = 60_000;
const REPO_INFO_CACHE_MS = 5 * 60_000;

const pushSchema = boundary.object({
  repo: boundary.nonEmptyString,
  branch: boundary.nonEmptyString,
  bundle: boundary.optional(boundary.nullable(boundary.string)),
  sha: boundary.optional(boundary.nullable(boundary.string)),
  force: boundary.optional(boundary.boolean),
});
const repoSchema = boundary.object({ repo: boundary.nonEmptyString });
const pullCreateSchema = boundary.object({
  repo: boundary.nonEmptyString,
  branch: boundary.nonEmptyString,
  base: boundary.optional(boundary.nullable(boundary.string)),
  title: boundary.nonEmptyString,
  body: boundary.optional(boundary.nullable(boundary.string)),
  draft: boundary.optional(boundary.boolean),
});
const editSchema = boundary.object({
  repo: boundary.nonEmptyString,
  title: boundary.optional(boundary.string),
  body: boundary.optional(boundary.string),
  state: boundary.optional(boundary.enumeration('open', 'closed')),
});
const issueCreateSchema = boundary.object({
  repo: boundary.nonEmptyString,
  title: boundary.nonEmptyString,
  body: boundary.optional(boundary.nullable(boundary.string)),
  labels: boundary.optional(boundary.array(boundary.nonEmptyString)),
});
const commentSchema = boundary.object({
  repo: boundary.nonEmptyString,
  number: boundary.number,
  body: boundary.nonEmptyString,
});

const githubRepoSchema = boundary.object({ default_branch: boundary.nonEmptyString, full_name: boundary.nonEmptyString });
const githubPullSchema = boundary.object({
  number: boundary.number,
  html_url: boundary.optional(boundary.string),
  state: boundary.optional(boundary.string),
  draft: boundary.optional(boundary.boolean),
  head: boundary.object({
    ref: boundary.string,
    repo: boundary.optional(boundary.nullable(boundary.object({ full_name: boundary.string }))),
  }),
  base: boundary.object({ ref: boundary.string }),
});
const githubIssueSchema = boundary.object({
  number: boundary.number,
  html_url: boundary.optional(boundary.string),
  state: boundary.optional(boundary.string),
  body: boundary.optional(boundary.nullable(boundary.string)),
  pull_request: boundary.optional(boundary.json),
  labels: boundary.optional(boundary.array(boundary.union(boundary.string, boundary.object({ name: boundary.optional(boundary.string) })))),
});
const githubCommentSchema = boundary.object({ id: boundary.number, html_url: boundary.optional(boundary.string) });
const githubContentSchema = boundary.object({
  type: boundary.string,
  sha: boundary.nonEmptyString,
  encoding: boundary.optional(boundary.nullable(boundary.string)),
  content: boundary.optional(boundary.nullable(boundary.string)),
});
const githubLabelsSchema = boundary.array(boundary.object({ name: boundary.string }));

type Kind = 'push' | 'write' | 'read' | 'free';

interface EnabledBroker {
  settings: BrokerSettings;
  credential: GitHubCredential;
}

interface Route {
  endpoint: string;
  kind: Kind;
  users: boolean;
  run(context: CallContext): Promise<JsonObject>;
}

interface CallContext {
  call: BrokerCall;
  entry: DirectoryEntry;
  node: TailnetNode;
  credential: GitHubCredential;
  settings: BrokerSettings;
  audit: Partial<GitHubAuditEntry>;
}

function decodeBody<Value>(value: JsonValue, schema: BoundarySchema<Value>): Value {
  try {
    return decodeBoundary(value, schema);
  } catch (cause) {
    throw new BrokerError('bad-request', cause instanceof Error ? cause.message : String(cause));
  }
}

/** PATCH bodies are checked key by key, so `draft`, `base` or `merged` get a clear refusal. */
function onlyKeys(raw: JsonValue, allowed: readonly string[]): void {
  const value = decodeBody(raw, boundary.jsonObject);
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new BrokerError('forbidden', `the broker does not allow changing ${extra.join(', ')}`);
}

function text(value: string | null | undefined, what: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value.length > MAX_TEXT) throw new BrokerError('bad-request', `${what} is longer than ${MAX_TEXT} characters`);
  return value;
}

function number(raw: string): number {
  if (!/^\d{1,9}$/u.test(raw)) throw new BrokerError('bad-request', 'expected an issue or pull request number');
  return Number(raw);
}

export class GitHubBroker {
  private readonly limiter: HourlyLimiter;
  private readonly repoInfo = new Map<string, { at: number; defaultBranch: string }>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: GitHubBrokerDeps) {
    this.limiter = new HourlyLimiter(deps.clock);
    this.log = deps.log ?? ((line) => console.log(line));
  }

  get enabled(): boolean {
    return this.deps.settings !== null;
  }

  async handle(call: BrokerCall): Promise<BrokerAnswer> {
    const started = this.deps.clock.now();
    const audit: Partial<GitHubAuditEntry> = {};
    let entry: DirectoryEntry | null = null;
    let node: TailnetNode | null = null;
    let endpoint = `${call.method} ${call.path.split('/')[0] || '(none)'}`;
    try {
      // Peers are bound to their node before anything else, unknown endpoints included.
      if (call.caller.role === 'peer') {
        entry = await this.entryFor(call.caller.id);
        node = await this.bindNode(entry, call.remoteAddress);
      }
      const route = this.route(call);
      endpoint = route.endpoint;
      if (call.caller.role === 'user' && !route.users) {
        throw new BrokerError('forbidden', `${route.endpoint} is only for cloud Sessions (peer callers)`);
      }
      if (route.endpoint === 'GET status') return { status: 200, body: await this.status(entry) };
      if (route.endpoint === 'GET audit') {
        // The audit covers every Session's calls: only the user reads it, never a Session.
        if (call.caller.role !== 'user') throw new BrokerError('forbidden', 'the audit is only for the user (runpane cloud coordinator github audit)');
        const limit = Number(call.query.get('limit') ?? '100');
        return { status: 200, body: { ok: true, entries: this.deps.audit.recent(Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100) } };
      }
      const { settings, credential } = this.requireEnabled();
      if (!entry || !node) throw new BrokerError('forbidden', 'only cloud Sessions may call this endpoint');
      this.rateLimit(route.kind, entry.sessionId);
      const body = await route.run({ call, entry, node, credential, settings, audit });
      this.record(call, entry, node, endpoint, audit, 'ok', 200, started);
      return { status: 200, body };
    } catch (error) {
      const failure = error instanceof BrokerError ? error : new BrokerError('github-error', error instanceof Error ? error.message : String(error));
      if (endpoint !== 'GET status' && endpoint !== 'GET audit') {
        this.record(call, entry, node, endpoint, { ...audit, githubStatus: failure.github?.status ?? null }, failure.code, failure.status, started);
      }
      const body: JsonObject = { ok: false, code: failure.code, message: failure.message };
      if (failure.github) {
        body.githubStatus = failure.github.status;
        body.githubMessage = failure.github.message;
      }
      return { status: failure.status, body };
    }
  }

  /**
   * One file of `repo` at `ref` (the default branch when null), read with a contents:read token for the
   * coordinator's own use (the secrets manifest). Null when GitHub has no such file or ref. It never
   * goes through a Session's allowlist: callers decide which repo and ref a Session is tied to.
   */
  async readRepoFile(repo: string, filePath: string, ref: string | null): Promise<RepoFile | null> {
    const { credential } = this.requireEnabled();
    const token = (await credential.token(repo, { contents: 'read' })).token;
    const route = `/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
    let answer;
    try {
      answer = await this.deps.rest.request('GET', route, token);
    } catch (error) {
      if (error instanceof BrokerError && error.github?.status === 404) return null;
      throw error;
    }
    const file = decodeGitHubBody(answer.body, githubContentSchema, 'file');
    if (file.type !== 'file' || file.encoding !== 'base64') throw new BrokerError('github-error', `${repo}:${filePath} is not a regular file`, { status: 200, message: 'not a file' });
    return { text: Buffer.from(file.content ?? '', 'base64').toString('utf8'), sha: file.sha };
  }

  // ------------------------------------------------------------ routing and caller binding

  private route(call: BrokerCall): Route {
    const [head, ...rest] = call.path.split('/');
    const method = call.method.toUpperCase();
    const one = rest.length === 1 ? rest[0] : null;
    if (method === 'GET' && head === 'status' && rest.length === 0) return { endpoint: 'GET status', kind: 'free', users: true, run: async () => ({}) };
    if (method === 'GET' && head === 'audit' && rest.length === 0) return { endpoint: 'GET audit', kind: 'free', users: true, run: async () => ({}) };
    if (method === 'POST' && head === 'token' && rest.length === 0) return { endpoint: 'POST token', kind: 'read', users: false, run: (context) => this.readToken(context) };
    if (method === 'POST' && head === 'push' && rest.length === 0) return { endpoint: 'POST push', kind: 'push', users: false, run: (context) => this.push(context) };
    if (method === 'POST' && head === 'pulls' && rest.length === 0) return { endpoint: 'POST pulls', kind: 'write', users: false, run: (context) => this.createPull(context) };
    if (method === 'PATCH' && head === 'pulls' && one) return { endpoint: 'PATCH pulls/:n', kind: 'write', users: false, run: (context) => this.editPull(context, number(one)) };
    if (method === 'POST' && head === 'issues' && rest.length === 0) return { endpoint: 'POST issues', kind: 'write', users: false, run: (context) => this.createIssue(context) };
    if (method === 'PATCH' && head === 'issues' && one) return { endpoint: 'PATCH issues/:n', kind: 'write', users: false, run: (context) => this.editIssue(context, number(one)) };
    if (method === 'POST' && head === 'comments' && rest.length === 0) return { endpoint: 'POST comments', kind: 'write', users: false, run: (context) => this.comment(context) };
    if (method === 'GET' && head === 'read' && rest.length > 0) return { endpoint: 'GET read', kind: 'read', users: false, run: (context) => this.read(context, rest.join('/')) };
    throw new BrokerError('not-found', `no broker endpoint ${method} /cloud/github/${call.path} (the broker is an allowlist)`);
  }

  private async entryFor(sessionId: string): Promise<DirectoryEntry> {
    const directory = await this.deps.directory.read();
    const entry = directory.ok ? directory.entries.find((candidate) => candidate.sessionId === sessionId) : undefined;
    if (!entry) throw new BrokerError('forbidden', `caller ${sessionId} is not a cloud Session in the directory`);
    return entry;
  }

  /** The peer token alone is not enough: the request must come from that Session's own tailnet node. */
  private async bindNode(entry: DirectoryEntry, remoteAddress: string): Promise<TailnetNode> {
    const node = await this.deps.whois.whois(remoteAddress);
    const mismatch = nodeMismatch(entry, node, remoteAddress);
    if (mismatch || !node) {
      this.log(`[coordinator] github: refused ${entry.sessionId} from ${remoteAddress}: ${mismatch ?? 'no node'}`);
      throw new BrokerError('caller-node-mismatch', `this token belongs to ${entry.label}, but ${mismatch ?? 'no node'}`);
    }
    return node;
  }

  private requireEnabled(): EnabledBroker {
    const { settings, credential, credentialError } = this.deps;
    if (!settings) throw new BrokerError('github-disabled', 'the GitHub broker is off: run runpane cloud coordinator github set on your machine');
    if (!credential) throw new BrokerError('github-disabled', `the GitHub broker's credential could not be loaded: ${credentialError ?? 'unknown error'}`);
    return { settings, credential };
  }

  private rateLimit(kind: Kind, sessionId: string): void {
    const limits = this.deps.settings?.limits;
    if (!limits || kind === 'free') return;
    const keys = kind === 'read'
      ? [{ key: `read:${sessionId}`, limit: limits.readsPerSessionPerHour }]
      : [
          kind === 'push'
            ? { key: `push:${sessionId}`, limit: limits.pushesPerSessionPerHour }
            : { key: `write:${sessionId}`, limit: limits.writesPerSessionPerHour },
          { key: 'write:*', limit: limits.writesPerHour },
        ];
    const hit = this.limiter.take(keys);
    if (hit) {
      throw new BrokerError('broker-rate-limited', hit === 'write:*'
        ? `all Sessions together reached ${limits.writesPerHour} GitHub writes this hour`
        : `this Session reached its hourly limit of ${hit.startsWith('push:') ? `${limits.pushesPerSessionPerHour} pushes` : hit.startsWith('read:') ? `${limits.readsPerSessionPerHour} reads` : `${limits.writesPerSessionPerHour} writes`}`);
    }
  }

  private record(call: BrokerCall, entry: DirectoryEntry | null, node: TailnetNode | null, endpoint: string, audit: Partial<GitHubAuditEntry>, outcome: string, httpStatus: number, started: number): void {
    this.deps.audit.append({
      callerId: call.caller.id,
      label: entry?.label ?? null,
      node: node ? `${node.name} ${node.stableId}` : call.remoteAddress,
      endpoint,
      repo: audit.repo ?? null,
      target: audit.target ?? null,
      outcome,
      httpStatus,
      githubId: audit.githubId ?? null,
      githubUrl: audit.githubUrl ?? null,
      githubStatus: audit.githubStatus ?? null,
      bundleSha: audit.bundleSha ?? null,
      bundleBytes: audit.bundleBytes ?? null,
      titleLength: audit.titleLength ?? null,
      bodyLength: audit.bodyLength ?? null,
      durationMs: this.deps.clock.now() - started,
    });
  }

  // ------------------------------------------------------------ status

  private async status(entry: DirectoryEntry | null): Promise<JsonObject> {
    const { settings, credential, credentialError } = this.deps;
    const caller = entry
      ? { sessionId: entry.sessionId, host: sessionHost(entry), namespace: namespaceOf(entry), repos: entry.githubRepos }
      : null;
    if (!settings) return { ok: true, mode: 'off', app: null, repos: [], allowReadyPulls: false, tokens: [], caller };
    const base: JsonObject = {
      ok: true,
      mode: settings.mode,
      app: null,
      repos: [],
      allowReadyPulls: settings.allowReadyPulls,
      tokens: (credential?.cachedTokens() ?? []).map((token) => ({ repo: token.repo, access: token.access, permissions: token.permissions, expiresAt: token.expiresAt })),
      limits: {
        pushesPerSessionPerHour: settings.limits.pushesPerSessionPerHour,
        writesPerSessionPerHour: settings.limits.writesPerSessionPerHour,
        readsPerSessionPerHour: settings.limits.readsPerSessionPerHour,
        writesPerHour: settings.limits.writesPerHour,
      },
      caller,
    };
    if (!credential) return { ...base, error: credentialError ?? 'credential not loaded' };
    try {
      const described = await credential.describe();
      return {
        ...base,
        app: described.app
          ? {
              id: described.app.id,
              slug: described.app.slug,
              installationIds: described.app.installationIds,
              // Grants beyond what the broker uses are reported, never used: every token is capped.
              installations: described.app.installations.map((installation) => ({
                id: installation.id,
                repositorySelection: installation.repositorySelection,
                extraPermissions: installation.extra,
                missingPermissions: installation.missing,
                forbiddenPermissions: installation.forbidden,
              })),
            }
          : null,
        repos: described.repos ?? (entry ? entry.githubRepos : []),
      };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ------------------------------------------------------------ helpers

  private async token(context: CallContext, repo: string, permissions: Permissions): Promise<string> {
    return (await context.credential.token(repo, permissions)).token;
  }

  private async defaultBranch(context: CallContext, repo: string): Promise<string> {
    const cached = this.repoInfo.get(repo.toLowerCase());
    if (cached && this.deps.clock.now() - cached.at < REPO_INFO_CACHE_MS) return cached.defaultBranch;
    const token = await this.token(context, repo, { metadata: 'read' });
    const info = decodeGitHubBody((await this.deps.rest.request('GET', `/repos/${repo}`, token)).body, githubRepoSchema, 'repository');
    this.repoInfo.set(repo.toLowerCase(), { at: this.deps.clock.now(), defaultBranch: info.default_branch });
    return info.default_branch;
  }

  /** Audits what was asked for (also when refused), then checks it against the Session's allowlist. */
  private allowedRepo(context: CallContext, repo: string): string {
    context.audit.repo = repo.slice(0, 140);
    const allowed = requireAllowedRepo(context.entry, repo);
    context.audit.repo = allowed;
    return allowed;
  }

  // ------------------------------------------------------------ endpoints

  private async readToken(context: CallContext): Promise<JsonObject> {
    const body = decodeBody(await context.call.readBody(BODY_LIMIT), repoSchema);
    const repo = this.allowedRepo(context, body.repo);
    if (context.credential.mode !== 'app') {
      throw new BrokerError('read-token-unsupported', 'a PAT cannot be narrowed to read-only; this Session fetches with its deploy key');
    }
    const minted = await context.credential.token(repo, { contents: 'read', metadata: 'read' });
    context.audit.target = 'contents:read';
    return { ok: true, repo, token: minted.token, expiresAt: minted.expiresAt, permissions: { contents: 'read', metadata: 'read' } };
  }

  private async push(context: CallContext): Promise<JsonObject> {
    const body = decodeBody(await context.call.readBody(PUSH_BODY_LIMIT), pushSchema);
    const repo = this.allowedRepo(context, body.repo);
    context.audit.target = body.branch.slice(0, 140);
    const branch = namespacedBranch(context.entry, body.branch);
    context.audit.target = branch;
    const sha = body.sha ?? null;
    if (sha !== null && !isSha(sha)) throw new BrokerError('bad-request', 'sha must be 40 lowercase hex characters');
    let bundle: Buffer | null = null;
    if (body.bundle) {
      if (!/^[A-Za-z0-9+/=\s]+$/u.test(body.bundle)) throw new BrokerError('bad-request', 'bundle must be base64');
      bundle = Buffer.from(body.bundle, 'base64');
      if (bundle.length > MAX_BUNDLE_BYTES) throw new BrokerError('too-large', `the bundle is larger than ${MAX_BUNDLE_BYTES / 1024 / 1024} MiB`);
      context.audit.bundleBytes = bundle.length;
    } else if (sha === null) {
      throw new BrokerError('bad-request', 'push needs a bundle, or the sha of a commit GitHub already has');
    }
    const defaultBranch = await this.defaultBranch(context, repo);
    const short = branch.slice(namespaceOf(context.entry).length);
    if (branch === defaultBranch || [defaultBranch, 'main', 'master'].includes(short)) {
      // cloud/<host>/master would be harmless, but "push master" must never look like it worked.
      throw new BrokerError('ref-outside-namespace', `${short} is ${short === defaultBranch ? 'the default branch' : 'reserved'}; push a feature branch (it lands as ${namespaceOf(context.entry)}<branch>)`);
    }
    const token = await this.token(context, repo, { contents: 'write' });
    const result = await this.deps.git.push({
      repo,
      remoteUrl: `${context.settings.gitBaseUrl.replace(/\/+$/u, '')}/${repo}.git`,
      token,
      defaultBranch,
      bundle,
      sha,
      targetRef: `refs/heads/${branch}`,
      force: body.force === true,
    });
    context.audit.bundleSha = result.sha;
    const compareUrl = `${githubWebBase(context.settings)}/${repo}/compare/${encodeURIComponent(defaultBranch)}...${branch.split('/').map(encodeURIComponent).join('/')}`;
    this.log(`[coordinator] github: ${context.entry.label} pushed ${result.sha.slice(0, 12)} to ${repo} ${branch} (${result.outcome})`);
    return { ok: true, repo, branch, ref: `refs/heads/${branch}`, sha: result.sha, compareUrl, outcome: result.outcome, mergeBase: result.mergeBase, changedFiles: result.changedFiles };
  }

  private async createPull(context: CallContext): Promise<JsonObject> {
    const body = decodeBody(await context.call.readBody(BODY_LIMIT), pullCreateSchema);
    const repo = this.allowedRepo(context, body.repo);
    context.audit.target = body.branch.slice(0, 140);
    const head = namespacedBranch(context.entry, body.branch);
    const base = body.base ?? await this.defaultBranch(context, repo);
    if (!validBranchName(base)) throw new BrokerError('bad-request', 'base is not a valid branch name');
    const title = cleanTitle(body.title);
    const draft = context.settings.allowReadyPulls ? (body.draft ?? true) : true;
    context.audit.target = head;
    context.audit.titleLength = title.length;
    context.audit.bodyLength = body.body?.length ?? 0;
    const token = await this.token(context, repo, PULL_WRITE);
    const created = decodeGitHubBody((await this.deps.rest.request('POST', `/repos/${repo}/pulls`, token, {
      title,
      head,
      base,
      body: withFooter(text(body.body, 'body'), context.entry),
      draft,
    })).body, githubPullSchema, 'pull request');
    context.audit.githubId = created.number;
    context.audit.githubUrl = created.html_url ?? null;
    return { ok: true, number: created.number, url: created.html_url ?? null, draft: created.draft ?? draft, state: created.state ?? 'open', head: created.head.ref, base: created.base.ref };
  }

  private async editPull(context: CallContext, pullNumber: number): Promise<JsonObject> {
    const raw = await context.call.readBody(BODY_LIMIT);
    onlyKeys(raw, ['repo', 'title', 'body', 'state']);
    const body = decodeBody(raw, editSchema);
    const repo = this.allowedRepo(context, body.repo);
    context.audit.target = `#${pullNumber}`;
    const token = await this.token(context, repo, PULL_WRITE);
    const current = decodeGitHubBody((await this.deps.rest.request('GET', `/repos/${repo}/pulls/${pullNumber}`, token)).body, githubPullSchema, 'pull request');
    const headRepo = current.head.repo?.full_name.toLowerCase() ?? null;
    if (headRepo !== repo.toLowerCase() || !inNamespace(context.entry, current.head.ref)) {
      throw new BrokerError('not-owner', `pull request #${pullNumber} is not from this Session's ${namespaceOf(context.entry)} branches`);
    }
    const patch = this.editPatch(context, body);
    const updated = decodeGitHubBody((await this.deps.rest.request('PATCH', `/repos/${repo}/pulls/${pullNumber}`, token, patch)).body, githubPullSchema, 'pull request');
    context.audit.githubId = updated.number;
    context.audit.githubUrl = updated.html_url ?? null;
    return { ok: true, number: updated.number, url: updated.html_url ?? null, state: updated.state ?? null, draft: updated.draft ?? null };
  }

  /** The fields a PATCH may change, with the caller's footer kept on a new body. */
  private editPatch(context: CallContext, body: { title?: string; body?: string; state?: 'open' | 'closed' }): JsonObject {
    const title = body.title === undefined ? undefined : cleanTitle(body.title);
    const patch: JsonObject = {};
    if (title !== undefined) patch.title = title;
    if (body.body !== undefined) patch.body = withFooter(text(body.body, 'body'), context.entry);
    if (body.state !== undefined) patch.state = body.state;
    if (Object.keys(patch).length === 0) throw new BrokerError('bad-request', 'nothing to change (title, body or state)');
    context.audit.titleLength = title?.length ?? null;
    context.audit.bodyLength = body.body?.length ?? null;
    return patch;
  }

  private async createIssue(context: CallContext): Promise<JsonObject> {
    const body = decodeBody(await context.call.readBody(BODY_LIMIT), issueCreateSchema);
    const repo = this.allowedRepo(context, body.repo);
    const title = cleanTitle(body.title);
    context.audit.titleLength = title.length;
    context.audit.bodyLength = body.body?.length ?? 0;
    const token = await this.token(context, repo, { issues: 'write' });
    const requested = body.labels ?? [];
    let applied: string[] = [];
    let dropped: string[] = [];
    if (requested.length > 0) {
      // Labels must already exist: a Session never creates labels.
      const existing = decodeGitHubBody((await this.deps.rest.request('GET', `/repos/${repo}/labels?per_page=100`, token)).body, githubLabelsSchema, 'labels').map((label) => label.name);
      const byLower = new Map(existing.map((name) => [name.toLowerCase(), name]));
      applied = [...new Set(requested.map((name) => byLower.get(name.toLowerCase())).filter((name): name is string => name !== undefined))];
      dropped = requested.filter((name) => !byLower.has(name.toLowerCase()));
    }
    const payload: JsonObject = { title, body: withFooter(text(body.body, 'body'), context.entry) };
    if (applied.length > 0) payload.labels = applied;
    const created = decodeGitHubBody((await this.deps.rest.request('POST', `/repos/${repo}/issues`, token, payload)).body, githubIssueSchema, 'issue');
    context.audit.target = `#${created.number}`;
    context.audit.githubId = created.number;
    context.audit.githubUrl = created.html_url ?? null;
    return { ok: true, number: created.number, url: created.html_url ?? null, labels: applied, droppedLabels: dropped };
  }

  private async editIssue(context: CallContext, issueNumber: number): Promise<JsonObject> {
    const raw = await context.call.readBody(BODY_LIMIT);
    onlyKeys(raw, ['repo', 'title', 'body', 'state']);
    const body = decodeBody(raw, editSchema);
    const repo = this.allowedRepo(context, body.repo);
    context.audit.target = `#${issueNumber}`;
    const token = await this.token(context, repo, { issues: 'write' });
    const current = decodeGitHubBody((await this.deps.rest.request('GET', `/repos/${repo}/issues/${issueNumber}`, token)).body, githubIssueSchema, 'issue');
    if (current.pull_request !== undefined) {
      throw new BrokerError('not-owner', `#${issueNumber} is a pull request; edit it with PATCH /cloud/github/pulls/${issueNumber}`);
    }
    if (!carriesMarker(current.body, context.entry.sessionId)) {
      throw new BrokerError('not-owner', `issue #${issueNumber} was not opened by this Session`);
    }
    const patch = this.editPatch(context, body);
    const updated = decodeGitHubBody((await this.deps.rest.request('PATCH', `/repos/${repo}/issues/${issueNumber}`, token, patch)).body, githubIssueSchema, 'issue');
    context.audit.githubId = updated.number;
    context.audit.githubUrl = updated.html_url ?? null;
    return { ok: true, number: updated.number, url: updated.html_url ?? null, state: updated.state ?? null };
  }

  private async comment(context: CallContext): Promise<JsonObject> {
    const body = decodeBody(await context.call.readBody(BODY_LIMIT), commentSchema);
    const repo = this.allowedRepo(context, body.repo);
    const target = number(String(body.number));
    context.audit.target = `#${target}`;
    context.audit.bodyLength = body.body.length;
    const token = await this.token(context, repo, { issues: 'write', pull_requests: 'write' });
    const created = decodeGitHubBody((await this.deps.rest.request('POST', `/repos/${repo}/issues/${target}/comments`, token, {
      body: withFooter(text(body.body, 'body'), context.entry),
    })).body, githubCommentSchema, 'comment');
    context.audit.githubId = created.id;
    context.audit.githubUrl = created.html_url ?? null;
    return { ok: true, id: created.id, url: created.html_url ?? null };
  }

  private async read(context: CallContext, rest: string): Promise<JsonObject> {
    const parsed = parseReadPath(rest, context.call.query);
    const repo = this.allowedRepo(context, parsed.repo);
    context.audit.target = parsed.path;
    const permissions: Permissions = parsed.path.startsWith('commits/') && parsed.path.endsWith('/status') ? { statuses: 'read' }
      : parsed.path.endsWith('/check-runs') ? { checks: 'read' }
        : parsed.path.startsWith('actions/') ? { actions: 'read' }
          : parsed.path.startsWith('pulls') ? { pull_requests: 'read', contents: 'read' }
            : { issues: 'read' };
    const token = await this.token(context, repo, permissions);
    const response = await this.deps.rest.request('GET', `/repos/${repo}/${parsed.path}${parsed.query}`, token);
    return { ok: true, status: response.status, data: response.body ?? null };
  }
}

function decodeGitHubBody<Value>(value: JsonValue | undefined, schema: BoundarySchema<Value>, what: string): Value {
  try {
    return decodeBoundary(value, schema);
  } catch (cause) {
    throw new BrokerError('github-error', `GitHub returned an unexpected ${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { status: 200, message: 'unexpected body' });
  }
}

/** github.com for the real thing; the git base URL for a fake. */
function githubWebBase(settings: BrokerSettings): string {
  return settings.gitBaseUrl.replace(/\/+$/u, '');
}
