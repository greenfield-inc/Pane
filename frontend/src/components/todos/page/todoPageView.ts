import { splitItemKey, type TodoSplitState } from './splitTabs';

/**
 * Where you left a to-do's page: its split tab and how far the thread and the split were scrolled.
 * Kept in memory for this window only, so a trip to the to-do's Session and back (or to another to-do)
 * returns to the page as you left it; a relaunch opens it fresh.
 */
export interface TodoPageView {
  /** `splitItemKey` of the tab shown, or null with no tabs. */
  tab: string | null;
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

/** The split with the remembered tab shown, when it is still one of the tabs. */
export function restoreActiveTab(split: TodoSplitState, tab: string | null): TodoSplitState {
  if (tab === null) return split;
  const at = split.items.findIndex((item) => splitItemKey(item) === tab);
  return at < 0 || at === split.active ? split : { ...split, active: at };
}
