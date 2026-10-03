/**
 * Wire and layout types for the repository-wide commit graph.
 *
 * The backend returns a flat, ordered node list plus refs; lane assignment is
 * done client-side by a pure solver so it stays unit-testable and does not
 * depend on `git log --graph`'s version-specific ASCII art.
 */

export type GitRefKind = 'localBranch' | 'remoteBranch' | 'tag' | 'head';

export interface GitRef {
  kind: GitRefKind;
  /** Short name: `main`, `origin/main`, `v1.2.0`. */
  name: string;
  /** Commit the ref resolves to (peeled, for annotated tags). */
  hash: string;
  /** True for the branch HEAD currently points at in the main checkout. */
  isCurrent: boolean;
  /**
   * Commits this ref has that HEAD does not, and vice versa. Absent when git
   * is too old for `%(ahead-behind:)` (< 2.41) or the ref is HEAD itself.
   */
  ahead?: number;
  behind?: number;
}

export interface GitGraphNode {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** ISO-8601 author date. */
  authorDate: string;
  refs: GitRef[];
}

export interface PaneWorktreeRef {
  /** Absolute worktree path as git reports it. */
  path: string;
  branch: string;
  sessionId?: string;
  sessionName?: string;
  /** True for the project's own checkout rather than a session worktree. */
  isMainCheckout: boolean;
}

export interface RepoGitGraph {
  nodes: GitGraphNode[];
  refs: GitRef[];
  /** null on a detached HEAD. */
  currentBranch: string | null;
  paneWorktrees: PaneWorktreeRef[];
  /** True when `limit` was hit — more history exists further back. */
  truncated: boolean;
  limit: number;
  /** Remotes configured in this clone, in `git remote` order. */
  remotes: string[];
  /** The scope actually applied — see {@link RepoGitGraphRequest.remoteScope}. */
  remoteScope: string;
  /** The ref the history was narrowed to, when one was requested. */
  focusRef?: string;
  /** Non-fatal problems worth surfacing (no commits yet, ref cap hit, …). */
  notice?: string;
}

/**
 * "Local only" — heads and tags, nothing from a remote.
 *
 * Not a legal remote name (git rejects the empty string), so it can never
 * collide with one.
 */
export const GRAPH_REMOTE_NONE = '';
/**
 * Every remote at once.
 *
 * A fork's clone usually carries both `origin` and `upstream`, and those are
 * two different repositories on the hosting side. Graphing them together is
 * occasionally useful and confusing by default, hence the explicit opt-in.
 * `*` is not a legal remote name either.
 */
export const GRAPH_REMOTE_ALL = '*';

export interface RepoGitGraphRequest {
  projectId: number;
  /** Commits to load. Defaults to {@link DEFAULT_GRAPH_LIMIT}. */
  limit?: number;
  /**
   * Which remote's branches to include: {@link GRAPH_REMOTE_NONE},
   * {@link GRAPH_REMOTE_ALL}, or a remote name. Defaults to `origin` when the
   * repository has one, otherwise its first remote, otherwise local only.
   */
  remoteScope?: string;
  /**
   * Narrow the history to one ref's ancestry — "show me just this branch".
   * Ignored when the name is not a ref this repository has.
   */
  focusRef?: string;
}

export const DEFAULT_GRAPH_LIMIT = 300;
export const MAX_GRAPH_LIMIT = 2000;
export const MAX_GRAPH_REFS = 2000;

// --- Client-side layout ---

/**
 * Which part of a row's band an edge occupies. Rows are drawn independently,
 * so each edge has to say where it starts and ends vertically or the lines
 * come out as dashes.
 *
 * - `straight` — this commit to its first parent: dot → bottom edge.
 * - `merge` — this commit to a further parent in another lane: dot → bottom.
 * - `passthrough` — a branch that neither starts nor ends here, crossing the
 *   whole row: top edge → bottom edge.
 * - `join` — a lane above that ends at this commit: top edge → dot.
 */
export type GitGraphEdgeKind = 'straight' | 'merge' | 'passthrough' | 'join';

export interface GitGraphEdge {
  fromLane: number;
  toLane: number;
  kind: GitGraphEdgeKind;
  /** Stable palette index derived from the lane the edge belongs to. */
  colorIndex: number;
  /**
   * True when the edge leaves the loaded window (its parent is older than
   * `limit`), so the renderer can fade it out instead of drawing a dead end.
   */
  danglesBelow?: boolean;
}

export interface GitGraphRow {
  node: GitGraphNode;
  /** 0-based lane (column) holding this commit's dot. */
  lane: number;
  colorIndex: number;
  /** Edges drawn in this row's band, including pass-throughs. */
  edges: GitGraphEdge[];
  /**
   * True when no lane above was waiting for this commit — the newest commit on
   * its branch. Nothing connects to it from above, and the renderer marks the
   * start rather than drawing a line out of nowhere.
   */
  isBranchTip: boolean;
}

export interface GitGraphLayout {
  rows: GitGraphRow[];
  laneCount: number;
}
