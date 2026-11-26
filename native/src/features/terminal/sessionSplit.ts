import type { PanelLayoutNode, PanelOpenPlacement, SessionPanelLayout } from '@shared/types/panels';

/**
 * Two tabs side by side in a wide Pane or Session: `left` is the route's tab, `right` the one
 * beside it, and `focus` the side the tab strip picks into. The phone keeps its own; it reads
 * the desktop's but never writes it.
 */
export interface SplitState {
  left: string | null;
  right: string | null;
  focus: 'left' | 'right';
}

/** Each column's narrowest width, in dp. A split shows only when two fit. */
const MIN_COLUMN_WIDTH = 320;

export function splitFits(contentWidth: number): boolean {
  return contentWidth >= MIN_COLUMN_WIDTH * 2;
}

/**
 * The desktop's side-by-side split as two tabs this phone draws: the left and right halves of a
 * row split, each showing its focused group's tab (else its first group's). Null when the desktop
 * shows one group, stacks them, or a half's tab isn't one the phone draws.
 */
export function splitFromLayout(layout: SessionPanelLayout | null | undefined, shown: ReadonlySet<string>): SplitState | null {
  const root = layout?.root;
  if (!root || root.type !== 'split' || root.direction !== 'row' || root.children.length < 2) return null;
  const halves = [root.children[0], root.children[root.children.length - 1]];
  const [leftGroups, rightGroups] = halves.map(groupsIn);
  const tabOf = (groups: GroupLike[]) => (groups.find(group => group.id === layout.focusedGroupId) ?? groups[0])?.activePanelId ?? null;
  const left = tabOf(leftGroups);
  const right = tabOf(rightGroups);
  if (!left || !right || left === right || !shown.has(left) || !shown.has(right)) return null;
  return { left, right, focus: rightGroups.some(group => group.id === layout.focusedGroupId) ? 'right' : 'left' };
}

type GroupLike = Extract<PanelLayoutNode, { type: 'group' }>;

function groupsIn(node: PanelLayoutNode): GroupLike[] {
  return node.type === 'group' ? [node] : node.children.flatMap(groupsIn);
}

/** The tab the screen shows when only one fits: the focused side's. */
export function focusedTab(state: SplitState): string | null {
  return state.focus === 'right' && state.right ? state.right : state.left;
}

/** Picking a tab in the strip: a tab already in a column focuses that column; another replaces the focused column's tab. */
export function selectTab(state: SplitState, id: string): SplitState {
  if (id === state.left) return { ...state, focus: 'left' };
  if (id === state.right) return { ...state, focus: 'right' };
  return state.focus === 'right' && state.right ? { ...state, right: id } : { ...state, left: id, focus: 'left' };
}

/** Opens a tab in the right column; focus stays where it is. The left tab opened beside itself swaps places with the right one. */
export function openBeside(state: SplitState, id: string): SplitState {
  if (id === state.right) return state;
  if (id === state.left) return state.right ? { left: state.right, right: id, focus: state.focus === 'left' ? 'right' : 'left' } : state;
  return { ...state, right: id };
}

/**
 * The host or an agent brought a tab forward. Where two columns fit, a split open goes beside
 * the left tab, which keeps its draft and keyboard; otherwise the tab shows as before.
 */
export function followOpen(state: SplitState, id: string, placement: PanelOpenPlacement | undefined, wide: boolean): SplitState {
  return wide && placement === 'split' ? openBeside(state, id) : selectTab(state, id);
}

export function closeBeside(state: SplitState): SplitState {
  return { ...state, right: null, focus: 'left' };
}
