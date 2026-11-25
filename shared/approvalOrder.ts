import type { NotifyItem } from './types/notify';

/**
 * The one order every approvals list uses (T-88): newest first, like a stack. The Approvals page,
 * a Session's column and dock, a to-do's pager, the floating strip and Answer all read it, so the
 * card on top is the same everywhere.
 */

/**
 * When an approval was last put in front of the person: when it was asked, when its latest version
 * (`runpane notify --update`) was saved, or when the person reopened it, whichever is latest. A card
 * that asks again belongs on top again.
 */
export function approvalListedAt(item: Pick<NotifyItem, 'createdAt' | 'revision' | 'reopened'>): number {
  return Math.max(item.createdAt, item.revision?.at ?? 0, item.reopened?.at ?? 0);
}

/** Sort comparator: the most recently listed first; by id on a tie, so same-millisecond cards never swap. */
export function newestFirst(a: Pick<NotifyItem, 'id' | 'createdAt' | 'revision' | 'reopened'>, b: Pick<NotifyItem, 'id' | 'createdAt' | 'revision' | 'reopened'>): number {
  return approvalListedAt(b) - approvalListedAt(a) || a.id.localeCompare(b.id);
}

/**
 * Which approval opens after the person answers or dismisses `id` (T-88): the next one down `order`
 * that still waits (`waits`), else the nearest one above it, else none. When `id` already left the
 * list, the top one.
 */
export function nextAfterAnswer(order: readonly string[], id: string, waits: (id: string) => boolean = () => true): string | undefined {
  const at = order.indexOf(id);
  const open = (other: string) => other !== id && waits(other);
  if (at === -1) return order.find(open);
  return order.slice(at + 1).find(open) ?? order.slice(0, at).reverse().find(open);
}
