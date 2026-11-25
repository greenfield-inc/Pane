import type { NotifyItem } from '../../../../shared/types/notify';
import { nextAfterAnswer } from '../../../../shared/approvalOrder';
import { countsAsWaiting } from '../../stores/notifyStore';
import { useApprovalColumnStore, type ApprovalSurface } from '../../stores/approvalColumnStore';
import { focusFirstQuestion, whenShown } from './approvalKeys';
import { APPROVAL_COLUMN } from './approvalDom';

interface Advance {
  surface: ApprovalSurface;
  /** What the column's pager walks, newest first. */
  order: readonly string[];
  /** The approval just answered or dismissed. */
  fromId: string;
  items: readonly NotifyItem[];
  /** Answered (the next card says it was sent, with Undo), or dismissed (nothing to say). */
  sent: boolean;
  open: (itemId: string) => void;
  /** Nothing else waits on this surface. */
  caughtUp: () => void;
  /** Puts keyboard focus in the next card once it renders (the DOM's, by default). */
  focus?: (surface: ApprovalSurface, itemId: string) => void;
}

/**
 * After a Send or Dismiss, the column moves on to the next approval itself (T-88), instead of
 * closing or staying on the one just answered: the next one down the list that still waits, with
 * keyboard focus on its first question so the person keeps going from the keyboard. Returns it, or
 * undefined when nothing else waits.
 */
export function advanceApproval({ surface, order, fromId, items, sent, open, caughtUp, focus = focusApprovalSoon }: Advance): string | undefined {
  const byId = new Map(items.map((item) => [item.id, item]));
  const next = nextAfterAnswer(order, fromId, (id) => {
    const item = byId.get(id);
    return item !== undefined && countsAsWaiting(item);
  });
  if (!next) {
    caughtUp();
    useApprovalColumnStore.getState().noteAdvanced(surface, null);
    return undefined;
  }
  open(next);
  // After opening it: opening an approval on its own ends the line, as paging does.
  useApprovalColumnStore.getState().noteAdvanced(surface, sent ? fromId : null);
  focus(surface, next);
  return next;
}

/** Focus into `itemId`'s column on `surface` once it renders: its first question, else its reply box. */
function focusApprovalSoon(surface: ApprovalSurface, itemId: string): void {
  whenShown(() => document.querySelector<HTMLElement>(`${APPROVAL_COLUMN}[data-surface="${CSS.escape(surface)}"][data-item-id="${CSS.escape(itemId)}"]`), focusFirstQuestion);
}
