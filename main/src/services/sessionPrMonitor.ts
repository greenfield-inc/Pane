import type { GitStatusManager } from './gitStatusManager';
import type { OrchestrationSessionManager } from './orchestrationSessionManager';
import type { SessionManager } from './sessionManager';
import type { WorkspaceJournal } from './workspaceJournal';
import type { Logger } from '../utils/logger';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';
import { GithubWatchClient, GithubWatchError, githubPrKey, type GithubPrDetails, type GithubPrTarget } from './githubWatchClient';

const SESSION_PR_POLL_INTERVAL_MS = 2 * 60_000;
const FULL_READ_BACKSTOP_MS = 30 * 60_000;
const MAX_ERRORS = 8;
const MAX_COMMENT_WAKES = 10;
const MAX_WATCHES = 512;
const failedConclusions = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const targetSchema = boundary.object({ host: boundary.string, owner: boundary.string, repo: boundary.string, number: boundary.number });
const discoverySchema = boundary.object({ paneId: boundary.string, failures: boundary.number, retryAt: boundary.number });
const baselineSchema = boundary.object({
  state: boundary.string, head: boundary.string, mergeable: boundary.string,
  failed: boundary.array(boundary.string), passed: boundary.boolean,
  feedbackComplete: boundary.optional(boundary.boolean),
  base: boundary.optional(boundary.string), baseExists: boundary.optional(boundary.boolean),
  comments: boundary.array(boundary.string), reviews: boundary.array(boundary.string),
});
const recordSchema = boundary.object({
  paneId: boundary.string, target: targetSchema, explicit: boundary.boolean,
  registrationGeneration: boundary.optional(boundary.number),
  head: boundary.optional(boundary.string), fingerprint: boundary.optional(boundary.string),
  baseline: boundary.optional(baselineSchema), fullReadAt: boundary.number,
  errors: boundary.number, commentWakes: boundary.number, unavailable: boundary.boolean,
  retryAt: boundary.number, stopped: boundary.optional(boundary.string),
});
type DecodedRecord = ReturnType<typeof recordSchema.decode>;
type WatchRecord = { -readonly [K in keyof DecodedRecord]: DecodedRecord[K] };
interface WatchRegistration { epoch: string; generation: number; watch: WatchRecord }
type Event = Omit<RunpaneWorkspaceEntry, 'gen' | 'at' | 'paneName'>;
interface Options {
  sessions: Pick<OrchestrationSessionManager, 'activeMemberPaneIds'>;
  panes: Pick<SessionManager, 'getSession'>;
  gitStatus: Pick<GitStatusManager, 'getCachedStatus' | 'lookupPrForPane'>;
  journal: WorkspaceJournal;
  client?: Pick<GithubWatchClient, 'fingerprints' | 'details'>;
  logger?: Pick<Logger, 'info' | 'warn'>;
  intervalMs?: number;
  random?: () => number;
  now?: () => number;
}

function parseGithubPrUrl(value: string): GithubPrTarget {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidUrl(); }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/u.exec(url.pathname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !match
    || !/^[a-z0-9.-]+$/iu.test(url.hostname) || !Number.isSafeInteger(Number(match[3]))
    || !/^[\w.-]+$/u.test(match[1]) || !/^[\w.-]+$/u.test(match[2])) throw invalidUrl();
  return { host: url.hostname.toLowerCase(), owner: match[1], repo: match[2], number: Number(match[3]) };
}
function invalidUrl(): PaneError {
  return new PaneError('ERR_PR_WATCH_URL', 'The PR watch URL is invalid. Nothing was registered.', 'Use https://github.com/owner/repo/pull/123 (or your GitHub Enterprise host).');
}
function key(paneId: string, target: GithubPrTarget): string { return `${paneId}:${githubPrKey(target)}`; }

/** Session discovery and explicit standalone watches share batched reads and durable transitions. */
export class SessionPrMonitor {
  private records: Map<string, WatchRecord>;
  private discoveryFailures = new Map<string, ReturnType<typeof discoverySchema.decode>>();
  private readonly client: Pick<GithubWatchClient, 'fingerprints' | 'details'>;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = true;
  private stopCount = 0;

  constructor(private readonly options: Options) {
    this.client = options.client ?? new GithubWatchClient();
    this.now = options.now ?? Date.now;
    const saved = options.journal.githubState.watches;
    const records = saved === undefined ? [] : decodeBoundary(saved, boundary.array(recordSchema));
    this.records = new Map(records.map(record => [key(record.paneId, record.target), record]));
    this.restoreDiscovery();
  }

  watch(paneId: string, url: string, head?: string): WatchRegistration {
    const pane = this.options.panes.getSession(paneId);
    if (!pane || pane.archived) throw new PaneError('ERR_PR_WATCH_PANE', 'The Pane is missing or archived. No watch was registered.', 'Select an active Pane with runpane panes list.');
    if (head !== undefined && !/^[a-f0-9]{40}$/iu.test(head)) throw new PaneError('ERR_PR_WATCH_HEAD', 'The head pin must be a full 40-character commit SHA. Nothing was registered.', 'Read the PR head SHA and pass it with --head.');
    const target = parseGithubPrUrl(url);
    const identity = key(paneId, target);
    const existing = this.records.get(identity);
    if (existing?.explicit && !existing.stopped && ((!head && existing.head === existing.baseline?.head) || head?.toLowerCase() === existing.head)) {
      // An idempotent retry may follow a lost response: never acknowledge unread events.
      // Legacy records have no watermark; replay from zero so retention loss is explicit.
      return { epoch: this.options.journal.epoch, generation: existing.registrationGeneration ?? 0, watch: existing };
    }
    if (!existing && this.records.size >= MAX_WATCHES) {
      const finished = [...this.records].find(([, value]) => value.stopped);
      if (finished) this.records.delete(finished[0]);
    }
    if (!existing && this.records.size >= MAX_WATCHES) throw new PaneError('ERR_PR_WATCH_CAPACITY', 'The watch registry is full. Nothing was registered.', 'Remove unused registrations with runpane pr unwatch.');
    const record: WatchRecord = { paneId, target, explicit: true, registrationGeneration: this.options.journal.generation, head: head?.toLowerCase(), fingerprint: undefined, baseline: undefined,
      fullReadAt: 0, errors: 0, commentWakes: 0, unavailable: false, retryAt: 0, stopped: undefined };
    this.records.set(identity, record);
    this.commit([]);
    const generation = this.options.journal.generation;
    // Registration returns its cursor before the first observation; no network call blocks the CLI.
    if (!this.stopped) this.schedule(0);
    return { epoch: this.options.journal.epoch, generation, watch: record };
  }

  unwatch(paneId: string, url: string): boolean {
    const removed = this.records.delete(key(paneId, parseGithubPrUrl(url)));
    this.commit([]);
    return removed;
  }

  list(paneId?: string): WatchRecord[] {
    return [...this.records.values()].filter(record => !paneId || record.paneId === paneId).map(record => structuredClone(record));
  }

  start(): void { if (this.stopped) { this.stopped = false; this.schedule(0); } }
  stop(): void { this.stopped = true; this.stopCount++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const stopCount = this.stopCount;
    try {
      await this.discover();
      if (stopCount !== this.stopCount) return;
      const hosts = new Map<string, WatchRecord[]>();
      const members = new Set(this.options.sessions.activeMemberPaneIds());
      for (const [identity, record] of this.records) {
        const pane = this.options.panes.getSession(record.paneId);
        if (!pane || pane.archived || (!record.explicit && !members.has(record.paneId))) {
          this.records.delete(identity); continue;
        }
        if (record.stopped || record.retryAt > this.now()) continue;
        hosts.set(record.target.host, [...(hosts.get(record.target.host) ?? []), record]);
      }
      this.commit([]);
      for (const records of hosts.values()) {
        if (stopCount !== this.stopCount) return;
        const targets = [...new Map(records.map(record => [githubPrKey(record.target), record.target])).values()];
        let fingerprints: Map<string, string>;
        try { fingerprints = await this.client.fingerprints(targets); }
        catch (error) { for (const record of records) this.failure(record, error instanceof GithubWatchError ? error : new GithubWatchError('GitHub PR read failed; watching will retry.')); continue; }
        const details = new Map<string, GithubPrDetails>();
        for (const record of records) {
          if (stopCount !== this.stopCount) return;
          // An unwatch during a request must not resurrect its registration or emit another event.
          if (this.records.get(key(record.paneId, record.target)) !== record) continue;
          const fingerprint = fingerprints.get(githubPrKey(record.target));
          try {
            if (!fingerprint) throw new GithubWatchError('The PR no longer exists or is inaccessible. Check repository access.');
            if (record.fingerprint !== fingerprint || this.now() - record.fullReadAt >= FULL_READ_BACKSTOP_MS) {
              const identity = githubPrKey(record.target);
              const pr = details.get(identity) ?? await this.client.details(record.target);
              if (stopCount !== this.stopCount || this.records.get(key(record.paneId, record.target)) !== record) continue;
              details.set(identity, pr);
              this.observe(record, pr, fingerprint);
            } else if (record.unavailable) {
              record.errors = 0; record.unavailable = false;
              this.commit([this.event(record, 'github.recovered', 'GitHub reads resumed.')]);
            }
          } catch (error) { this.failure(record, error instanceof GithubWatchError ? error : new GithubWatchError('GitHub PR read failed; watching will retry.')); }
        }
      }
    } finally { this.running = false; }
  }

  private async discover(): Promise<void> {
    const members = new Set(this.options.sessions.activeMemberPaneIds());
    for (const paneId of this.discoveryFailures.keys()) if (!members.has(paneId)) this.discoveryFailures.delete(paneId);
    for (const paneId of members) {
      const pane = this.options.panes.getSession(paneId);
      if (!pane || pane.archived) continue;
      if ([...this.records.values()].some(record => record.paneId === paneId && !record.explicit && !record.stopped)) continue;
      const cached = this.options.gitStatus.getCachedStatus(paneId)?.status;
      let url = cached?.prState === 'OPEN' ? cached.prUrl : undefined;
      if (!url || [...this.records.values()].some(record => record.paneId === paneId && record.stopped)) {
        const failure = this.discoveryFailures.get(paneId);
        if (failure && failure.retryAt > this.now()) continue;
        const result = await this.options.gitStatus.lookupPrForPane(paneId);
        if (result && !result.ok) {
          const failures = (failure?.failures ?? 0) + 1;
          this.discoveryFailures.set(paneId, { paneId, failures, retryAt: this.now() + Math.min(3600000, SESSION_PR_POLL_INTERVAL_MS * 2 ** Math.min(failures, 5)) });
          this.commit(failure ? [] : [{ paneId, source: 'github', kind: 'github.unavailable', reason: 'GitHub branch discovery failed. Check gh authentication and repository access; discovery will retry.' }]);
          continue;
        }
        if (result?.ok && failure) {
          this.discoveryFailures.delete(paneId);
          this.commit([{ paneId, source: 'github', kind: 'github.recovered', reason: 'GitHub branch discovery resumed.' }]);
        }
        if (!result?.ok || result.pr?.prState !== 'OPEN') continue;
        url = result.pr.prUrl;
      }
      if (!url) continue;
      const target = parseGithubPrUrl(url);
      const identity = key(paneId, target);
      const existing = this.records.get(identity);
      if (existing && (existing.explicit || existing.stopped !== 'closed')) continue;
      if (this.records.size >= MAX_WATCHES) continue;
      this.records.set(identity, { paneId, target, explicit: false, registrationGeneration: undefined, head: undefined, fingerprint: undefined,
        baseline: existing?.baseline, fullReadAt: 0, errors: 0, commentWakes: 0, unavailable: false, retryAt: 0, stopped: undefined });
    }
  }

  private observe(record: WatchRecord, pr: GithubPrDetails, fingerprint: string): void {
    const previous = record.baseline;
    const failures = [...new Set(pr.checks.filter(check => check.__typename === 'StatusContext'
      ? check.state === 'FAILURE' || check.state === 'ERROR'
      : Boolean(check.conclusion && failedConclusions.has(check.conclusion))).map(check => check.name ?? check.context ?? 'check'))].sort();
    const required = pr.checks.filter(check => check.isRequired);
    const relevant = required.length ? required : pr.checks;
    const passed = pr.complete && pr.feedbackComplete && relevant.length > 0 && ['CLEAN', 'UNSTABLE'].includes(pr.mergeStateStatus)
      && relevant.every(check => check.__typename === 'StatusContext' ? check.state === 'SUCCESS'
        : check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? ''));
    if (record.explicit && !record.head) record.head = pr.headRefOid;
    const events: Event[] = [];
    const event = (kind: Event['kind'], reason?: string): Event => ({ ...this.event(record, kind, reason), pr: { number: pr.number, url: pr.url, headOid: pr.headRefOid } });
    if (record.unavailable) events.push(event('github.recovered', 'GitHub reads resumed.'));
    const previousHead = previous?.head ?? record.head;
    if (previousHead && previousHead !== pr.headRefOid) events.push(event('pr.head', 'The PR head changed. Recheck this commit and register its SHA before accepting success.'));
    // Baselines written before base tracking have no base; their first read records it silently.
    const previousBase = previous?.base;
    if (previousBase !== undefined && previous?.baseExists !== false && !pr.baseRefExists) events.push({
      ...event('pr.base_deleted', `The base branch ${previousBase} was deleted. GitHub may close the PR; retarget it to a live branch, rebase, and recheck CI.`),
      base: { from: previousBase, to: pr.baseRefName },
    });
    else if (previousBase !== undefined && previousBase !== pr.baseRefName) events.push({
      ...event('pr.base_changed', `The base changed from ${previousBase} to ${pr.baseRefName}. Rebase onto ${pr.baseRefName}, resolve conflicts, and recheck CI.`),
      base: { from: previousBase, to: pr.baseRefName },
    });
    if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
      if (previous?.state !== pr.state) events.push(event(pr.state === 'MERGED' ? 'pr.merged' : 'pr.closed'));
      record.stopped = pr.state === 'MERGED' ? 'merged' : 'closed';
    } else {
      if (!pr.feedbackComplete && previous?.feedbackComplete !== false) events.push(event('pr.review', 'Discussion exceeds the watch read limit. Feedback is incomplete and success is withheld; read the full PR discussion on GitHub.'));
      if (pr.mergeable === 'CONFLICTING' && previous?.mergeable !== 'CONFLICTING') events.push(event('pr.conflicted'));
      const newFailures = failures.filter(name => previous?.head !== pr.headRefOid || !previous.failed.includes(name));
      if (newFailures.length) events.push({ ...event('pr.checks'), checks: 'failed', failingChecks: newFailures });
      if (passed && (!record.head || record.head === pr.headRefOid) && (!previous?.passed || previous.head !== pr.headRefOid)) events.push({
        ...event('pr.checks', 'Checks passed on the pinned head. Review any optional failures and remaining merge requirements.'), checks: 'passed',
      });
      if (previous && pr.reviews.some(review => !previous.reviews.includes(review))) events.push(event('pr.review', 'A review changed; read the PR review before acting.'));
      if (previous && pr.comments.some(comment => !previous.comments.includes(comment))) events.push(event('pr.comment', 'A comment changed; read the PR discussion before acting.'));
      const news = events.filter(entry => !entry.kind.startsWith('github.'));
      if (news.length) record.commentWakes = news.every(entry => entry.kind === 'pr.comment') ? record.commentWakes + 1 : 0;
      if (record.commentWakes >= MAX_COMMENT_WAKES) {
        record.stopped = 'comment-limit';
        events.push(event('pr.stopped', 'Watch stopped after 10 comment-only updates. Read the discussion, then register again if more work remains.'));
      }
    }
    record.baseline = { state: pr.state, head: pr.headRefOid, mergeable: pr.mergeable === 'UNKNOWN' ? previous?.mergeable ?? 'UNKNOWN' : pr.mergeable,
      failed: failures, passed: passed && (!record.head || record.head === pr.headRefOid), feedbackComplete: pr.feedbackComplete,
      base: pr.baseRefName, baseExists: pr.baseRefExists, comments: pr.comments, reviews: pr.reviews };
    record.fingerprint = fingerprint; record.fullReadAt = this.now(); record.errors = 0; record.retryAt = 0; record.unavailable = false;
    this.commit(events);
  }

  private event(record: WatchRecord, kind: Event['kind'], reason?: string): Event {
    return { paneId: record.paneId, source: 'github', kind, reason,
      pr: { number: record.target.number, url: `https://${record.target.host}/${record.target.owner}/${record.target.repo}/pull/${record.target.number}`, headOid: record.baseline?.head ?? record.head ?? '' } };
  }

  private failure(record: WatchRecord, failure: GithubWatchError): void {
    if (this.records.get(key(record.paneId, record.target)) !== record) return;
    const events: Event[] = [];
    if (!record.unavailable) events.push(this.event(record, 'github.unavailable', failure.message));
    record.unavailable = true;
    if (!failure.rateLimited) record.errors++;
    record.retryAt = failure.rateLimited ? failure.retryAt : this.now() + Math.min(60 * 60_000, (this.options.intervalMs ?? SESSION_PR_POLL_INTERVAL_MS) * 2 ** record.errors);
    if (record.errors >= MAX_ERRORS) {
      record.stopped = 'error-limit';
      events.push(this.event(record, 'pr.stopped', 'Watch stopped after 8 failed reads. Check GitHub access, then register again.'));
    }
    this.commit(events);
  }

  private commit(events: Event[]): void {
    try {
      this.options.journal.commitGithubState(decodeBoundary(JSON.parse(JSON.stringify({ watches: [...this.records.values()], discoveryFailures: [...this.discoveryFailures.values()] })), boundary.jsonObject), events);
    } catch (error) {
      // A failed durable write cannot consume a transition in memory.
      const saved = decodeBoundary(this.options.journal.githubState.watches ?? [], boundary.array(recordSchema));
      this.records = new Map(saved.map(record => [key(record.paneId, record.target), record]));
      this.restoreDiscovery();
      throw error;
    }
  }

  private restoreDiscovery(): void {
    const failures = decodeBoundary(this.options.journal.githubState.discoveryFailures ?? [], boundary.array(discoverySchema));
    this.discoveryFailures = new Map(failures.map(failure => [failure.paneId, failure]));
  }

  private schedule(delay = this.options.intervalMs ?? SESSION_PR_POLL_INTERVAL_MS): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollOnce().catch(error => this.options.logger?.warn('[SessionPrMonitor] Poll failed', error instanceof Error ? error : undefined))
        .finally(() => this.schedule());
    }, delay + Math.floor((this.options.random ?? Math.random)() * (delay ? 10_000 : 0)));
    this.timer.unref?.();
  }
}
