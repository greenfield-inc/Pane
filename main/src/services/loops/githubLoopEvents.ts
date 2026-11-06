import type { LoopGithubEvent } from '../../../../shared/types/loop';
import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/** A conditional GitHub REST read: `GithubWatchClient.rest`. */
export type GithubRestRead = (host: string, path: string, etag?: string) => Promise<{ changed: false } | { changed: true; etag: string | null; body: JsonValue }>;

/** What the loops watching one repo ask for; the source reads nothing else. */
export interface GithubEventWants {
  comments?: boolean;
  reviews?: boolean;
  checks?: boolean;
  prs?: boolean;
  labels?: boolean;
}

export interface GithubEventCandidate {
  event: LoopGithubEvent;
  /** The actor is the repo's owner, a member of its organization, or a collaborator. A check run or a label (which needs triage access) counts as one. */
  collaborator: boolean;
  /** A review's verdict, such as `CHANGES_REQUESTED`. */
  reviewState?: string;
  /** The label a `label` event added. */
  label?: string;
}

/** Events older than this are never listed: a host asleep for days comes back to a short list. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const PAGE = 50;
const HOST = 'github.com';
const COLLABORATOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const TEXT_LIMIT = 4000;

const login = boundary.optional(boundary.nullable(boundary.object({ login: boundary.string })));
const commentSchema = boundary.object({
  id: boundary.number, html_url: boundary.string, issue_url: boundary.string, body: boundary.optional(boundary.nullable(boundary.string)),
  created_at: boundary.string, user: login, author_association: boundary.optional(boundary.string),
});
const pullSchema = boundary.object({
  number: boundary.number, html_url: boundary.string, title: boundary.string, body: boundary.optional(boundary.nullable(boundary.string)),
  created_at: boundary.string, updated_at: boundary.string, author_association: boundary.optional(boundary.string), user: login,
  head: boundary.object({ ref: boundary.string, sha: boundary.string, repo: boundary.optional(boundary.nullable(boundary.object({ full_name: boundary.string }))) }),
});
const reviewSchema = boundary.object({
  id: boundary.number, state: boundary.string, body: boundary.optional(boundary.nullable(boundary.string)),
  submitted_at: boundary.optional(boundary.nullable(boundary.string)), user: login, author_association: boundary.optional(boundary.string),
  html_url: boundary.optional(boundary.string),
});
const checkRunsSchema = boundary.object({ check_runs: boundary.array(boundary.json) });
const checkRunSchema = boundary.object({
  id: boundary.number, name: boundary.string, status: boundary.string, conclusion: boundary.optional(boundary.nullable(boundary.string)),
  completed_at: boundary.optional(boundary.nullable(boundary.string)), html_url: boundary.optional(boundary.nullable(boundary.string)),
});
const issueEventSchema = boundary.object({
  id: boundary.number, event: boundary.string, created_at: boundary.string, actor: login,
  label: boundary.optional(boundary.nullable(boundary.object({ name: boundary.string }))),
  issue: boundary.optional(boundary.nullable(boundary.object({
    number: boundary.number, html_url: boundary.string, title: boundary.string, body: boundary.optional(boundary.nullable(boundary.string)),
    pull_request: boundary.optional(boundary.json),
  }))),
});

type Pull = ReturnType<typeof pullSchema.decode>;

/**
 * Polls a repo for the events loops start from, with conditional requests:
 * GitHub answers an unchanged list with 304, which costs no rate limit, and
 * the last answer is reused. Returns every recent event, oldest first; which
 * ones start runs is the loop's call.
 */
export class GithubLoopEventSource {
  private readonly cache = new Map<string, { etag: string | null; body: JsonValue }>();

  constructor(private readonly rest: GithubRestRead, private readonly now: () => number = Date.now) {}

  async poll(repo: string, wants: GithubEventWants): Promise<GithubEventCandidate[]> {
    const since = this.now() - LOOKBACK_MS;
    const candidates: GithubEventCandidate[] = [];
    const needPulls = wants.prs || wants.reviews || wants.checks || wants.comments;
    const pulls = needPulls ? items(await this.read(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PAGE}`), pullSchema) : [];
    const pullByNumber = new Map(pulls.map(pull => [pull.number, pull]));
    const recentPulls = pulls.filter(pull => Date.parse(pull.updated_at) >= since);

    if (wants.prs) {
      for (const pull of pulls) {
        candidates.push({
          event: { ...prContext(repo, pull), key: `pr:${pull.number}`, kind: 'pr', number: pull.number, isPr: true, url: pull.html_url,
            author: pull.user?.login ?? null, atMs: Date.parse(pull.created_at), summary: `Opened PR #${pull.number}: ${pull.title}`,
            text: clip(`${pull.title}\n\n${pull.body ?? ''}`) },
          collaborator: COLLABORATOR_ASSOCIATIONS.has(pull.author_association ?? ''),
        });
      }
    }
    if (wants.comments) {
      for (const comment of items(await this.read(`/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=${PAGE}`), commentSchema)) {
        if (!comment.html_url.includes('/pull/')) continue;
        const number = Number(comment.issue_url.split('/').pop());
        const pull = pullByNumber.get(number);
        candidates.push({
          event: { ...(pull ? prContext(repo, pull) : {}), key: `comment:${comment.id}`, kind: 'comment', repo, number, isPr: true, url: comment.html_url,
            author: comment.user?.login ?? null, atMs: Date.parse(comment.created_at), summary: `Comment by @${comment.user?.login ?? 'ghost'}`,
            text: clip(comment.body ?? '') },
          collaborator: COLLABORATOR_ASSOCIATIONS.has(comment.author_association ?? ''),
        });
      }
    }
    for (const pull of recentPulls) {
      if (wants.reviews || wants.comments) {
        for (const review of items(await this.read(`/repos/${repo}/pulls/${pull.number}/reviews?per_page=${PAGE}`), reviewSchema)) {
          if (!review.submitted_at) continue;
          const reviewer = review.user?.login ?? 'ghost';
          candidates.push({
            event: { ...prContext(repo, pull), key: `review:${review.id}`, kind: 'review', number: pull.number, isPr: true, url: review.html_url ?? pull.html_url,
              author: review.user?.login ?? null, atMs: Date.parse(review.submitted_at),
              summary: review.state === 'CHANGES_REQUESTED' ? `@${reviewer} requested changes` : `Review by @${reviewer}`, text: clip(review.body ?? '') },
            collaborator: COLLABORATOR_ASSOCIATIONS.has(review.author_association ?? ''),
            reviewState: review.state,
          });
        }
      }
      if (wants.checks) {
        const runs = decodeOr(await this.read(`/repos/${repo}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=${PAGE}`), checkRunsSchema)?.check_runs ?? [];
        for (const run of items(runs, checkRunSchema)) {
          if (run.status !== 'completed' || !FAILED_CONCLUSIONS.has(run.conclusion ?? '') || !run.completed_at) continue;
          candidates.push({
            event: { ...prContext(repo, pull), key: `check:${run.id}`, kind: 'check', number: pull.number, isPr: true, url: run.html_url ?? pull.html_url,
              author: null, atMs: Date.parse(run.completed_at), summary: `Check "${run.name}" failed` },
            collaborator: true,
          });
        }
      }
    }
    if (wants.labels) {
      for (const labeled of items(await this.read(`/repos/${repo}/issues/events?per_page=${PAGE}`), issueEventSchema)) {
        if (labeled.event !== 'labeled' || !labeled.label || !labeled.issue) continue;
        const { issue } = labeled;
        const isPr = issue.pull_request !== undefined;
        const pull = isPr ? pullByNumber.get(issue.number) : undefined;
        candidates.push({
          event: { ...(pull ? prContext(repo, pull) : {}), key: `label:${labeled.id}`, kind: 'label', repo, number: issue.number, isPr, url: issue.html_url,
            author: labeled.actor?.login ?? null, atMs: Date.parse(labeled.created_at), summary: `Labeled ${labeled.label.name}`,
            text: clip(`${issue.title}\n\n${issue.body ?? ''}`) },
          collaborator: true,
          label: labeled.label.name,
        });
      }
    }
    return candidates
      .filter(candidate => Number.isFinite(candidate.event.atMs) && candidate.event.atMs >= since)
      .sort((a, b) => a.event.atMs - b.event.atMs);
  }

  private async read(path: string): Promise<JsonValue> {
    const cached = this.cache.get(path);
    const result = await this.rest(HOST, path, cached?.etag ?? undefined);
    if (!result.changed) return cached?.body ?? [];
    this.cache.set(path, { etag: result.etag, body: result.body });
    return result.body;
  }
}

/** The PR facts a run needs: its head branch when the branch lives in `repo`, and whether it comes from a fork. */
function prContext(repo: string, pull: Pull): Pick<LoopGithubEvent, 'repo' | 'headRef' | 'fork'> {
  const fork = (pull.head.repo?.full_name ?? '').toLowerCase() !== repo.toLowerCase();
  return { repo, fork, ...(fork ? {} : { headRef: pull.head.ref }) };
}

function items<T>(value: JsonValue, schema: BoundarySchema<T>): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const decoded = decodeOr(item, schema);
    return decoded === undefined ? [] : [decoded];
  });
}

function decodeOr<T>(value: JsonValue, schema: BoundarySchema<T>): T | undefined {
  try {
    return decodeBoundary(value, schema);
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TEXT_LIMIT ? `${trimmed.slice(0, TEXT_LIMIT)}…` : trimmed;
}
