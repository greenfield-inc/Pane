import type { NotifyItem } from './types/notify';

/**
 * Whether an approval is open for its Session: still waiting on the person, and not dismissed.
 * Dismiss gets a card out of the way without answering it (#1388): the item keeps waiting in
 * Approvals, but its Session's count and badge leave it out, and it doesn't hold a move to another
 * machine back. Every "open approvals for a Session" check reads this, so they agree.
 */
export function isOpenForSession(item: Pick<NotifyItem, 'state' | 'dismissedAt'>): boolean {
  return item.state === 'waiting' && item.dismissedAt === undefined;
}
