import type { KeyObject } from 'node:crypto';
import { boundary, decodeBoundary } from '../../../boundaryDecoder';
import type { BoundarySchema, JsonObject, JsonValue } from '../../../boundaryDecoder';
import type { Clock } from '../types';
import { BrokerError } from './policy';
import { appJwt, loadAppPrivateKey } from './rest';
import type { GitHubRest } from './rest';

// Where the broker's GitHub credential comes from. Both are the user's own:
// a GitHub App (private key on the coordinator; 1 h installation tokens minted per call, narrowed to
// one repository and the permissions that call needs) or a fine-grained PAT. Tokens live in memory only.

type Level = 'read' | 'write';
const PERMISSION_NAMES = ['contents', 'issues', 'pull_requests', 'metadata', 'checks', 'statuses', 'actions'] as const;

/** The GitHub App permissions the broker ever asks for (a token is narrowed to a subset per call). */
export interface Permissions {
  contents?: Level;
  issues?: Level;
  pull_requests?: Level;
  metadata?: Level;
  checks?: Level;
  statuses?: Level;
  actions?: Level;
}

/**
 * The most any broker token may ever carry. Writes only for contents, issues and pull requests;
 * checks, statuses and actions are read-only here even when the App was granted write. Every
 * access_tokens request is capped by this and by the installation's grant (see narrow()).
 */
const BROKER_PERMISSION_CEILING = {
  contents: 'write',
  issues: 'write',
  pull_requests: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
} as const satisfies Permissions;

/** What the broker cannot work without. */
const BROKER_REQUIRED = { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' } as const satisfies Permissions;

/** Permissions the App must not hold at all (any level): GitHub would stop backing up the broker's refusals. */
const FORBIDDEN_APP_PERMISSIONS = ['workflows', 'administration', 'secrets', 'organization_administration'] as const;

interface InstallationAssessment {
  /** Granted beyond the ceiling, e.g. "actions:write", "gists:write". The broker never requests them. */
  extra: string[];
  /** Needed by the broker but not granted (or only read), e.g. "contents:write". */
  missing: string[];
  /** Granted and forbidden outright (FORBIDDEN_APP_PERMISSIONS). */
  forbidden: string[];
}

const LEVEL_RANK = new Map([['read', 1], ['write', 2], ['admin', 3]]);

/** none < read < write < admin; an unknown level counts as the highest. */
function levelRank(level: string | undefined): number {
  return level === undefined ? 0 : LEVEL_RANK.get(level) ?? 3;
}

/** Compares an installation's grant (GitHub's `permissions` object) with what the broker needs. */
export function assessInstallation(granted: ReadonlyMap<string, string>): InstallationAssessment {
  const ceiling = new Map<string, string>(Object.entries(BROKER_PERMISSION_CEILING));
  const extra: string[] = [];
  const forbidden: string[] = [];
  for (const [name, level] of granted) {
    if (FORBIDDEN_APP_PERMISSIONS.some((bad) => bad === name)) forbidden.push(`${name}:${level}`);
    else if (levelRank(level) > levelRank(ceiling.get(name))) extra.push(`${name}:${level}`);
  }
  const missing = Object.entries(BROKER_REQUIRED)
    .filter(([name, level]) => levelRank(granted.get(name)) < levelRank(level))
    .map(([name, level]) => `${name}:${level}`);
  return { extra: extra.sort(), missing, forbidden: forbidden.sort() };
}

/** GitHub's `permissions` object as name -> level (non-string values are ignored). */
export function grantedPermissions(permissions: JsonObject | undefined): Map<string, string> {
  const granted = new Map<string, string>();
  for (const [name, value] of Object.entries(permissions ?? {})) {
    try {
      granted.set(name, decodeBoundary(value, boundary.string));
    } catch {
      // not a permission level
    }
  }
  return granted;
}

interface RepoToken {
  token: string;
  /** ISO time; null for a PAT (its expiry is GitHub's business). */
  expiresAt: string | null;
}

interface InstallationStatus extends InstallationAssessment {
  id: number;
  /** "selected" or "all"; "all" reaches every repository of the account. */
  repositorySelection: string | null;
}

interface CredentialStatus {
  mode: 'app' | 'pat';
  app: { id: string; slug: string | null; installationIds: number[]; installations: InstallationStatus[] } | null;
  /** Repositories the credential can reach, when GitHub can list them (App mode). */
  repos: string[] | null;
}

interface CachedTokenInfo {
  repo: string;
  access: Level;
  /** e.g. "contents:write" (metadata:read is implied). */
  permissions: string;
  expiresAt: string | null;
}

export interface GitHubCredential {
  readonly mode: 'app' | 'pat';
  /** A token for one repository with (at most) these permissions. */
  token(repo: string, permissions: Permissions): Promise<RepoToken>;
  describe(): Promise<CredentialStatus>;
  cachedTokens(): CachedTokenInfo[];
}

/** Reuse a cached installation token until 5 minutes before it expires. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
const INSTALLATION_CACHE_MS = 10 * 60_000;

const grantedLevel = boundary.optional(boundary.string);
const installationSchema = boundary.object({
  id: boundary.number,
  permissions: boundary.optional(boundary.object({
    contents: grantedLevel,
    issues: grantedLevel,
    pull_requests: grantedLevel,
    metadata: grantedLevel,
    checks: grantedLevel,
    statuses: grantedLevel,
    actions: grantedLevel,
  })),
});
const accessTokenSchema = boundary.object({ token: boundary.nonEmptyString, expires_at: boundary.nonEmptyString });
const appSchema = boundary.object({ slug: boundary.optional(boundary.string) });
const installationDetailSchema = boundary.object({
  id: boundary.number,
  repository_selection: boundary.optional(boundary.string),
  permissions: boundary.optional(boundary.jsonObject),
});
const installationListSchema = boundary.array(installationDetailSchema);
const repositoriesSchema = boundary.object({ repositories: boundary.array(boundary.object({ full_name: boundary.nonEmptyString })) });

interface Installation {
  id: number;
  granted: Permissions;
  fetchedAt: number;
}

function decodeGitHub<Value>(value: JsonValue | undefined, schema: BoundarySchema<Value>, what: string): Value {
  try {
    return decodeBoundary(value, schema);
  } catch (cause) {
    throw new BrokerError('github-error', `GitHub returned an unexpected ${what}: ${cause instanceof Error ? cause.message : String(cause)}`, { status: 200, message: 'unexpected body' });
  }
}

function accessOf(permissions: Permissions): Level {
  return PERMISSION_NAMES.some((name) => permissions[name] === 'write') ? 'write' : 'read';
}

function permissionKey(repo: string, permissions: Permissions): string {
  return `${repo.toLowerCase()}|${permissionLabel(permissions)}`;
}

/**
 * What the installation was granted bounds what a token may ask for (GitHub answers 422 otherwise).
 * A permission the call needs but the App lacks is refused here, so a token is never minted with
 * less than the call needs, nor ever with an empty permission set (which GitHub reads as "all").
 */
function narrow(requested: Permissions, granted: Permissions): Permissions {
  const result: Permissions = { metadata: 'read' };
  for (const name of PERMISSION_NAMES) {
    const level = requested[name];
    if (name === 'metadata' || !level) continue;
    if (levelRank(level) > levelRank(BROKER_PERMISSION_CEILING[name])) {
      // A programming error, never a GitHub answer: no call may ask for more than the ceiling.
      throw new BrokerError('github-error', `the broker never requests "${name}: ${level}"`, { status: 0, message: 'over the permission ceiling' });
    }
    const has = granted[name];
    if (!has || (level === 'write' && has !== 'write')) {
      throw new BrokerError('github-error', `the GitHub App installation lacks the "${name}: ${level}" permission this call needs`, { status: 403, message: `missing ${name}:${level}` });
    }
    result[name] = level;
  }
  return result;
}

/** The permissions as the JSON GitHub's access_tokens endpoint takes. */
function permissionsJson(permissions: Permissions): JsonObject {
  const json: JsonObject = {};
  for (const name of PERMISSION_NAMES) {
    const level = permissions[name];
    if (level) json[name] = level;
  }
  return json;
}

function permissionLabel(permissions: Permissions): string {
  return PERMISSION_NAMES.filter((name) => name !== 'metadata' && permissions[name]).map((name) => `${name}:${permissions[name] ?? ''}`).join(',') || 'metadata:read';
}

export class GitHubAppCredential implements GitHubCredential {
  readonly mode = 'app' as const;
  private readonly key: KeyObject;
  private readonly installations = new Map<string, Installation>();
  private readonly tokens = new Map<string, { repo: string; access: Level; permissions: string; token: string; expiresAt: string }>();
  private described: { at: number; status: CredentialStatus } | null = null;

  constructor(
    private readonly options: { appId: string; privateKeyPem: string; installationId: number | null },
    private readonly rest: GitHubRest,
    private readonly clock: Clock,
  ) {
    if (!/^\d{1,12}$/u.test(options.appId)) throw new Error('the GitHub App id must be a number');
    this.key = loadAppPrivateKey(options.privateKeyPem);
  }

  private jwt(): string {
    return appJwt(this.options.appId, this.key, this.clock.now());
  }

  private async installationFor(repo: string): Promise<Installation> {
    const cached = this.installations.get(repo.toLowerCase());
    if (cached && this.clock.now() - cached.fetchedAt < INSTALLATION_CACHE_MS) return cached;
    let response;
    try {
      response = await this.rest.request('GET', `/repos/${repo}/installation`, this.jwt());
    } catch (cause) {
      if (cause instanceof BrokerError && cause.github?.status === 404) {
        throw new BrokerError('repo-not-allowed', `the GitHub App is not installed on ${repo}`);
      }
      throw cause;
    }
    const decoded = decodeGitHub(response.body, installationSchema, 'installation');
    if (this.options.installationId !== null && decoded.id !== this.options.installationId) {
      throw new BrokerError('repo-not-allowed', `${repo} belongs to installation ${decoded.id}, not the configured ${this.options.installationId}`);
    }
    const granted: Permissions = {};
    for (const name of PERMISSION_NAMES) {
      const level = decoded.permissions?.[name];
      if (level === 'read' || level === 'write') granted[name] = level;
    }
    const installation = { id: decoded.id, granted, fetchedAt: this.clock.now() };
    this.installations.set(repo.toLowerCase(), installation);
    return installation;
  }

  async token(repo: string, permissions: Permissions): Promise<RepoToken> {
    const installation = await this.installationFor(repo);
    const wanted = narrow(permissions, installation.granted);
    const cacheKey = permissionKey(repo, wanted);
    const cached = this.tokens.get(cacheKey);
    if (cached && Date.parse(cached.expiresAt) - TOKEN_REUSE_MARGIN_MS > this.clock.now()) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }
    const response = await this.rest.request('POST', `/app/installations/${installation.id}/access_tokens`, this.jwt(), {
      repositories: [repo.split('/')[1]],
      permissions: permissionsJson(wanted),
    });
    const minted = decodeGitHub(response.body, accessTokenSchema, 'installation token');
    this.tokens.set(cacheKey, { repo, access: accessOf(wanted), permissions: permissionLabel(wanted), token: minted.token, expiresAt: minted.expires_at });
    return { token: minted.token, expiresAt: minted.expires_at };
  }

  cachedTokens(): CachedTokenInfo[] {
    const now = this.clock.now();
    return [...this.tokens.values()]
      .filter((entry) => Date.parse(entry.expiresAt) > now)
      .map(({ repo, access, permissions, expiresAt }) => ({ repo, access, permissions, expiresAt }));
  }

  /** App, installations and repositories; cached for the installation-cache period (status is polled). */
  async describe(): Promise<CredentialStatus> {
    if (this.described && this.clock.now() - this.described.at < INSTALLATION_CACHE_MS) return this.described.status;
    const slug = decodeGitHub((await this.rest.request('GET', '/app', this.jwt())).body, appSchema, 'app').slug ?? null;
    const installations = this.options.installationId !== null
      ? [decodeGitHub((await this.rest.request('GET', `/app/installations/${this.options.installationId}`, this.jwt())).body, installationDetailSchema, 'installation')]
      : decodeGitHub((await this.rest.request('GET', '/app/installations?per_page=100', this.jwt())).body, installationListSchema, 'installation list');
    const repos: string[] = [];
    for (const installation of installations) {
      // GitHub has no App-JWT endpoint that lists an installation's repositories, so this is the one
      // token not narrowed to a repository: it can't be (the list is what it's for). It carries only
      // metadata:read, serves this one request, is never cached or returned, and describe() itself is
      // cached for 10 minutes.
      const minted = decodeGitHub((await this.rest.request('POST', `/app/installations/${installation.id}/access_tokens`, this.jwt(), { permissions: { metadata: 'read' } })).body, accessTokenSchema, 'installation token');
      const listed = decodeGitHub((await this.rest.request('GET', '/installation/repositories?per_page=100', minted.token)).body, repositoriesSchema, 'repository list');
      repos.push(...listed.repositories.map((repo) => repo.full_name));
    }
    const installationIds = installations.map((installation) => installation.id);
    const assessed = installations.map((installation): InstallationStatus => ({
      id: installation.id,
      repositorySelection: installation.repository_selection ?? null,
      ...assessInstallation(grantedPermissions(installation.permissions)),
    }));
    const status: CredentialStatus = { mode: 'app', app: { id: this.options.appId, slug, installationIds, installations: assessed }, repos };
    this.described = { at: this.clock.now(), status };
    return status;
  }
}

/** Token prefixes of credentials that reach every repository the user can: never accepted. */
const BROAD_TOKEN_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];

/** Throws unless `token` looks like a fine-grained PAT (`github_pat_…`). Never includes the token in the message. */
export function assertFineGrainedPat(token: string): void {
  const broad = BROAD_TOKEN_PREFIXES.find((prefix) => token.startsWith(prefix));
  if (broad) {
    throw new Error(`refusing a ${broad}… token: classic and OAuth tokens reach every repository you can. Create a fine-grained PAT (github_pat_…) for the selected repositories only.`);
  }
  if (!token.startsWith('github_pat_')) throw new Error('the PAT must be a fine-grained personal access token (github_pat_…)');
  if (/\s/u.test(token)) throw new Error('the PAT file must hold only the token');
}

export class GitHubPatCredential implements GitHubCredential {
  readonly mode = 'pat' as const;

  constructor(private readonly pat: string) {
    assertFineGrainedPat(pat);
  }

  async token(): Promise<RepoToken> {
    return { token: this.pat, expiresAt: null };
  }

  async describe(): Promise<CredentialStatus> {
    return { mode: 'pat', app: null, repos: null };
  }

  cachedTokens(): CachedTokenInfo[] {
    return [];
  }
}
