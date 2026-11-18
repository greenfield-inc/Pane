import type { TodoAttachment, TodoAttachmentGroup, TodoAttachmentKind } from '../../../../../shared/types/todos';

/**
 * The to-do page's right split (round 7, D-418, D-420): it opens with the to-do, its tabs are the
 * to-do's attachments, plan first, and a sub-to-do also shows its parent's. A description image
 * opens as an extra tab that ✕ closes. Approvals are not tabs: they cover the split instead.
 * With a Session on this machine, its Overview is a tab too, after the plans (round 8, T-4).
 */
export type TodoSplitItem =
  /** `from` names the parent the attachment is inherited from. */
  | { kind: 'attachment'; attachment: TodoAttachment; from?: number }
  | { kind: 'image'; src: string; label: string }
  /** The to-do's Session Overview (its parent's for a sub-to-do), as the Session's own Overview tab shows it. */
  | { kind: 'overview'; sessionId: string };

export interface TodoSplitState {
  items: readonly TodoSplitItem[];
  /** The tab shown; meaningless while `items` is empty. */
  active: number;
  /** Hidden with the header's split button or ⌘\; the page then takes the full width. */
  hidden: boolean;
  /** + Attach is waiting for this target to arrive: its tab is selected and the split shown then. */
  reveal: string | null;
}

export type TodoSplitAction =
  /** The to-do's attachments or its Session changed: rebuild the tabs, keeping the one shown. */
  | { type: 'sync'; groups: readonly TodoAttachmentGroup[]; overview?: string | null }
  /** Shows an item's tab (adding an image's), and shows the split. */
  | { type: 'open'; item: TodoSplitItem }
  | { type: 'activate'; index: number }
  /** ← and → on the tab strip, wrapping round. */
  | { type: 'step'; delta: 1 | -1 }
  /** ✕ on an image tab; attachment tabs leave only by Detach, the Overview with the Session. */
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

/** `overview` is the Session whose Overview the split offers: the to-do's own (or parent's) on this machine. */
export function initialSplit(groups: readonly TodoAttachmentGroup[], hidden: boolean, overview: string | null = null): TodoSplitState {
  const items = splitTabs(groups, overview);
  return { items, active: defaultTab(items), hidden, reveal: null };
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
      if (at >= 0) return at === state.active && !state.hidden ? state : { ...state, active: at, hidden: false };
      return { ...state, items: [...state.items, action.item], active: state.items.length, hidden: false };
    }
    case 'activate':
      return action.index >= 0 && action.index < state.items.length && action.index !== state.active ? { ...state, active: action.index } : state;
    case 'step': {
      const count = state.items.length;
      if (count < 2) return state;
      return { ...state, active: (state.active + action.delta + count) % count };
    }
    case 'close': {
      const item = state.items[action.index];
      if (!item || item.kind !== 'image') return state;
      const items = state.items.filter((_, at) => at !== action.index);
      const active = action.index < state.active ? state.active - 1 : Math.min(state.active, items.length - 1);
      return { ...state, items, active: Math.max(0, active) };
    }
    case 'set-hidden':
      return state.hidden === action.hidden ? state : { ...state, hidden: action.hidden };
    case 'toggle-hidden':
      return { ...state, hidden: !state.hidden };
    case 'reveal': {
      // The attach's refresh may already have brought it in; otherwise the next sync shows it.
      const at = state.items.findIndex((item) => item.kind === 'attachment' && item.attachment.target === action.target);
      if (at >= 0) return { ...state, active: at, hidden: false, reveal: null };
      return { ...state, reveal: action.target };
    }
  }
}

function sync(state: TodoSplitState, groups: readonly TodoAttachmentGroup[], overview: string | null | undefined): TodoSplitState {
  const images = state.items.filter((item) => item.kind === 'image');
  const items = [...splitTabs(groups, overview), ...images];
  const revealed = state.reveal === null ? -1 : items.findIndex((item) => item.kind === 'attachment' && item.attachment.target === state.reveal);
  if (revealed >= 0) return { items, active: revealed, hidden: false, reveal: null };
  const shown = state.items[state.active];
  const kept = shown ? items.findIndex((item) => splitItemKey(item) === splitItemKey(shown)) : -1;
  return { ...state, items, active: kept >= 0 ? kept : defaultTab(items) };
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
