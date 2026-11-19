import type { TodoAttachment, TodoAttachmentGroup, TodoAttachmentKind } from '../../../../../shared/types/todos';

/**
 * The to-do page's right split (round 7, D-418, D-420): it opens with the to-do, its tabs are the
 * to-do's attachments, plan first, and a sub-to-do also shows its parent's. A description image
 * opens as an extra tab. Approvals are not tabs: they cover the split instead. With a Session on
 * this machine, its Overview is a tab too, after the plans (round 8, T-4). Every tab closes (T-25):
 * a closed tab is remembered per to-do and reopens when its file is opened again.
 */
export type TodoSplitItem =
  /** `from` names the parent the attachment is inherited from. */
  | { kind: 'attachment'; attachment: TodoAttachment; from?: number }
  | { kind: 'image'; src: string; label: string }
  /** The to-do's Session Overview (its parent's for a sub-to-do), as the Session's own Overview tab shows it. */
  | { kind: 'overview'; sessionId: string };

export interface TodoSplitState {
  /** Every tab the to-do offers (its attachments and its parent's, and the Overview), closed or not. */
  all: readonly TodoSplitItem[];
  /** Opened tabs that aren't among `all`: a description image, a sub-to-do's file. ✕ drops them for good. */
  extras: readonly TodoSplitItem[];
  /** `splitItemKey` of each tab of `all` you closed (T-25); remembered per to-do. */
  closed: readonly string[];
  /** The tabs shown: `all` less the closed ones, then the extras. */
  items: readonly TodoSplitItem[];
  /** The tab shown; meaningless while `items` is empty. */
  active: number;
  /** Hidden with the header's split button or ⌘\; the page then takes the full width. */
  hidden: boolean;
  /** + Attach is waiting for this target to arrive: its tab is selected and the split shown then. */
  reveal: string | null;
  /**
   * Where no split is available (T-38, D-448) the page and its tabs share one column, one thing at a
   * time: the to-do page under its To-do tab, or the tab at `active`. True while the To-do tab is
   * the one selected. Beside a split it is ignored.
   */
  todoShown: boolean;
}

export type TodoSplitAction =
  /** The to-do's attachments or its Session changed: rebuild the tabs, keeping the one shown. */
  | { type: 'sync'; groups: readonly TodoAttachmentGroup[]; overview?: string | null }
  /** Shows an item's tab (reopening a closed one, adding an image's), and shows the split. */
  | { type: 'open'; item: TodoSplitItem }
  | { type: 'activate'; index: number }
  /** ← and → on the split's tab strip, wrapping round: selects as a click does. */
  | { type: 'step'; delta: 1 | -1 }
  /** The one-column layout's To-do tab. */
  | { type: 'show-todo' }
  /** ✕ or the close-tab key (T-25): any tab closes; closing the last one hides the split. */
  | { type: 'close'; index: number }
  | { type: 'set-hidden'; hidden: boolean }
  | { type: 'toggle-hidden' }
  | { type: 'reveal'; target: string };

/** Tab order by kind: plan, design and mock-ups, PRs, findings, decisions, docs, images, links, then the rest. */
const ATTACHMENT_TAB_ORDER = [
  'plan', 'mockup', 'design', 'pr', 'findings', 'decision', 'doc', 'image', 'link', 'status', 'checklist',
] as const satisfies readonly TodoAttachmentKind[];

/** Design and mock-ups share one place in the order. */
const KIND_RANK = {
  plan: 0, mockup: 1, design: 1, pr: 2, findings: 3, decision: 4, doc: 5, image: 6, link: 7, status: 8, checklist: 9,
} as const satisfies Record<TodoAttachmentKind, number>;

/** Under this width of to-do area, every to-do opens with its split hidden (D-420). */
export const NARROW_TODO_AREA_PX = 1000;

/** One key per tab, so opening it again shows its tab instead of adding another. */
export function splitItemKey(item: TodoSplitItem): string {
  if (item.kind === 'attachment') return `attachment:${item.attachment.id}`;
  if (item.kind === 'overview') return `overview:${item.sessionId}`;
  return `image:${item.src}`;
}

/** The split's file tabs, for "Plan · 3 files": every tab but the Overview. */
export function splitAttachmentItems(items: readonly TodoSplitItem[]): TodoSplitItem[] {
  return items.filter((item) => item.kind !== 'overview');
}

/** Every file the split offers, closed or not: what "Plan · 3 files" counts. */
export function splitFileItems(state: TodoSplitState): TodoSplitItem[] {
  return splitAttachmentItems([...state.all, ...state.extras]);
}

/** Whether the split has anything to show, even with every tab closed. */
export function splitHasTabs(state: TodoSplitState): boolean {
  return state.items.length > 0 || state.all.length > 0;
}

/** Every tab is closed: showing the split reopens the default one. */
export function everyTabClosed(state: TodoSplitState): boolean {
  return state.items.length === 0 && state.all.length > 0;
}

const isPlan = (item: TodoSplitItem) => item.kind === 'attachment' && item.attachment.kind === 'plan';

/** The attachment tabs with the Session's Overview after the plans, when the to-do has a Session here. */
function splitTabs(groups: readonly TodoAttachmentGroup[], overview: string | null | undefined): TodoSplitItem[] {
  const tabs = attachmentTabs(groups);
  if (overview) tabs.splice(tabs.filter(isPlan).length, 0, { kind: 'overview', sessionId: overview });
  return tabs;
}

/** The to-do's own attachments and its parent's, in tab order; each kind in the order attached. */
export function attachmentTabs(groups: readonly TodoAttachmentGroup[]): TodoSplitItem[] {
  const tabs: TodoSplitItem[] = [];
  for (const group of groups) {
    if (group.from && group.from.relation !== 'parent') continue;
    for (const attachment of group.attachments) {
      if (attachment.removedAt !== undefined) continue;
      tabs.push(group.from ? { kind: 'attachment', attachment, from: group.from.number } : { kind: 'attachment', attachment });
    }
  }
  return tabs.sort((a, b) => tabRank(a) - tabRank(b) || addedAt(a) - addedAt(b) || attachmentId(a) - attachmentId(b));
}

/** The plan if there is one, otherwise the first attachment, otherwise the first tab (the Overview). */
function defaultTab(items: readonly TodoSplitItem[]): number {
  const plan = items.findIndex(isPlan);
  if (plan >= 0) return plan;
  return Math.max(0, items.findIndex((item) => item.kind === 'attachment'));
}

/**
 * `overview` is the Session whose Overview the split offers: the to-do's own (or parent's) on this machine.
 * `closed` is the tabs closed on an earlier visit; with every tab closed the split opens hidden.
 */
export function initialSplit(groups: readonly TodoAttachmentGroup[], hidden: boolean, overview: string | null = null, closed: readonly string[] = []): TodoSplitState {
  const all = splitTabs(groups, overview);
  const items = shownItems(all, closed, []);
  return { all, extras: [], closed, items, active: defaultTab(items), hidden: hidden || (items.length === 0 && all.length > 0), reveal: null, todoShown: true };
}

/** A narrow to-do area opens hidden; a wide one keeps the to-do's remembered choice. */
export function startsHidden(rememberedHidden: boolean, areaPx: number): boolean {
  return areaPx < NARROW_TODO_AREA_PX || rememberedHidden;
}

export function todoSplitReducer(state: TodoSplitState, action: TodoSplitAction): TodoSplitState {
  switch (action.type) {
    case 'sync':
      return sync(state, action.groups, action.overview);
    case 'open': {
      const key = splitItemKey(action.item);
      const at = state.items.findIndex((item) => splitItemKey(item) === key);
      if (at >= 0) return at === state.active && !state.hidden && !state.todoShown ? state : { ...state, active: at, hidden: false, todoShown: false };
      if (state.all.some((item) => splitItemKey(item) === key)) return { ...reopen(state, key), hidden: false, todoShown: false };
      return { ...rebuild(state, { extras: [...state.extras, action.item] }, key), hidden: false, todoShown: false };
    }
    case 'activate':
      if (action.index < 0 || action.index >= state.items.length) return state;
      // Picked under the one-column tabs, the file is the split's shown tab too where a split is allowed.
      return action.index === state.active && !state.todoShown && !state.hidden ? state : { ...state, active: action.index, todoShown: false, hidden: false };
    case 'step':
      return stepTabs(state, action.delta);
    case 'show-todo':
      return state.todoShown ? state : { ...state, todoShown: true };
    case 'close':
      return close(state, action.index);
    case 'set-hidden':
      if (!action.hidden && everyTabClosed(state)) return showDefault(state);
      if (action.hidden) return state.hidden && state.todoShown ? state : { ...state, hidden: true, todoShown: true };
      return !state.hidden && !state.todoShown ? state : { ...state, hidden: false, todoShown: state.items.length === 0 };
    case 'toggle-hidden':
      if (state.hidden && everyTabClosed(state)) return showDefault(state);
      return { ...state, hidden: !state.hidden, todoShown: !state.hidden || state.items.length === 0 };
    case 'reveal': {
      // The attach's refresh may already have brought it in; otherwise the next sync shows it.
      const found = state.all.find((item) => item.kind === 'attachment' && item.attachment.target === action.target);
      if (found) return { ...reopen(state, splitItemKey(found)), hidden: false, reveal: null, todoShown: false };
      return { ...state, reveal: action.target };
    }
  }
}

function stepTabs(state: TodoSplitState, delta: 1 | -1): TodoSplitState {
  const count = state.items.length;
  if (count < 2) return state;
  // As a click: the one-column layout then shows this tab rather than the to-do.
  return { ...state, active: (state.active + delta + count) % count, todoShown: false, hidden: false };
}

/**
 * Where a key moves the one-column strip's selection (T-38): positions To-do 0, each file, then an
 * open approval last. ← → wrap round, Home is To-do, End the last tab; any other key, null.
 */
export function stripMove(position: number, count: number, key: string): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return (position + 1) % count;
  if (key === 'ArrowLeft') return (position - 1 + count) % count;
  return null;
}

/** The tabs shown: the offered ones not closed, then the extras. */
function shownItems(all: readonly TodoSplitItem[], closed: readonly string[], extras: readonly TodoSplitItem[]): TodoSplitItem[] {
  const shut = new Set(closed);
  return [...all.filter((item) => !shut.has(splitItemKey(item))), ...extras];
}

/** The state with new tabs, showing `activeKey` when it is among them, else the default tab. */
function rebuild(state: TodoSplitState, next: Partial<Pick<TodoSplitState, 'all' | 'extras' | 'closed'>>, activeKey: string | null): TodoSplitState {
  const all = next.all ?? state.all;
  const extras = next.extras ?? state.extras;
  const closed = next.closed ?? state.closed;
  const items = shownItems(all, closed, extras);
  const at = activeKey === null ? -1 : items.findIndex((item) => splitItemKey(item) === activeKey);
  return { ...state, all, extras, closed, items, active: at >= 0 ? at : defaultTab(items) };
}

/** Forgets that `key` was closed and shows its tab. */
function reopen(state: TodoSplitState, key: string): TodoSplitState {
  return rebuild(state, { closed: state.closed.filter((closed) => closed !== key) }, key);
}

/** Every tab was closed: the default one (the plan, else the first) comes back, and the split shows. */
function showDefault(state: TodoSplitState): TodoSplitState {
  const tab = state.all[defaultTab(state.all)];
  return { ...reopen(state, splitItemKey(tab)), hidden: false, todoShown: false };
}

/** An extra (an image, a sub-to-do's file) goes; any other tab is remembered as closed. The last one hides the split. */
function close(state: TodoSplitState, index: number): TodoSplitState {
  const item = state.items[index];
  if (!item) return state;
  const key = splitItemKey(item);
  const extra = state.extras.some((other) => splitItemKey(other) === key);
  const all = state.all;
  const extras = extra ? state.extras.filter((other) => splitItemKey(other) !== key) : state.extras;
  const closed = extra ? state.closed : [...state.closed, key];
  const items = shownItems(all, closed, extras);
  const active = Math.max(0, index < state.active ? state.active - 1 : Math.min(state.active, items.length - 1));
  const none = items.length === 0;
  return { ...state, extras, closed, items, active, hidden: none ? true : state.hidden, todoShown: none ? true : state.todoShown };
}

function sync(state: TodoSplitState, groups: readonly TodoAttachmentGroup[], overview: string | null | undefined): TodoSplitState {
  const all = splitTabs(groups, overview);
  const offered = new Set(all.map(splitItemKey));
  // A sub-to-do's file opened as an extra stays while it is still attached (and not now a tab of its own).
  const present = new Set(groups.flatMap((group) => group.attachments.filter((attachment) => attachment.removedAt === undefined).map((attachment) => attachment.id)));
  const extras = state.extras.filter((item) => item.kind === 'image' || (item.kind === 'attachment' && present.has(item.attachment.id) && !offered.has(splitItemKey(item))));
  const revealed = state.reveal === null ? undefined : all.find((item) => item.kind === 'attachment' && item.attachment.target === state.reveal);
  if (revealed) {
    const key = splitItemKey(revealed);
    return { ...rebuild(state, { all, extras, closed: state.closed.filter((closed) => closed !== key) }, key), hidden: false, reveal: null, todoShown: false };
  }
  const shown = state.items[state.active];
  return rebuild(state, { all, extras }, shown ? splitItemKey(shown) : null);
}

function tabRank(item: TodoSplitItem): number {
  return item.kind === 'attachment' ? KIND_RANK[item.attachment.kind] : ATTACHMENT_TAB_ORDER.length;
}

function addedAt(item: TodoSplitItem): number {
  return item.kind === 'attachment' ? item.attachment.addedAt : 0;
}

function attachmentId(item: TodoSplitItem): number {
  return item.kind === 'attachment' ? item.attachment.id : 0;
}
