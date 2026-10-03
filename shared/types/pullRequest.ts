/**
 * Opening a pull request from inside Pane.
 *
 * A session already *is* a branch in a worktree, so everything a pull request
 * needs is on hand — the only missing pieces were the target repository (a fork
 * has two candidates) and the text. Both are decided in the dialog and sent
 * here; the main process does the pushing and calls `gh`.
 */

import type { GitCommitFileChange } from './git';

/** A repository a pull request could be opened against. */
export interface PullRequestTarget {
  /** `owner/repo`, as GitHub names it. */
  nameWithOwner: string;
  /** True for the repository this clone was forked from. */
  isParent: boolean;
  /** Default branch of that repository, when known. */
  defaultBranch?: string;
}

/** Base candidates for one repository, split by how likely you are to want them. */
export interface BaseBranchOptions {
  /** Every branch the target repository has, as far as we could see. */
  all: string[];
  /** Those this clone tracks locally — fetched or pushed by you. */
  local: string[];
}

/** An existing pull request for the session's branch. */
export interface ExistingPullRequest {
  number: number;
  url: string;
  /** `OPEN`, `MERGED`, `CLOSED` — as reported by the provider. */
  state: string;
  title: string;
}

/**
 * Everything the dialog needs to open with sensible values, gathered in one
 * round trip: a second one would leave the form visibly filling itself in.
 */
export interface PullRequestDraft {
  branch: string;
  /** Base as GitHub names it — never a tracking ref like `origin/main`. */
  baseBranch: string;
  /** Branches of the default target, as candidates for the base. */
  baseBranches: string[];
  /**
   * The subset this clone already knows — the branches you fetched or pushed
   * yourself. A busy upstream has hundreds; those are what you actually pick.
   */
  localBaseBranches: string[];
  /** Suggested title — the first commit's subject. */
  title: string;
  /** Suggested body: remaining commit messages, plus the repo's PR template. */
  body: string;
  /** Commits this branch has that the base does not. */
  commitCount: number;
  hasUncommittedChanges: boolean;
  targets: PullRequestTarget[];
  defaultTarget: string;
  existing?: ExistingPullRequest;
  /**
   * Reasons the button must stay disabled, in plain language. Empty means the
   * pull request can be created.
   */
  blockers: string[];
}

/**
 * What the pull request would actually contain.
 *
 * Computed against the merge base, the way GitHub does it: commits the base has
 * gained since the branch started are not this pull request's changes, and
 * showing them would misstate its size.
 */
export interface PullRequestChanges {
  /** Ref the comparison ran against, as git resolved it (e.g. `origin/main`). */
  baseRef: string;
  files: GitCommitFileChange[];
  /** Files touched before truncation. */
  totalFiles: number;
  truncated: boolean;
  additions: number;
  deletions: number;
}

/** The patch behind {@link PullRequestChanges}, fetched only when asked for. */
export interface PullRequestDiff {
  baseRef: string;
  diff: string;
  /** True when the patch was cut at the size limit. */
  truncated: boolean;
}

export interface CreatePullRequestRequest {
  sessionId: string;
  title: string;
  body: string;
  baseBranch: string;
  /** `owner/repo` of the repository that receives the pull request. */
  targetRepo: string;
  draft?: boolean;
}

export interface CreatePullRequestResult {
  number: number;
  url: string;
}

/** Normalised CI state; providers spell these several ways. */
export type PullRequestCheckState = 'pass' | 'fail' | 'pending' | 'skipped' | 'cancelled';

export interface PullRequestCheck {
  name: string;
  state: PullRequestCheckState;
  url?: string;
}

export interface PullRequestChecksResult {
  number: number;
  checks: PullRequestCheck[];
  /** Rollup: fail beats pending beats pass, because that is what needs action. */
  summary: PullRequestCheckState | 'none';
  fetchedAtMs: number;
}

/** GitHub's verdict on a pull request's reviews. */
export type PullRequestReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none';

export interface PullRequestReviewer {
  login: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, … as GitHub spells it. */
  state: string;
}

/**
 * What happened to a pull request after it was opened.
 *
 * The questions this answers are the ones you would otherwise switch to the
 * browser for: did anyone review it, does it still merge, how big did it get.
 */
export interface PullRequestStatus {
  number: number;
  url: string;
  title: string;
  /** `OPEN`, `MERGED`, `CLOSED`. */
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  /** Owner of the repository the head branch lives in, for a fork's pull request. */
  headRepositoryOwner?: string;
  reviewDecision: PullRequestReviewDecision;
  /** `MERGEABLE`, `CONFLICTING`, `UNKNOWN` — GitHub computes this lazily. */
  mergeable: string;
  reviewers: PullRequestReviewer[];
  commentCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  fetchedAtMs: number;
}

/** Files a repository may keep its pull request template in, in search order. */
export const PR_TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
] as const;
