import type { CommandRunner } from '../utils/commandRunner';
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

// Pane runs git without a terminal; these make a credential problem fail fast
// instead of waiting for input until the cap.
const NON_INTERACTIVE_GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

type FetchError = { message?: string; stderr?: string; killed?: boolean };

const fetchErrorSchema = boundary.object({
  message: boundary.optional(boundary.string),
  stderr: boundary.optional(boundary.string),
  killed: boundary.optional(boundary.boolean),
});

/** Records a successful `git fetch --all` so creates right after it don't fetch again. */
export function recordProjectFetch(projectPath: string): void {
  lastFetchAll.set(projectPath, Date.now());
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
): Promise<{ remote: string; branch: string } | null> {
  try {
    const { stdout: fullName } = await commandRunner.execFile(
      'git', ['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', baseRef], projectPath, { silent: true, timeout: 10_000 },
    );
    const remoteRef = fullName.trim();
    if (!remoteRef.startsWith('refs/remotes/')) return null;
    const { stdout: remoteList } = await commandRunner.execFile('git', ['remote'], projectPath, { silent: true, timeout: 10_000 });
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
        'git', ['fetch', '--no-tags', '--quiet', '--', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
        projectPath,
        { timeout: BASE_REFRESH_TIMEOUT_MS, env: NON_INTERACTIVE_GIT_ENV },
      );
      return undefined;
    } catch (error) {
      let details: FetchError;
      try {
        details = decodeBoundary(error, fetchErrorSchema);
      } catch {
        details = { message: String(error) };
      }
      return details.killed ? timedOut : fetchFailureReason(details);
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
