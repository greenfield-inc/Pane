import { splitItemKey, type TodoSplitState } from './splitTabs';

/**
 * Where you left a to-do's page: its split tab and how far the thread and the split were scrolled.
 * Kept in memory for this window only, so a trip to the to-do's Session and back (or to another to-do)
 * returns to the page as you left it; a relaunch opens it fresh.
 */
export interface TodoPageView {
  /** `splitItemKey` of the tab shown, or null with no tabs. */
  tab: string | null;
  /** The one-column layout's To-do tab was the one shown (T-38). */
  todoShown: boolean;
  pageScroll: number;
  splitScroll: number;
}

const LIMIT = 100;
const views = new Map<string, TodoPageView>();

export function rememberTodoView(key: string, view: TodoPageView): void {
  views.delete(key);
  views.set(key, view);
  if (views.size > LIMIT) {
    const oldest = views.keys().next().value;
    if (oldest !== undefined) views.delete(oldest);
  }
}

export function recallTodoView(key: string): TodoPageView | null {
  return views.get(key) ?? null;
}

/**
 * The split with the remembered tab shown, when it is still one of the tabs; and, under the
 * one-column tabs, that tab rather than the To-do tab when it was the one left showing.
 */
export function restoreActiveTab(split: TodoSplitState, tab: string | null, todoShown = true): TodoSplitState {
  if (tab === null) return split;
  const at = split.items.findIndex((item) => splitItemKey(item) === tab);
  if (at < 0) return split;
  const todo = split.todoShown && todoShown;
  return at === split.active && todo === split.todoShown ? split : { ...split, active: at, todoShown: todo };
}
