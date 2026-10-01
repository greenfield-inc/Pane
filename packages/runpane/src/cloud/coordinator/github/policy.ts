import type { DirectoryEntry } from '../types';

// The broker's allowlist rules, kept free of I/O so each one is tested on its own.
// Everything not allowed here is refused.

type BrokerErrorCode =
  | 'github-disabled'
  | 'repo-not-allowed'
  | 'ref-outside-namespace'
  | 'workflow-change-refused'
  | 'not-owner'
  | 'caller-node-mismatch'
  | 'forbidden'
  | 'not-found'
  | 'read-token-unsupported'
  | 'non-fast-forward'
  | 'bad-request'
  | 'too-large'
  | 'github-rate-limited'
  | 'broker-rate-limited'
  | 'github-error';

const STATUS = {
  'github-disabled': 503,
  'repo-not-allowed': 403,
  'ref-outside-namespace': 403,
  'workflow-change-refused': 403,
  'not-owner': 403,
  'caller-node-mismatch': 403,
  forbidden: 403,
  'not-found': 404,
  'read-token-unsupported': 409,
  'non-fast-forward': 409,
  'bad-request': 400,
  'too-large': 413,
  'github-rate-limited': 429,
  'broker-rate-limited': 429,
  'github-error': 502,
} as const satisfies Record<BrokerErrorCode, number>;

export class BrokerError extends Error {
  readonly status: number;

  constructor(
    readonly code: BrokerErrorCode,
    message: string,
    readonly github?: { status: number; message: string },
  ) {
    super(message);
    this.name = 'BrokerError';
    this.status = STATUS[code];
  }
}

/** Paths a push may never change: GitHub runs these with the repository's secrets. */
const REFUSED_PATH_PREFIXES = ['.github/workflows/'] as const;

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/u;

function parseRepo(value: string): string {
  if (!REPO_PATTERN.test(value) || value.endsWith('.git') || value.split('/')[1].startsWith('.')) {
    throw new BrokerError('bad-request', `repo must be owner/name, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The repos a Session may use: its directory entry's `github.repos`, matched without regard to case. */
export function requireAllowedRepo(entry: DirectoryEntry, repo: string): string {
  const wanted = parseRepo(repo).toLowerCase();
  const allowed = entry.githubRepos.find((candidate) => candidate.toLowerCase() === wanted);
  if (!allowed) {
    throw new BrokerError('repo-not-allowed', `${repo} is not in this Session's GitHub allowlist (${entry.githubRepos.join(', ') || 'empty'})`);
  }
  return allowed;
}

/** The Session's host name: its tailnet name, the first DNS label of its daemon URL. */
export function sessionHost(entry: DirectoryEntry): string {
  try {
    const host = new URL(entry.baseUrl).hostname.toLowerCase().split('.')[0];
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host)) return host;
  } catch {
    // fall through
  }
  throw new BrokerError('forbidden', `directory entry ${entry.sessionId} has no usable host name`);
}

export function namespaceOf(entry: DirectoryEntry): string {
  return `cloud/${sessionHost(entry)}/`;
}

/** A branch name git accepts that stays inside `refs/heads/` (a subset of git check-ref-format). */
export function validBranchName(name: string): boolean {
  if (!BRANCH_PATTERN.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.startsWith('-') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//')) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * Maps the caller's branch to its full name inside its own namespace. `feature` and
 * `cloud/<host>/feature` both mean `cloud/<host>/feature`; any other `cloud/...` name is someone
 * else's namespace and refused.
 */
export function namespacedBranch(entry: DirectoryEntry, branch: string): string {
  const namespace = namespaceOf(entry);
  if (!validBranchName(branch)) {
    throw new BrokerError('bad-request', 'branch must match [A-Za-z0-9._/-]{1,100}, without "..", "//", a leading "/" or "-", or a ".lock" part');
  }
  const short = branch.startsWith(namespace) ? branch.slice(namespace.length) : branch;
  if (short.length === 0) throw new BrokerError('bad-request', 'branch is empty after the namespace');
  if (/^cloud\//iu.test(short) || /^refs\//iu.test(short)) {
    throw new BrokerError('ref-outside-namespace', `this Session may only write branches under ${namespace}`);
  }
  const full = `${namespace}${short}`;
  if (full.length > 255) throw new BrokerError('bad-request', 'branch is too long');
  return full;
}

/** Whether a branch (without refs/heads/) lies in the caller's namespace. */
export function inNamespace(entry: DirectoryEntry, branch: string): boolean {
  return branch.startsWith(namespaceOf(entry));
}

export function refusedPaths(paths: readonly string[]): string[] {
  return paths.filter((file) => REFUSED_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)));
}

const MARKER_PATTERN = /<!--\s*runpane-cloud:[^>]*-->/giu;

function marker(sessionId: string): string {
  return `<!-- runpane-cloud:${sessionId} -->`;
}

/**
 * Appends the provenance footer. Markers already in the caller's text are removed first, so a
 * Session can't claim (or hand out) ownership of what it writes.
 */
export function withFooter(text: string | undefined, entry: DirectoryEntry): string {
  const clean = (text ?? '').replace(MARKER_PATTERN, '').replace(/\s+$/u, '');
  return `${clean}\n\n---\nOpened by runpane cloud Session ${entry.label} (${sessionHost(entry)}). ${marker(entry.sessionId)}`;
}

export function carriesMarker(body: string | null | undefined, sessionId: string): boolean {
  return (body ?? '').includes(marker(sessionId));
}

/** Titles never carry markers either (they would only confuse readers). */
export function cleanTitle(title: string): string {
  const clean = title.replace(MARKER_PATTERN, '').trim();
  if (clean.length === 0 || clean.length > 256) throw new BrokerError('bad-request', 'title must be 1-256 characters');
  return clean;
}

// ---------------------------------------------------------------- read passthrough

const READ_PATHS: readonly RegExp[] = [
  /^issues$/u,
  /^issues\/\d{1,9}$/u,
  /^issues\/\d{1,9}\/comments$/u,
  /^pulls$/u,
  /^pulls\/\d{1,9}$/u,
  /^pulls\/\d{1,9}\/files$/u,
  /^pulls\/\d{1,9}\/reviews$/u,
  /^commits\/[A-Za-z0-9._/-]{1,200}\/status$/u,
  /^commits\/[A-Za-z0-9._/-]{1,200}\/check-runs$/u,
  /^actions\/runs$/u,
];

const READ_QUERY_KEYS = new Set(['state', 'per_page', 'page', 'branch', 'head', 'base', 'sort', 'direction', 'labels', 'event', 'status', 'since']);

interface ReadRequest {
  repo: string;
  /** The REST path under /repos/<owner>/<name>/. */
  path: string;
  /** The allowlisted query, with its leading "?" (or empty). */
  query: string;
}

/** Splits `<owner>/<name>/<path>` and checks the path and query against the read allowlist. */
export function parseReadPath(rest: string, query: URLSearchParams): ReadRequest {
  const parts = rest.split('/');
  if (parts.length < 3) throw new BrokerError('bad-request', 'read paths look like /cloud/github/read/<owner>/<name>/<path>');
  const repo = parseRepo(`${parts[0]}/${parts[1]}`);
  const path = parts.slice(2).join('/');
  if (path.includes('..') || !READ_PATHS.some((pattern) => pattern.test(path))) {
    throw new BrokerError('forbidden', `GET ${path} is not in the broker's read allowlist`);
  }
  const kept = new URLSearchParams();
  for (const [key, value] of query) {
    if (!READ_QUERY_KEYS.has(key)) throw new BrokerError('forbidden', `query parameter ${key} is not allowed`);
    kept.append(key, value);
  }
  const search = kept.toString();
  return { repo, path, query: search ? `?${search}` : '' };
}

// ---------------------------------------------------------------- git bundles

interface BundleHeader {
  version: 2 | 3;
  prerequisites: string[];
  refs: Array<{ sha: string; name: string }>;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function isSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

/** Parses a git bundle's text header (gitformat-bundle(5)); refuses anything else. */
export function parseBundleHeader(bundle: Buffer): BundleHeader {
  const end = bundle.indexOf('\n\n');
  if (end < 0 || end > 1024 * 1024) throw new BrokerError('bad-request', 'bundle is not a git bundle (no header)');
  const lines = bundle.subarray(0, end).toString('utf8').split('\n');
  const signature = lines.shift();
  const version = signature === '# v2 git bundle' ? 2 : signature === '# v3 git bundle' ? 3 : null;
  if (!version) throw new BrokerError('bad-request', 'bundle is not a v2/v3 git bundle');
  const header: BundleHeader = { version, prerequisites: [], refs: [] };
  for (const line of lines) {
    if (version === 3 && line.startsWith('@')) {
      if (line !== '@object-format=sha1' && !line.startsWith('@filter=')) {
        throw new BrokerError('bad-request', `unsupported bundle capability ${line}`);
      }
      if (line.startsWith('@filter=')) throw new BrokerError('bad-request', 'filtered (partial) bundles are not accepted');
      continue;
    }
    if (line.startsWith('-')) {
      const sha = line.slice(1, 41);
      if (!isSha(sha)) throw new BrokerError('bad-request', 'bundle has a malformed prerequisite');
      header.prerequisites.push(sha);
      continue;
    }
    const [sha, name] = line.split(' ', 2);
    if (!isSha(sha) || !name) throw new BrokerError('bad-request', 'bundle has a malformed ref line');
    header.refs.push({ sha, name });
  }
  return header;
}
