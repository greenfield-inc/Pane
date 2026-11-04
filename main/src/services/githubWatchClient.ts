import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { boundary, decodeBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';

export interface GithubPrTarget { host: string; owner: string; repo: string; number: number }
const execFileAsync = promisify(execFile);
const BATCH_SIZE = 25;
const TOKEN_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const envelope = boundary.object({
  data: boundary.optional(boundary.nullable(boundary.jsonObject)),
  errors: boundary.optional(boundary.array(boundary.object({
    type: boundary.optional(boundary.string),
    message: boundary.string,
  }))),
});

export class GithubWatchError extends Error {
  constructor(message: string, readonly rateLimited = false, readonly retryAt = 0) { super(message); }
}

export function githubPrKey(target: GithubPrTarget): string {
  return `${target.host}/${target.owner}/${target.repo}/${target.number}`.toLowerCase();
}

interface Options {
  token?: (host: string) => Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}

/** One bounded request lane, per-host quota, and credentials shared by all PR watches. */
export class GithubWatchClient {
  private readonly credentials = new Map<string, { value: string; expires: number }>();
  private readonly waits = new Map<string, number>();
  private lane: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly options: Options = {}) { this.now = options.now ?? Date.now; }

  async fingerprints(targets: readonly GithubPrTarget[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const hosts = new Map<string, GithubPrTarget[]>();
    for (const target of targets) hosts.set(target.host, [...(hosts.get(target.host) ?? []), target]);
    for (const [host, group] of hosts) {
      for (let offset = 0; offset < group.length; offset += BATCH_SIZE) {
        const batch = group.slice(offset, offset + BATCH_SIZE);
        const selections = batch.map((pr, i) => `p${i}: repository(owner:${JSON.stringify(pr.owner)},name:${JSON.stringify(pr.repo)}) {
          pullRequest(number:${pr.number}) { state mergeable mergeStateStatus headRefOid baseRefName baseRef { id } updatedAt reviewDecision
            comments(last:100) { totalCount pageInfo { hasPreviousPage } nodes { id updatedAt } }
            reviews(last:100) { totalCount pageInfo { hasPreviousPage } nodes { id lastEditedAt state } }
            reviewThreads(last:100) { totalCount pageInfo { hasPreviousPage } nodes { id isResolved isOutdated comments(last:1) { totalCount nodes { id updatedAt } } } }
            commits(last:1) { nodes { commit { oid statusCheckRollup { state contexts(first:100) { totalCount pageInfo { hasNextPage }
              nodes { ... on CheckRun { id name status conclusion } ... on StatusContext { id context state } }
              checkRunCountsByState { state count } statusContextCountsByState { state count }
            } } } } }
          }
        }`).join('\n');
        const data = await this.query(host, `query { ${selections} }`, true);
        batch.forEach((pr, i) => {
          const repo = decodeBoundary(data[`p${i}`], boundary.nullable(boundary.object({ pullRequest: boundary.nullable(boundary.jsonObject) })));
          if (repo?.pullRequest) {
            const limits = decodeBoundary(repo.pullRequest, fingerprintLimitsSchema);
            const truncated = limits.comments?.pageInfo.hasPreviousPage || limits.reviews?.pageInfo.hasPreviousPage
              || limits.reviewThreads?.pageInfo.hasPreviousPage || limits.reviewThreads?.nodes.some(thread => thread.comments.totalCount > 1)
              || limits.commits?.nodes.some(node => node.commit.statusCheckRollup?.contexts.pageInfo.hasNextPage);
            // A bounded fingerprint must not hide changes outside its window. Such PRs
            // get a full read each round; ordinary small PRs retain the cheap path.
            result.set(githubPrKey(pr), JSON.stringify(repo.pullRequest) + (truncated ? `:${randomUUID()}` : ''));
          }
        });
      }
    }
    return result;
  }

  async details(target: GithubPrTarget): Promise<GithubPrDetails> {
    let cursor: string | undefined;
    let detail: GithubPrDetails | undefined;
    // Bound pathological repositories; incomplete checks can never report success.
    for (let page = 0; page < 20; page++) {
      const data = await this.query(target.host, `query {
        repository(owner:${JSON.stringify(target.owner)},name:${JSON.stringify(target.repo)}) {
          pullRequest(number:${target.number}) {
            number url state mergeable mergeStateStatus headRefOid baseRefName baseRef { id }
            comments(last:100) { pageInfo { hasPreviousPage } nodes { id updatedAt } }
            reviews(last:100) { pageInfo { hasPreviousPage } nodes { id submittedAt lastEditedAt state } }
            reviewThreads(last:100) { pageInfo { hasPreviousPage } nodes { id isResolved isOutdated comments(last:100) { pageInfo { hasPreviousPage } nodes { id updatedAt } } } }
            commits(last:1) { nodes { commit { oid statusCheckRollup { contexts(first:100${cursor ? `,after:${JSON.stringify(cursor)}` : ''}) {
              pageInfo { hasNextPage endCursor }
              nodes {
                __typename
                ... on CheckRun { name status conclusion isRequired(pullRequestNumber:${target.number}) }
                ... on StatusContext { context state isRequired(pullRequestNumber:${target.number}) }
              }
            } } } } }
          }
        }
      }`);
      const response = decodeBoundary(data, detailResponseSchema);
      const pr = response.repository?.pullRequest;
      if (!pr) throw new GithubWatchError('GitHub could not find this pull request. Check its URL and repository access.');
      const commit = pr.commits.nodes[0]?.commit;
      if (commit?.oid !== pr.headRefOid || (detail && detail.headRefOid !== pr.headRefOid)) {
        throw new GithubWatchError('The PR head changed during the read; checks will be read again.');
      }
      const contexts = commit.statusCheckRollup?.contexts;
      if (!detail) detail = {
        number: pr.number, url: pr.url, state: pr.state, mergeable: pr.mergeable,
        headRefOid: pr.headRefOid, mergeStateStatus: pr.mergeStateStatus, baseRefName: pr.baseRefName,
        // GitHub keeps baseRefName after the branch is deleted; only baseRef goes null.
        baseRefExists: pr.baseRef !== null, checks: [], complete: false,
        feedbackComplete: !pr.comments.pageInfo.hasPreviousPage && !pr.reviews.pageInfo.hasPreviousPage
          && !pr.reviewThreads.pageInfo.hasPreviousPage && pr.reviewThreads.nodes.every(thread => !thread.comments.pageInfo.hasPreviousPage),
        comments: [...pr.comments.nodes, ...pr.reviewThreads.nodes.flatMap(thread => thread.comments.nodes)]
          .map(comment => `${comment.id}:${comment.updatedAt}`),
        reviews: [...pr.reviews.nodes.map(review => `${review.id}:${review.submittedAt}:${review.lastEditedAt}:${review.state}`),
          ...pr.reviewThreads.nodes.map(thread => `thread:${thread.id}:${thread.isResolved}:${thread.isOutdated}`)],
      };
      detail.checks.push(...(contexts?.nodes ?? []));
      if (!contexts?.pageInfo.hasNextPage) { detail.complete = true; return detail; }
      cursor = contexts.pageInfo.endCursor ?? undefined;
      if (!cursor) break;
    }
    if (!detail) throw new GithubWatchError('GitHub returned no PR details.');
    return detail;
  }

  private query(host: string, query: string, partial = false): Promise<JsonObject> {
    const work = this.lane.then(() => this.request(host, query, false, partial));
    this.lane = work.catch(() => undefined);
    return work;
  }

  private async request(host: string, query: string, refreshed = false, partial = false): Promise<JsonObject> {
    const retryAt = this.waits.get(host) ?? 0;
    if (retryAt > this.now()) throw new GithubWatchError('GitHub quota reserved for interactive use; watching resumes after reset.', true, retryAt);
    let credential = this.credentials.get(host);
    if (!credential || credential.expires <= this.now()) {
      try {
        const value = this.options.token ? await this.options.token(host)
          : (await execFileAsync('gh', ['auth', 'token', '--hostname', host], { timeout: 10_000, maxBuffer: 65536 })).stdout.trim();
        if (!value) throw new Error('empty credential');
        credential = { value, expires: this.now() + TOKEN_TTL_MS };
        this.credentials.set(host, credential);
      } catch {
        throw new GithubWatchError(`Cannot authenticate to ${host}. Install gh and run gh auth login --hostname ${host}; watching will retry.`);
      }
    }
    const url = host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST', headers: { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'error',
      });
    } catch { throw new GithubWatchError(`GitHub request to ${host} failed or exceeded 30 seconds; watching will retry.`); }
    if (response.status === 401) {
      this.credentials.delete(host);
      if (!refreshed) return this.request(host, query, true, partial);
      throw new GithubWatchError(`GitHub rejected authentication for ${host}. Run gh auth login --hostname ${host}.`);
    }
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const limit = Number(response.headers.get('x-ratelimit-limit'));
    const retry = response.headers.get('retry-after');
    const retryTime = retry ? (/^\d+$/u.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
    const reserve = limit > 0 && remaining <= Math.ceil(limit * 0.1);
    const wait = Math.max(this.now() + 60_000, Number.isFinite(reset) ? reset : 0, Number.isFinite(retryTime) ? retryTime : 0);
    if (reserve || retry || response.status === 429) this.waits.set(host, wait);
    if (response.status === 429 || (response.status === 403 && (reserve || retry))) {
      throw new GithubWatchError(`GitHub rate limited ${host}; watching resumes after the server's wait.`, true, wait);
    }
    if (!response.ok) throw new GithubWatchError(`GitHub returned HTTP ${response.status} for ${host}; watching will retry.`);
    let payload: ReturnType<typeof envelope.decode>;
    try { payload = decodeBoundary(await response.json(), envelope); }
    catch { throw new GithubWatchError('GitHub returned an invalid response; watching will retry.'); }
    if (payload.errors?.length) {
      if (payload.errors.some(error => error.type === 'RATE_LIMITED' || /rate limit/iu.test(error.message))) {
        this.waits.set(host, wait);
        throw new GithubWatchError('GitHub GraphQL rate limit reached; watching resumes after reset.', true, wait);
      }
      if (partial && payload.data) return payload.data;
      // Never include server text: it can echo request details or private repository contents.
      throw new GithubWatchError('GitHub GraphQL could not complete the read. Check repository access; watching will retry.');
    }
    if (!payload.data) throw new GithubWatchError('GitHub returned no data; watching will retry.');
    return payload.data;
  }
}

const previousPageSchema = boundary.object({ hasPreviousPage: boundary.boolean });
const fingerprintLimitsSchema = boundary.object({
  comments: boundary.optional(boundary.object({ pageInfo: previousPageSchema })),
  reviews: boundary.optional(boundary.object({ pageInfo: previousPageSchema })),
  reviewThreads: boundary.optional(boundary.object({ pageInfo: previousPageSchema,
    nodes: boundary.array(boundary.object({ comments: boundary.object({ totalCount: boundary.number }) })),
  })),
  commits: boundary.optional(boundary.object({ nodes: boundary.array(boundary.object({ commit: boundary.object({
    statusCheckRollup: boundary.nullable(boundary.object({ contexts: boundary.object({ pageInfo: boundary.object({ hasNextPage: boundary.boolean }) }) })),
  }) })) })),
});
const commentSchema = boundary.object({ id: boundary.string, updatedAt: boundary.string });
const checkSchema = boundary.object({
  __typename: boundary.string, name: boundary.optional(boundary.string), context: boundary.optional(boundary.string),
  status: boundary.optional(boundary.string), conclusion: boundary.optional(boundary.nullable(boundary.string)),
  state: boundary.optional(boundary.string), isRequired: boundary.boolean,
});
const detailResponseSchema = boundary.object({
  repository: boundary.nullable(boundary.object({ pullRequest: boundary.nullable(boundary.object({
    number: boundary.number, url: boundary.string, state: boundary.string,
    mergeable: boundary.string, mergeStateStatus: boundary.string, headRefOid: boundary.string,
    baseRefName: boundary.string, baseRef: boundary.nullable(boundary.object({ id: boundary.string })),
    comments: boundary.object({ pageInfo: previousPageSchema, nodes: boundary.array(commentSchema) }),
    reviews: boundary.object({ pageInfo: previousPageSchema, nodes: boundary.array(boundary.object({
      id: boundary.string, submittedAt: boundary.nullable(boundary.string), lastEditedAt: boundary.nullable(boundary.string), state: boundary.string,
    })) }),
    reviewThreads: boundary.object({ pageInfo: previousPageSchema, nodes: boundary.array(boundary.object({
      id: boundary.string, isResolved: boundary.boolean, isOutdated: boundary.boolean,
      comments: boundary.object({ pageInfo: previousPageSchema, nodes: boundary.array(commentSchema) }),
    })) }),
    commits: boundary.object({ nodes: boundary.array(boundary.object({ commit: boundary.object({
      oid: boundary.string,
      statusCheckRollup: boundary.nullable(boundary.object({ contexts: boundary.object({
        pageInfo: boundary.object({ hasNextPage: boundary.boolean, endCursor: boundary.nullable(boundary.string) }),
        nodes: boundary.array(checkSchema),
      }) })),
    }) })) }),
  })) })),
});
export interface GithubPrDetails {
  number: number; url: string; state: string; mergeable: string; headRefOid: string;
  mergeStateStatus: string;
  baseRefName: string; baseRefExists: boolean;
  checks: Array<ReturnType<typeof checkSchema.decode>>; complete: boolean;
  feedbackComplete: boolean;
  comments: string[]; reviews: string[];
}
