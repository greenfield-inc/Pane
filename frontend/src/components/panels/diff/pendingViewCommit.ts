interface PendingViewCommit {
  sessionId: string;
  commitHash: string;
  filePath?: string;
}

let pendingViewCommit: PendingViewCommit | null = null;

/** Called by SessionView before dispatching 'diff:view-commit'. */
export function setPendingViewCommit(sessionId: string, commitHash: string, filePath?: string): void {
  pendingViewCommit = { sessionId, commitHash, filePath };
}

export function takePendingViewCommit(sessionId: string): Omit<PendingViewCommit, 'sessionId'> | null {
  if (pendingViewCommit?.sessionId !== sessionId) return null;
  const { commitHash, filePath } = pendingViewCommit;
  pendingViewCommit = null;
  return { commitHash, filePath };
}

export function clearPendingViewCommit(): void {
  pendingViewCommit = null;
}
