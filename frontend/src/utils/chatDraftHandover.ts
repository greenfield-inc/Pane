import type { LaunchDraft } from './launchOutline';

/**
 * Hands a message box's text to a chat tab once (T-132): what was typed into another machine's
 * Session while the window switched to it goes into that chat's own box there, with its caret,
 * focus, and an Enter pressed meanwhile, which the chat then sends once (as the launch outline's
 * box does, D-62). A chat that is already mounted takes it at once; otherwise the next one to mount
 * with that tab takes it. A newer handover replaces one still waiting.
 */

const takers = new Map<string, (draft: LaunchDraft) => void>();
let waiting: { panelId: string; draft: LaunchDraft } | null = null;
const shownListeners = new Set<(panelId: string) => void>();

/** A chat tab that can take a handed-over draft; returns its cleanup. */
export function acceptChatDraft(panelId: string, take: (draft: LaunchDraft) => void): () => void {
  takers.set(panelId, take);
  if (waiting?.panelId === panelId) {
    const { draft } = waiting;
    waiting = null;
    take(draft);
  }
  return () => {
    if (takers.get(panelId) === take) takers.delete(panelId);
  };
}

/** Gives `draft` to the chat tab `panelId`: now, or when it mounts. Each handover is taken once. */
export function handOverChatDraft(panelId: string, draft: LaunchDraft): void {
  const take = takers.get(panelId);
  waiting = null;
  if (take) take(draft);
  else waiting = { panelId, draft };
}

/** A live chat tab (not one shown read-only from another machine) painted its conversation. */
export function chatTabShown(panelId: string): void {
  for (const listener of shownListeners) listener(panelId);
}

/** Calls `listener` with each live chat tab that paints; returns the unsubscribe. */
export function onChatTabShown(listener: (panelId: string) => void): () => void {
  shownListeners.add(listener);
  return () => { shownListeners.delete(listener); };
}
