import type { NotifyItem } from '../../../../shared/types/notify';
import { nextAfterAnswer, placeAnswered } from '../../../../shared/approvalOrder';
import { isOpenForSession } from '../../../../shared/approvalOpen';
import { countsAsWaiting } from '../../stores/notifyStore';
import { useApprovalColumnStore, type ApprovalSurface } from '../../stores/approvalColumnStore';
import { focusFirstQuestion, whenShown } from './approvalKeys';
import { isBeingRead } from './approvalCard';
import { APPROVAL_COLUMN } from './approvalDom';

interface Advance {
  surface: ApprovalSurface;
  /** What the column's pager walks now, newest first, read when the Send or Dismiss returned. */
  order: readonly string[];
  /** The order when it was sent, for the answered card's place if it already left `order`. */
  before?: readonly string[];
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
 * What a column moves on to, counts as left, and leaves "All caught up" for (T-88): a card that
 * waits on the person now, not dismissed, and not a reply an agent is reading or asking about
 * (Send moves past those, J14). A dismissed card still waits in Approvals and can be picked by
 * hand, but never comes back by itself.
 */
export function canAdvanceTo(item: NotifyItem): boolean {
  return countsAsWaiting(item) && isOpenForSession(item) && !isBeingRead(item);
}

/**
 * After a Send or Dismiss, the column moves on to the next approval itself (T-88), instead of
 * closing or staying on the one just answered: the next one down the list that still waits, with
 * keyboard focus on its first question so the person keeps going from the keyboard. Returns it, or
 * undefined when nothing else waits.
 */
export function advanceApproval({ surface, order, before = order, fromId, items, sent, open, caughtUp, focus = focusApprovalSoon }: Advance): string | undefined {
  const byId = new Map(items.map((item) => [item.id, item]));
  const next = nextAfterAnswer(placeAnswered(order, before, fromId), fromId, (id) => {
    const item = byId.get(id);
    return item !== undefined && canAdvanceTo(item);
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

/**
 * Whether keyboard focus still belongs to `surface`: in its column or "All caught up", or nowhere
 * (the card that held it just went). Focus the person put anywhere else stays there.
 */
function ownsFocus(surface: ApprovalSurface): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return active.closest(`[data-surface="${CSS.escape(surface)}"]`) !== null;
}

/**
 * Focus into `itemId`'s column on `surface` once it renders: its first question, else its reply
 * box. Only while the surface owns the focus (review S-3): a Send that returns while the person
 * types in another composer, or after they picked another card, leaves their focus alone.
 */
function focusApprovalSoon(surface: ApprovalSurface, itemId: string): void {
  if (!ownsFocus(surface)) return;
  const column = () => document.querySelector<HTMLElement>(`${APPROVAL_COLUMN}[data-surface="${CSS.escape(surface)}"][data-item-id="${CSS.escape(itemId)}"]`);
  whenShown(column, (element) => {
    if (ownsFocus(surface)) focusFirstQuestion(element);
  });
}
