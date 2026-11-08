import { useMemo } from 'react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { sessionApprovals } from './approvalCard';

/** A Session's waiting approvals, oldest first, as its pager walks them (J14). */
export function useSessionApprovals(sessionId: string): NotifyItem[] {
  const items = useNotifyStore(selectNotifyItems);
  return useMemo(() => sessionApprovals(items, sessionId), [items, sessionId]);
}
