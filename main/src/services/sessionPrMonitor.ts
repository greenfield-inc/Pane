import type { GitStatusManager } from './gitStatusManager';
import type { OrchestrationSessionManager } from './orchestrationSessionManager';
import type { SessionManager } from './sessionManager';
import type { WorkspaceJournal } from './workspaceJournal';
import type { Logger } from '../utils/logger';
import type { RunpaneWorkspacePullRequest } from '../../../shared/types/runpaneOrchestration';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

/** How often Session members' open PRs are polled (decision D7), before jitter. */
export const SESSION_PR_POLL_INTERVAL_MS = 3 * 60_000;
const POLL_JITTER_MS = 30_000;
/** Ceiling for the doubling delay after `gh` is missing, signed out, rate limited, or timing out. */
const MAX_BACKOFF_MS = 60 * 60_000;
const GH_TIMEOUT_MS = 10_000;
const MAX_FAILING_CHECKS = 5;
const PR_VIEW_FIELDS = 'number,url,state,mergeable,statusCheckRollup,headRefOid';
/** Completed check-run conclusions that fail a PR; SUCCESS, NEUTRAL, SKIPPED, and STALE pass. */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

// `statusCheckRollup` mixes check runs (name/status/conclusion) and commit statuses (context/state).
const prCheckSchema = boundary.object({
  __typename: boundary.optional(boundary.string),
  name: boundary.optional(boundary.nullable(boundary.string)),
  context: boundary.optional(boundary.nullable(boundary.string)),
  status: boundary.optional(boundary.nullable(boundary.string)),
  conclusion: boundary.optional(boundary.nullable(boundary.string)),
  state: boundary.optional(boundary.nullable(boundary.string)),
});
const prViewSchema = boundary.object({
  number: boundary.number,
  url: boundary.string,
  state: boundary.string,
  mergeable: boundary.optional(boundary.nullable(boundary.string)),
  statusCheckRollup: boundary.optional(boundary.nullable(boundary.array(prCheckSchema))),
  headRefOid: boundary.string,
});

// A failed `gh` call: Node's execFile rejection carries the spawn code, a timeout kill, and stderr.
const ghFailureSchema = boundary.object({
  code: boundary.optional(boundary.union(boundary.string, boundary.number)),
  killed: boundary.optional(boundary.boolean),
  stderr: boundary.optional(boundary.string),
});

type PrCheck = ReturnType<typeof prCheckSchema.decode>;
type GhFailure = ReturnType<typeof ghFailureSchema.decode>;

/** A PR's checks rolled up: `pending` until every check on the head commit has finished. */
interface ChecksSummary {
  state: 'none' | 'pending' | 'passed' | 'failed';
  /** Failing check names, deduplicated and capped, when `state` is `failed`. */
  failing: string[];
}

/** What the monitor last saw of a Pane's PR; transitions are measured against it. */
interface TrackedPr {
  number: number;
  state: string;
  /** Last definite answer; GitHub's transient UNKNOWN never replaces it. */
  mergeable?: 'MERGEABLE' | 'CONFLICTING';
  /** `<headOid>:<passed|failed>` of the last settled checks. */
  settledChecks?: string;
  /** Checks as last seen, settled or not. */
  checks: ChecksSummary['state'];
}

interface SessionPrMonitorOptions {
  sessions: Pick<OrchestrationSessionManager, 'activeMemberPaneIds'>;
  panes: Pick<SessionManager, 'getSession' | 'getProjectContext'>;
  gitStatus: Pick<GitStatusManager, 'getCachedStatus' | 'lookupPrForPane' | 'withGithubSlot'>;
  journal: Pick<WorkspaceJournal, 'appendPaneEntry'>;
  logger?: Pick<Logger, 'info' | 'warn'>;
  intervalMs?: number;
  random?: () => number;
  now?: () => number;
}

class GithubUnavailableError extends Error {}

/**
 * Reports PR conflicts, settled checks, and merges for Panes in a live named Session (decision
 * D7). Every ~3 minutes, for each Session member only, it runs `gh pr view` on the member's open
 * PR and appends `pr.conflicted`, `pr.checks`, and `pr.merged` journal entries on transitions only.
 * A member with no known open PR (never looked at, or its PR closed or merged) is first looked up
 * by branch through GitStatusManager's PR lookup, so a background worker's new or reopened PR is
 * found without waiting for a git status refresh. Every `gh` call goes through GitStatusManager's
 * one-at-a-time slot.
 *
 * The first poll of a PR seeds its state without an entry, so a daemon restart does not restate
 * every conflict. A missing, signed-out, rate-limited, or timing-out `gh` doubles the delay (up to
 * an hour) and is logged once per outage.
 */
export class SessionPrMonitor {
  private readonly tracked = new Map<string, TrackedPr>();
  private readonly intervalMs: number;
  private readonly random: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The round in flight; a second caller awaits it instead of starting another. */
  private round: Promise<void> | undefined;
  private stopped = true;
  /** Bumped by `stop`, so a round in flight stops at its next Pane. */
  private stopCount = 0;
  private failures = 0;
  private lastRoundAt: number | undefined;
  private readonly now: () => number;

  constructor(private readonly options: SessionPrMonitorOptions) {
    this.intervalMs = options.intervalMs ?? SESSION_PR_POLL_INTERVAL_MS;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  /**
   * Open PRs whose checks were still running at the last poll, for cloud safe-to-stop. Polls
   * first when the last round is older than `maxAgeMs`, since the first scheduled round only
   * runs minutes after start and a sandbox is often asked right after a wake.
   */
  async pendingChecks(maxAgeMs: number): Promise<Array<{ paneId: string; prNumber: number }>> {
    if (this.lastRoundAt === undefined || this.now() - this.lastRoundAt >= maxAgeMs) {
      await this.pollOnce();
    }
    const members = new Set(this.options.sessions.activeMemberPaneIds());
    return [...this.tracked.entries()]
      .filter(([paneId, pr]) => members.has(paneId) && pr.state === 'OPEN' && pr.checks === 'pending')
      .map(([paneId, pr]) => ({ paneId, prNumber: pr.number }));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.stopCount += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One polling round. Runs no `gh` when there is no live Session member. */
  pollOnce(): Promise<void> {
    this.round ??= this.runRound().finally(() => {
      this.round = undefined;
    });
    return this.round;
  }

  private async runRound(): Promise<void> {
    const stopCount = this.stopCount;
    try {
      const members = this.members();
      for (const paneId of members) {
        if (this.stopCount !== stopCount) return;
        const prNumber = this.knownOpenPr(paneId) ?? await this.discoverOpenPr(paneId);
        if (prNumber === undefined || this.stopCount !== stopCount) continue;
        const observed = await this.view(paneId, prNumber);
        if (observed) this.observe(paneId, observed);
      }
      if (members.length > 0 && this.failures > 0) {
        this.options.logger?.info('[SessionPrMonitor] GitHub CLI is reachable again; PR polling resumed');
      }
      if (members.length > 0) this.failures = 0;
      this.lastRoundAt = this.now();
    } catch (error) {
      if (!(error instanceof GithubUnavailableError)) throw error;
      if (this.failures === 0) {
        this.options.logger?.warn(`[SessionPrMonitor] Pausing PR polling: ${error.message}`);
      }
      this.failures += 1;
    }
  }

  /** Live, unarchived Session members. Forgets Panes that left every Session. */
  private members(): string[] {
    const members = new Set(this.options.sessions.activeMemberPaneIds());
    for (const paneId of this.tracked.keys()) {
      if (!members.has(paneId)) this.tracked.delete(paneId);
    }
    return [...members].filter(paneId => {
      const pane = this.options.panes.getSession(paneId);
      return pane !== undefined && pane.archived !== true;
    });
  }

  /**
   * The open PR to view without a lookup: one this monitor still has open (even after the cache
   * moved on, so its merge is reported), or one the git status cache has open. A cached OPEN for a
   * PR this monitor saw close or merge is stale, so that Pane is looked up again instead.
   */
  private knownOpenPr(paneId: string): number | undefined {
    const tracked = this.tracked.get(paneId);
    if (tracked?.state === 'OPEN') return tracked.number;
    const cached = this.options.gitStatus.getCachedStatus(paneId)?.status;
    if (cached?.prNumber === undefined || cached.prState !== 'OPEN') return undefined;
    return tracked?.number === cached.prNumber ? undefined : cached.prNumber;
  }

  /** Looks the Pane's PR up by branch (`gh pr list --head`); its number when that PR is open. */
  private async discoverOpenPr(paneId: string): Promise<number | undefined> {
    const lookup = await this.options.gitStatus.lookupPrForPane(paneId);
    if (!lookup) return undefined;
    if (!lookup.ok) {
      const unavailable = githubUnavailableReason(decodeOptionalBoundary(lookup.error, ghFailureSchema));
      if (unavailable) throw new GithubUnavailableError(unavailable);
      return undefined;
    }
    return lookup.pr?.prState === 'OPEN' ? lookup.pr.prNumber : undefined;
  }

  private async view(paneId: string, prNumber: number): Promise<ReturnType<typeof prViewSchema.decode> | undefined> {
    const context = this.options.panes.getProjectContext(paneId);
    const cwd = this.options.panes.getSession(paneId)?.worktreePath ?? context?.project.path;
    if (!context || !cwd) return undefined;
    try {
      const result = await this.options.gitStatus.withGithubSlot(() => context.commandRunner.execFile(
        'gh',
        ['pr', 'view', String(prNumber), '--json', PR_VIEW_FIELDS],
        cwd,
        { timeout: GH_TIMEOUT_MS, silent: true },
      ));
      return decodeBoundary(JSON.parse(result.stdout), prViewSchema);
    } catch (error) {
      const unavailable = githubUnavailableReason(decodeOptionalBoundary(error, ghFailureSchema));
      if (unavailable) throw new GithubUnavailableError(unavailable);
      // One PR failing (deleted, or its repo moved) must not stop the others.
      return undefined;
    }
  }

  private observe(paneId: string, pr: ReturnType<typeof prViewSchema.decode>): void {
    const previous = this.tracked.get(paneId);
    const known = previous?.number === pr.number ? previous : undefined;
    const checks = summarizeChecks(pr.statusCheckRollup ?? []);
    const mergeable = pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : known?.mergeable;
    const settledChecks = checks.state === 'passed' || checks.state === 'failed'
      ? `${pr.headRefOid}:${checks.state}`
      : known?.settledChecks;
    this.tracked.set(paneId, { number: pr.number, state: pr.state, mergeable, settledChecks, checks: checks.state });
    if (!known) return;

    const reference: RunpaneWorkspacePullRequest = { number: pr.number, url: pr.url, headOid: pr.headRefOid };
    if (pr.state === 'MERGED') {
      if (known.state !== 'MERGED') this.append(paneId, { kind: 'pr.merged', pr: reference });
      return;
    }
    if (pr.state !== 'OPEN') return;
    if (mergeable === 'CONFLICTING' && known.mergeable !== 'CONFLICTING') {
      this.append(paneId, { kind: 'pr.conflicted', pr: reference });
    }
    if ((checks.state === 'passed' || checks.state === 'failed') && settledChecks !== known.settledChecks) {
      this.append(paneId, checks.state === 'failed'
        ? { kind: 'pr.checks', pr: reference, checks: 'failed', failingChecks: checks.failing }
        : { kind: 'pr.checks', pr: reference, checks: 'passed' });
    }
  }

  private append(
    paneId: string,
    entry: Pick<Parameters<WorkspaceJournal['appendPaneEntry']>[1], 'kind' | 'pr' | 'checks' | 'failingChecks'>,
  ): void {
    this.options.journal.appendPaneEntry(paneId, { ...entry, source: 'github' });
  }

  private schedule(): void {
    if (this.stopped) return;
    const base = this.failures === 0 ? this.intervalMs : Math.min(this.intervalMs * 2 ** this.failures, MAX_BACKOFF_MS);
    const delay = base + Math.floor(this.random() * POLL_JITTER_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollOnce()
        .catch(error => {
          this.options.logger?.warn('[SessionPrMonitor] PR poll failed', error instanceof Error ? error : undefined);
        })
        .finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }
}

/** Rolls check runs and commit statuses up to one state; failed only once every check has finished. */
function summarizeChecks(rollup: readonly PrCheck[]): ChecksSummary {
  if (rollup.length === 0) return { state: 'none', failing: [] };
  let pending = false;
  const failing: string[] = [];
  for (const check of rollup) {
    const isStatus = check.__typename === 'StatusContext' || (check.status == null && check.state != null);
    const name = (isStatus ? check.context : check.name) ?? check.name ?? check.context ?? 'check';
    if (isStatus) {
      if (check.state === 'PENDING' || check.state === 'EXPECTED') pending = true;
      else if (check.state === 'FAILURE' || check.state === 'ERROR') failing.push(name);
    } else if (check.status !== 'COMPLETED') {
      pending = true;
    } else if (check.conclusion && FAILED_CONCLUSIONS.has(check.conclusion)) {
      failing.push(name);
    }
  }
  if (pending) return { state: 'pending', failing: [] };
  if (failing.length > 0) return { state: 'failed', failing: [...new Set(failing)].slice(0, MAX_FAILING_CHECKS) };
  return { state: 'passed', failing: [] };
}

/** A reason every `gh` call will fail for now (not just this PR), or undefined. */
function githubUnavailableReason(failure: GhFailure | undefined): string | undefined {
  if (!failure) return undefined;
  const stderr = failure.stderr ?? '';
  if (failure.code === 'ENOENT') return 'the GitHub CLI (gh) is not installed';
  if (failure.killed) return `gh did not answer within ${GH_TIMEOUT_MS / 1000}s`;
  if (/rate limit/iu.test(stderr)) return 'GitHub API rate limit reached';
  if (/gh auth login|not logged in|authentication/iu.test(stderr)) return 'gh is not signed in (run gh auth login)';
  return undefined;
}
