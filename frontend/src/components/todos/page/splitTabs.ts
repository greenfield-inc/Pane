import type { TodoAttachment } from '../../../../../shared/types/todos';

/**
 * The to-do page's right split (D-407): approvals, attachments and description images open beside
 * the to-do as tabs, like a Session's right panel. Several stay open; one shows at a time.
 */
export type TodoSplitItem =
  | { kind: 'approval'; id: string }
  | { kind: 'attachment'; attachment: TodoAttachment }
  | { kind: 'image'; src: string; label: string };

export interface TodoSplitState {
  items: readonly TodoSplitItem[];
  /** The tab shown; meaningless while `items` is empty. */
  active: number;
}

export type TodoSplitAction =
  /** Opens an item, or shows its tab when it is already open. */
  | { type: 'open'; item: TodoSplitItem }
  | { type: 'activate'; index: number }
  | { type: 'close'; index: number }
  /** Esc: closes the tab shown. */
  | { type: 'close-active' }
  /** Close split: the details rail comes back. */
  | { type: 'close-all' };

export const CLOSED_SPLIT: TodoSplitState = { items: [], active: 0 };

/** One key per thing opened, so opening it again shows its tab instead of adding another. */
export function splitItemKey(item: TodoSplitItem): string {
  if (item.kind === 'approval') return `approval:${item.id}`;
  if (item.kind === 'attachment') return `attachment:${item.attachment.id}`;
  return `image:${item.src}`;
}

export function todoSplitReducer(state: TodoSplitState, action: TodoSplitAction): TodoSplitState {
  switch (action.type) {
    case 'open': {
      const key = splitItemKey(action.item);
      const at = state.items.findIndex((item) => splitItemKey(item) === key);
      if (at >= 0) return at === state.active ? state : { items: state.items, active: at };
      return { items: [...state.items, action.item], active: state.items.length };
    }
    case 'activate':
      return action.index >= 0 && action.index < state.items.length && action.index !== state.active ? { items: state.items, active: action.index } : state;
    case 'close':
      return closeAt(state, action.index);
    case 'close-active':
      return closeAt(state, state.active);
    case 'close-all':
      return state.items.length === 0 ? state : CLOSED_SPLIT;
  }
}

/** Closing a tab shows the one that took its place (or the last); closing one before it keeps the same tab shown. */
function closeAt(state: TodoSplitState, index: number): TodoSplitState {
  if (index < 0 || index >= state.items.length) return state;
  const items = state.items.filter((_, at) => at !== index);
  if (items.length === 0) return CLOSED_SPLIT;
  const active = index < state.active ? state.active - 1 : Math.min(state.active, items.length - 1);
  return { items, active };
}
