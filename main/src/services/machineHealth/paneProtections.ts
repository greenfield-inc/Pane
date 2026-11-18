/** Why machine health must leave a Pane alone right now. Checked again at execution time, every time. */
export interface ProtectionReaders {
  pinned: (paneId: string) => boolean;
  focusedPaneId: () => string | undefined;
  panelIds: (paneId: string) => string[];
  /** A tab's agent: 'working', 'blocked' (waiting on the person), or anything else. */
  agentState: (panelId: string) => string | undefined;
  hasOpenNotify: (panelIds: string[]) => boolean;
  /** Modified, staged, conflicted or untracked files in its worktree. Rejects when git cannot tell. */
  hasUncommittedChanges: (paneId: string) => Promise<boolean>;
}

export async function protectionOf(paneId: string, readers: ProtectionReaders): Promise<string | null> {
  if (readers.pinned(paneId)) return 'It is pinned.';
  if (readers.focusedPaneId() === paneId) return 'It is the Pane you are looking at.';
  const panelIds = readers.panelIds(paneId);
  const states = panelIds.map(readers.agentState);
  if (states.includes('working')) return 'An agent is working in it.';
  if (states.includes('blocked')) return 'An agent is waiting on you in it.';
  if (readers.hasOpenNotify(panelIds)) return 'It has an open Notify card.';
  try {
    if (await readers.hasUncommittedChanges(paneId)) return 'It has uncommitted changes.';
  } catch {
    return 'Pane could not check it for uncommitted changes.';
  }
  return null;
}
