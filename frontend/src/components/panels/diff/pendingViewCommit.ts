import type { DiffScope } from '../../../../../shared/types/gitDiff';

/** The Details history's request to the Changes tab, carried by 'diff:view-commit'. */
export interface ViewCommitRequest {
  /** The commit to show, or the newer end of a range; 'index' is the uncommitted row. */
  commitHash: string;
  /** Set for a shift-click range: the older end, by position in the history graph. */
  olderHash?: string;
}

export interface ViewCommitEventDetail extends ViewCommitRequest {
  sessionId: string;
}

interface PendingViewCommit {
  sessionId: string;
  request: ViewCommitRequest;
}

let pendingViewCommit: PendingViewCommit | null = null;

/** Called by SessionView before dispatching 'diff:view-commit'. */
export function setPendingViewCommit(sessionId: string, request: ViewCommitRequest): void {
  pendingViewCommit = { sessionId, request };
}

export function takePendingViewCommit(sessionId: string): ViewCommitRequest | null {
  if (pendingViewCommit?.sessionId !== sessionId) return null;
  const { request } = pendingViewCommit;
  pendingViewCommit = null;
  return request;
}

export function clearPendingViewCommit(): void {
  pendingViewCommit = null;
}

/** The diff scope a history request opens: one commit, the working tree, or a range of either. */
export function viewCommitScope({ commitHash, olderHash }: ViewCommitRequest): DiffScope {
  if (olderHash === undefined || olderHash === commitHash) {
    return commitHash === 'index' ? { kind: 'working-tree' } : { kind: 'commit', hash: commitHash };
  }
  if (commitHash === 'index') return { kind: 'working-tree-range', baseHash: olderHash };
  return { kind: 'commit-range', olderHash, newerHash: commitHash };
}
