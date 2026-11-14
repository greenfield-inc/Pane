import { readdir, readFile, realpath, stat } from 'fs/promises';
import path from 'path';
import type { CommandRunner } from '../utils/commandRunner';
import { linuxToUNCPath } from '../utils/wslUtils';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { RunpaneBaseRefreshStatus, RunpanePaneBase } from '../../../shared/types/runpaneOrchestration';

/** Longest a create waits for its base to be fetched before it uses the local ref. */
const BASE_REFRESH_TIMEOUT_MS = 10_000;
/** A fetch of the same base this recently (or a branch-list `fetch --all`) is reused. */
export const BASE_REFRESH_REUSE_MS = 30_000;

/** The outcome of bringing a worktree base up to date before a create. */
export interface BaseRefreshOutcome {
  ref: string;
  status: RunpaneBaseRefreshStatus;
  /** The remote and branch behind `ref` when it is a remote-tracking branch. */
  remote?: string;
  branch?: string;
  /** Why the fetch failed, for example `git fetch timed out after 10s`. */
  reason?: string;
}

interface FetchRecord {
  at: number;
  /** Set when the fetch failed. */
  reason?: string;
}

const inFlightFetches = new Map<string, Promise<FetchRecord>>();
const lastFetches = new Map<string, FetchRecord>();
const lastFetchAll = new Map<string, number>();
/** When each base (project, remote and branch) was last fetched, from any path, seeded from FETCH_HEAD files. */
const lastBaseFetches = new Map<string, number>();
const seededProjects = new Map<string, Promise<void>>();
const lastNotified = new Map<string, number>();
const fetchListeners = new Set<(projectPath: string) => void>();
const focusFetches = new Map<string, Promise<FocusFetchOutcome>>();
/** A focus fetch that failed, or found another git fetch running, waits this long before trying again. */
const focusAttempts = new Map<string, number>();
const remoteBranches = new Map<string, { at: number; target: Promise<RemoteBranch | null> }>();
const remoteUrlLists = new Map<string, { at: number; urls: Promise<Map<string, string>> }>();

/** How long a project's remotes and a base's remote branch are reused before git is asked again. */
const REMOTE_CACHE_MS = 10 * 60_000;
/** Fetches reported this close together refresh the project's Panes once. */
const FETCH_NOTIFY_SETTLE_MS = 2_000;
const GIT_QUERY_TIMEOUT_MS = 10_000;
/** Where a focus fetch puts the fetched tip before it moves the remote-tracking branch. */
const FOCUS_FETCH_REF_PREFIX = 'refs/pane/focus-fetch';
/** A running `git fetch`, `git pull` or `git remote update`, as a process list shows its command line. */
const FETCHING_GIT = /(^|[\s"/\\])git(\.exe)?"?\s(.*\s)?(fetch|pull|remote\s+update)(\s|$)/i;

// Pane runs git without a terminal; these make a credential problem fail fast
// instead of waiting for input until the cap.
const NON_INTERACTIVE_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

type FetchError = { message?: string; stderr?: string; killed?: boolean };
type RemoteBranch = { remote: string; branch: string };

const fetchErrorSchema = boundary.object({
  message: boundary.optional(boundary.string),
  stderr: boundary.optional(boundary.string),
  killed: boundary.optional(boundary.boolean),
});

/** Records a successful `git fetch --all` so creates right after it don't fetch again. */
export function recordProjectFetch(projectPath: string): void {
  lastFetchAll.set(projectPath, Date.now());
  notifyFetch(projectPath);
}

/** Something fetched part of the project (one remote, or a ref that is no Pane's base): its Panes may have moved. */
export function noteFetch(projectPath: string): void {
  notifyFetch(projectPath);
}

/**
 * A FETCH_HEAD in the project changed: an agent's or a terminal's own `git fetch` or `git pull`.
 * Each remote branch it names counts as fetched at the file's time.
 */
export async function recordFetchHead(projectPath: string, fetchHeadPath: string, commandRunner: CommandRunner): Promise<void> {
  if (await readFetchHead(projectPath, fetchHeadPath, commandRunner)) notifyFetch(projectPath);
}

/** Calls `listener` after recorded fetches, once per burst. Returns a function that stops it. */
export function onFetch(listener: (projectPath: string) => void): () => void {
  fetchListeners.add(listener);
  return () => fetchListeners.delete(listener);
}

function notifyFetch(projectPath: string): void {
  const now = Date.now();
  if (now - (lastNotified.get(projectPath) ?? Number.NEGATIVE_INFINITY) < FETCH_NOTIFY_SETTLE_MS) return;
  lastNotified.set(projectPath, now);
  for (const listener of fetchListeners) listener(projectPath);
}

function recordBaseFetch(projectPath: string, target: RemoteBranch, at: number): void {
  const key = baseKey(projectPath, target);
  lastBaseFetches.set(key, Math.max(lastBaseFetches.get(key) ?? 0, at));
}

function baseKey(projectPath: string, target: RemoteBranch): string {
  return `${projectPath}::${target.remote}/${target.branch}`;
}

/**
 * When the remote branch behind `baseRef` was last fetched, or undefined if unknown or `baseRef`
 * is not a remote-tracking branch. A `git fetch --all` counts for every base. The first read
 * seeds it from the FETCH_HEAD files of the repository and its worktrees, so it survives restarts.
 */
export async function lastBaseFetchedAt(projectPath: string, baseRef: string, commandRunner: CommandRunner): Promise<number | undefined> {
  const target = await cachedRemoteBranchOf(projectPath, baseRef, commandRunner);
  if (!target) return undefined;
  let seeding = seededProjects.get(projectPath);
  if (!seeding) {
    seeding = seedFromFetchHeads(projectPath, commandRunner);
    seededProjects.set(projectPath, seeding);
  }
  await seeding;
  const times = [lastBaseFetches.get(baseKey(projectPath, target)), lastFetchAll.get(projectPath)].filter((time): time is number => time !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}

async function seedFromFetchHeads(projectPath: string, commandRunner: CommandRunner): Promise<void> {
  let commonDir: string;
  try {
    const { stdout } = await commandRunner.execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], projectPath, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS });
    const dir = stdout.trim();
    // git answers with a Linux path for a WSL project; Pane reads the file from Windows.
    commonDir = commandRunner.wslContext ? linuxToUNCPath(dir, commandRunner.wslContext.distribution) : dir;
  } catch {
    return;
  }
  const worktreesDir = path.join(commonDir, 'worktrees');
  const worktreeNames = await readdir(worktreesDir).catch(() => []);
  const candidates = [commonDir, ...worktreeNames.map(name => path.join(worktreesDir, name))];
  await Promise.all(candidates.map(dir => readFetchHead(projectPath, path.join(dir, 'FETCH_HEAD'), commandRunner)));
}

/** Records each remote branch a FETCH_HEAD names. A failed fetch leaves it empty. Returns whether it named any. */
async function readFetchHead(projectPath: string, fetchHeadPath: string, commandRunner: CommandRunner): Promise<boolean> {
  const [info, text] = await Promise.all([stat(fetchHeadPath).catch(() => null), readFile(fetchHeadPath, 'utf8').catch(() => '')]);
  if (!info || !text.trim()) return false;
  const urls = await remoteUrls(projectPath, commandRunner);
  let named = false;
  // Each line: `<sha>\t[not-for-merge]\tbranch '<branch>' of <url>`, the URL without credentials or `.git`.
  for (const line of text.split('\n')) {
    const match = /\tbranch '(.+)' of (.+)$/.exec(line);
    const remote = match ? urls.get(normalizeRemoteUrl(match[2])) : undefined;
    if (!match || !remote) continue;
    recordBaseFetch(projectPath, { remote, branch: match[1] }, info.mtimeMs);
    named = true;
  }
  return named;
}

function remoteUrls(projectPath: string, commandRunner: CommandRunner): Promise<Map<string, string>> {
  const cached = remoteUrlLists.get(projectPath);
  if (cached && Date.now() - cached.at < REMOTE_CACHE_MS) return cached.urls;
  const urls = commandRunner.execFile('git', ['remote', '-v'], projectPath, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS })
    .then(({ stdout }) => {
      const byUrl = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        const [name, url] = line.trim().split(/\s+/);
        if (name && url) byUrl.set(normalizeRemoteUrl(url), name);
      }
      return byUrl;
    }, () => new Map<string, string>());
  remoteUrlLists.set(projectPath, { at: Date.now(), urls });
  return urls;
}

function normalizeRemoteUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}

function cachedRemoteBranchOf(projectPath: string, baseRef: string, commandRunner: CommandRunner): Promise<RemoteBranch | null> {
  const key = `${projectPath}::${baseRef}`;
  const cached = remoteBranches.get(key);
  if (cached && Date.now() - cached.at < REMOTE_CACHE_MS) return cached.target;
  const target = remoteBranchOf(projectPath, baseRef, commandRunner);
  remoteBranches.set(key, { at: Date.now(), target });
  return target;
}

/** What a focus fetch did. `busy`: another git fetch or pull was running, so the remote-tracking branch was left alone. */
export type FocusFetchOutcome =
  | { status: 'fetched' | 'busy'; remote: string; branch: string }
  | { status: 'skipped' | 'failed'; reason: string };

/**
 * Brings the remote branch behind `baseRef` up to date when it was last fetched over
 * `maxAgeMs` ago, without ever making someone else's `git pull` or `git fetch` fail:
 *
 * 1. It fetches into a ref of Pane's own, so a fetch running beside it never sees the
 *    remote-tracking branch move (`--refmap=` stops git updating it, `--no-write-fetch-head`
 *    leaves FETCH_HEAD to the person's own fetches).
 * 2. It queues the remote-tracking update in a ref transaction, checks that no git fetch,
 *    pull or `remote update` is running in the repository, and only then commits. A fetch
 *    that starts after the check reads the branch after its network handshake, by which
 *    time the commit is done.
 *    The update names the tip it replaces, so a branch someone else moved meanwhile is kept.
 *
 * Only HTTPS and local remotes are fetched: an SSH remote can make an SSH agent ask for a touch
 * or a password on every focus. Callers for the same base share one fetch.
 */
export async function fetchBaseForFocus(projectPath: string, baseRef: string, maxAgeMs: number, commandRunner: CommandRunner): Promise<FocusFetchOutcome | { status: 'fresh'; ageMs: number }> {
  const target = await cachedRemoteBranchOf(projectPath, baseRef, commandRunner);
  if (!target) return { status: 'skipped', reason: `${baseRef} is not a remote-tracking branch` };
  const last = await lastBaseFetchedAt(projectPath, baseRef, commandRunner);
  const now = Date.now();
  if (last !== undefined && now - last < maxAgeMs) return { status: 'fresh', ageMs: now - last };
  const key = baseKey(projectPath, target);
  let pending = focusFetches.get(key);
  if (!pending) {
    const attempted = focusAttempts.get(key);
    if (attempted !== undefined && now - attempted < maxAgeMs) {
      return { status: 'skipped', reason: `the last try ${Math.round((now - attempted) / 1000)}s ago did not fetch` };
    }
    pending = focusFetch(projectPath, target, commandRunner).finally(() => focusFetches.delete(key));
    focusFetches.set(key, pending);
  }
  return pending;
}

async function focusFetch(projectPath: string, target: RemoteBranch, commandRunner: CommandRunner): Promise<FocusFetchOutcome> {
  const key = baseKey(projectPath, target);
  const tracking = `refs/remotes/${target.remote}/${target.branch}`;
  const own = `${FOCUS_FETCH_REF_PREFIX}/${target.remote}/${target.branch}`;
  const git = (args: string[], options: { env?: Record<string, string>; timeout?: number } = {}) =>
    commandRunner.execFile('git', args, projectPath, { silent: true, timeout: options.timeout ?? GIT_QUERY_TIMEOUT_MS, env: options.env });
  const failed = (reason: string): FocusFetchOutcome => {
    focusAttempts.set(key, Date.now());
    return { status: 'failed', reason };
  };
  try {
    const { stdout: url } = await git(['remote', 'get-url', '--', target.remote]);
    if (!fetchesWithoutPrompt(url.trim())) {
      focusAttempts.set(key, Date.now());
      return { status: 'skipped', reason: `${target.remote} is not an HTTPS or local remote` };
    }
    const { stdout: previous } = await git(['rev-parse', '--verify', '--quiet', tracking]);
    try {
      await git(
        ['fetch', '--no-tags', '--no-auto-gc', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', '--quiet', '--', target.remote, `+refs/heads/${target.branch}:${own}`],
        { env: NON_INTERACTIVE_GIT_ENV, timeout: BASE_REFRESH_TIMEOUT_MS },
      );
    } catch (error) {
      return failed(describeFetchError(error));
    }
    const { stdout: fetched } = await git(['rev-parse', '--verify', own]);
    const next = fetched.trim();
    const moved = next === previous.trim()
      ? 'unchanged'
      : await commitUnlessFetching(commandRunner, projectPath, [`update ${tracking} ${next} ${previous.trim()}`, `delete ${own}`]);
    if (moved !== 'committed') await git(['update-ref', '-d', own]).catch(() => undefined);
    if (moved === 'busy') {
      focusAttempts.set(key, Date.now());
      return { status: 'busy', ...target };
    }
    if (moved === 'not-committed') {
      // Someone else's fetch moved the branch first, which is as fresh; otherwise the update failed.
      const { stdout: current } = await git(['rev-parse', '--verify', '--quiet', tracking]).catch(() => ({ stdout: previous }));
      if (current.trim() === previous.trim()) return failed(`could not update ${tracking}`);
    }
    recordBaseFetch(projectPath, target, Date.now());
    focusAttempts.delete(key);
    notifyFetch(projectPath);
    return { status: 'fetched', ...target };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** HTTPS and local paths fetch without asking anyone; SSH and anything else may ask an agent or a key. */
function fetchesWithoutPrompt(url: string): boolean {
  return /^https?:\/\//i.test(url) || /^file:\/\//i.test(url) || path.isAbsolute(url) || path.win32.isAbsolute(url) || /^\.\.?[\\/]/.test(url);
}

/**
 * Runs `commands` as one `git update-ref --stdin` transaction. The transaction is queued (no
 * lock taken) before the process check and committed straight after it, so the window in which a
 * new fetch could read the old tip and later fail is about a millisecond.
 */
function commitUnlessFetching(commandRunner: CommandRunner, cwd: string, commands: string[]): Promise<'committed' | 'busy' | 'not-committed'> {
  return new Promise(resolve => {
    const child = commandRunner.spawnFile('git', ['update-ref', '--stdin'], cwd);
    let busy = false;
    child.on('error', () => resolve('not-committed'));
    child.on('close', code => resolve(busy ? 'busy' : code === 0 ? 'committed' : 'not-committed'));
    child.stdin.on('error', () => undefined);
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.write(`start\n${commands.join('\n')}\n`);
    void gitFetchRunning(commandRunner, cwd).then(running => {
      busy = running;
      child.stdin.end(running ? 'abort\n' : 'commit\n');
    });
  });
}

/**
 * Whether a git fetch, pull or `remote update` is running in this repository or one of its
 * worktrees. Windows reports no working directory for another process, so there any such git
 * process counts. A process list that cannot be read counts as one running.
 */
async function gitFetchRunning(commandRunner: CommandRunner, cwd: string): Promise<boolean> {
  try {
    if (process.platform === 'win32' && !commandRunner.wslContext) {
      const { stdout } = await commandRunner.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { $_.CommandLine }"], cwd, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS });
      return stdout.split('\n').some(line => FETCHING_GIT.test(line.trim()));
    }
    // Names first (a short list), then command lines for the git processes only.
    const { stdout: names } = await commandRunner.execFile('ps', ['-A', '-o', 'pid=,comm='], cwd, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS });
    const gitPids = rows(names).filter(([, name]) => path.posix.basename(name) === 'git').map(([pid]) => pid);
    if (gitPids.length === 0) return false;
    // ps exits 1 when a listed process ended meanwhile.
    const { stdout: commands } = await commandRunner.execFile('ps', ['-o', 'pid=,args=', '-p', gitPids.join(',')], cwd, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS, okExitCodes: [1] });
    const pids = rows(commands).filter(([, args]) => FETCHING_GIT.test(args)).map(([pid]) => pid);
    if (pids.length === 0) return false;
    const [directories, repository] = await Promise.all([processDirectories(commandRunner, cwd, pids), repositoryDirectories(commandRunner, cwd)]);
    return directories.some(directory => repository.some(root => directory === root || directory.startsWith(`${root}/`)));
  } catch {
    return true;
  }
}

/** `pid rest-of-line` rows of a ps listing. */
function rows(listing: string): Array<[string, string]> {
  return listing.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match): match is RegExpExecArray => match !== null).map(match => [match[1], match[2].trim()]);
}

/** The working directories of `pids`, as the process's own system reports them. */
async function processDirectories(commandRunner: CommandRunner, cwd: string, pids: string[]): Promise<string[]> {
  if (process.platform === 'darwin' && !commandRunner.wslContext) {
    // lsof exits 1 when a process ended meanwhile; what it printed still counts.
    const { stdout } = await commandRunner.execFile('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], cwd, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS, okExitCodes: [1] });
    return stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  }
  const { stdout } = await commandRunner.execFile('readlink', pids.map(pid => `/proc/${pid}/cwd`), cwd, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS, okExitCodes: [1] });
  return stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

/** The repository's main checkout and worktrees, resolved as the process list reports paths. */
async function repositoryDirectories(commandRunner: CommandRunner, cwd: string): Promise<string[]> {
  const { stdout } = await commandRunner.execFile('git', ['worktree', 'list', '--porcelain'], cwd, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS });
  const directories = stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length));
  if (commandRunner.wslContext) return directories;
  return Promise.all(directories.map(directory => realpath(directory).catch(() => directory)));
}

function describeFetchError(error: unknown): string {
  let details: FetchError;
  try {
    details = decodeBoundary(error, fetchErrorSchema);
  } catch {
    details = { message: String(error) };
  }
  return details.killed ? `git fetch timed out after ${BASE_REFRESH_TIMEOUT_MS / 1000}s` : fetchFailureReason(details);
}

/**
 * Fetches the remote branch behind `baseRef` so a new worktree starts at the
 * remote's current tip. Only remote-tracking bases are fetched (one branch, no
 * tags, no prompts, capped at BASE_REFRESH_TIMEOUT_MS); callers for the same
 * base share one fetch and reuse its result for BASE_REFRESH_REUSE_MS. Never
 * throws: a failed fetch is reported so the create can go on from the local ref.
 */
export async function refreshWorktreeBase(
  projectPath: string,
  baseRef: string,
  commandRunner: CommandRunner,
): Promise<BaseRefreshOutcome> {
  const target = await remoteBranchOf(projectPath, baseRef, commandRunner);
  if (!target) return { ref: baseRef, status: 'skipped' };
  const outcome = { ref: baseRef, ...target };

  const now = Date.now();
  const fetchedAll = lastFetchAll.get(projectPath);
  if (fetchedAll !== undefined && now - fetchedAll < BASE_REFRESH_REUSE_MS) {
    return { ...outcome, status: 'recent' };
  }
  const key = `${projectPath}::${target.remote}/${target.branch}`;
  const last = lastFetches.get(key);
  if (last && now - last.at < BASE_REFRESH_REUSE_MS) {
    return last.reason === undefined
      ? { ...outcome, status: 'recent' }
      : { ...outcome, status: 'failed', reason: last.reason };
  }

  let pending = inFlightFetches.get(key);
  if (!pending) {
    pending = fetchBranch(projectPath, target.remote, target.branch, commandRunner).then(record => {
      lastFetches.set(key, record);
      inFlightFetches.delete(key);
      if (record.reason === undefined) {
        recordBaseFetch(projectPath, target, record.at);
        notifyFetch(projectPath);
      }
      return record;
    });
    inFlightFetches.set(key, pending);
  }
  const record = await pending;
  return record.reason === undefined
    ? { ...outcome, status: 'fetched' }
    : { ...outcome, status: 'failed', reason: record.reason };
}

/** The base a create reports, with a notice when the base could not be refreshed. */
export function describeWorktreeBase(outcome: BaseRefreshOutcome, commit: string | undefined): RunpanePaneBase {
  const base: RunpanePaneBase = { ref: outcome.ref, commit, refresh: outcome.status };
  if (outcome.status === 'failed') base.notice = staleBaseNotice(outcome, commit);
  return base;
}

function staleBaseNotice(outcome: BaseRefreshOutcome, commit: string | undefined): string {
  const at = commit ? ` at ${commit.slice(0, 7)}` : '';
  const pull = outcome.remote && outcome.branch
    ? `run \`git pull --rebase ${outcome.remote} ${outcome.branch}\` in the Pane`
    : 'pull in the Pane';
  return [
    `Could not refresh ${outcome.ref} before creating this Pane (${outcome.reason ?? 'git fetch failed'}).`,
    `It starts from the local ${outcome.ref}${at}, which may be behind the remote.`,
    `Check the network or credentials, then ${pull} if it needs newer commits.`,
  ].join(' ');
}

async function remoteBranchOf(
  projectPath: string,
  baseRef: string,
  commandRunner: CommandRunner,
): Promise<RemoteBranch | null> {
  try {
    const { stdout: fullName } = await commandRunner.execFile(
      'git', ['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', baseRef], projectPath, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS },
    );
    const remoteRef = fullName.trim();
    if (!remoteRef.startsWith('refs/remotes/')) return null;
    const { stdout: remoteList } = await commandRunner.execFile('git', ['remote'], projectPath, { silent: true, timeout: GIT_QUERY_TIMEOUT_MS });
    const shortName = remoteRef.slice('refs/remotes/'.length);
    // Remote names may contain slashes, so the longest matching remote wins.
    const remote = remoteList.split('\n').map(name => name.trim())
      .filter(name => name && shortName.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!remote) return null;
    const branch = shortName.slice(remote.length + 1);
    return branch && branch !== 'HEAD' ? { remote, branch } : null;
  } catch {
    return null;
  }
}

async function fetchBranch(
  projectPath: string,
  remote: string,
  branch: string,
  commandRunner: CommandRunner,
): Promise<FetchRecord> {
  const timedOut = `git fetch timed out after ${BASE_REFRESH_TIMEOUT_MS / 1000}s`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<string>(resolve => { timer = setTimeout(() => resolve(timedOut), BASE_REFRESH_TIMEOUT_MS); });
  const fetch = (async (): Promise<string | undefined> => {
    try {
      await commandRunner.execFile(
        'git', ['fetch', '--no-tags', '--no-auto-gc', '--quiet', '--', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
        projectPath,
        { timeout: BASE_REFRESH_TIMEOUT_MS, env: NON_INTERACTIVE_GIT_ENV },
      );
      return undefined;
    } catch (error) {
      return describeFetchError(error);
    }
  })();
  try {
    const reason = await Promise.race([fetch, cap]);
    return { at: Date.now(), reason };
  } finally {
    clearTimeout(timer);
  }
}

function fetchFailureReason(details: FetchError): string {
  const lines = (details.stderr || details.message || '').split('\n').map(line => line.trim()).filter(Boolean);
  const line = lines.find(text => text.startsWith('fatal:')) ?? lines[lines.length - 1] ?? 'unknown error';
  return `git fetch failed: ${line.replace(/^fatal:\s*/, '')}`;
}
