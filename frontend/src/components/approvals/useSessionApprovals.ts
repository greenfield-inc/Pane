import { useMemo } from 'react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { openSessionApproval, useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { bridgedFrom, firstToOpen, sessionApprovals } from './approvalCard';

/** A Session's waiting approvals, oldest first, as its pager walks them (J14). */
export function useSessionApprovals(sessionId: string): NotifyItem[] {
  const items = useNotifyStore(selectNotifyItems);
  return useMemo(() => sessionApprovals(items, sessionId), [items, sessionId]);
}

/**
 * While a Session is shown, an approval asked for it from now on opens in its column on its own,
 * over whatever the right split shows, with ✕ "Back to <tab>" (D-114). It opens once per approval,
 * only while the column is closed (an open one may hold a reply being typed), and leaves focus where
 * it is. A worker's question waits while it is quiet (its orchestrator may answer it first) and
 * opens when relayed; the chat's own prompts stay in the chat, which shows them (P5). Returns the
 * unsubscribe.
 */
export function openNewSessionApprovals(sessionId: string, chatPanelId?: string): () => void {
  const since = Date.now();
  const seen = new Set<string>();
  const quiet = new Set<string>();
  const notice = (items: readonly NotifyItem[]) => {
    for (const item of items) if (item.quiet) quiet.add(item.id);
  };
  notice(sessionApprovals(selectNotifyItems(useNotifyStore.getState()), sessionId));
  return useNotifyStore.subscribe((state) => {
    const items = sessionApprovals(selectNotifyItems(state), sessionId);
    // Asked before the Session was shown (a first snapshot, a machine's list arriving late): the count
    // opens those, unless it was a quiet worker question relayed since.
    const fresh = items.filter(item => !item.quiet && !seen.has(item.id) && !bridgedFrom(item, chatPanelId)
      && (item.createdAt >= since || quiet.has(item.id)));
    notice(items);
    for (const item of fresh) seen.add(item.id);
    const newest = fresh.at(-1);
    if (newest && !useApprovalColumnStore.getState().open[`session:${sessionId}`]) openSessionApproval(sessionId, newest.id);
  });
}

/**
 * A click on a Session row's count (J15): opens the Session's newest ready-again approval, or its
 * first waiting one, beside the Session the row's click opens.
 */
export function openApprovalsFromCount(target: EventTarget, sessionId: string): void {
  if (!(target instanceof Element) || target.closest('[data-opens-approvals]')?.getAttribute('data-opens-approvals') !== sessionId) return;
  const first = firstToOpen(sessionApprovals(selectNotifyItems(useNotifyStore.getState()), sessionId));
  if (first) openSessionApproval(sessionId, first.id);
}
