import { useMemo } from 'react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { openSessionApproval } from '../../stores/approvalColumnStore';
import { firstToOpen, sessionApprovals } from './approvalCard';

/** A Session's waiting approvals, oldest first, as its pager walks them (J14). */
export function useSessionApprovals(sessionId: string): NotifyItem[] {
  const items = useNotifyStore(selectNotifyItems);
  return useMemo(() => sessionApprovals(items, sessionId), [items, sessionId]);
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
