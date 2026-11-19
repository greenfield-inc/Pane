import type { PanelGroupNode, SessionPanelLayout } from '../../../shared/types/panels';
import { allGroups, canSplitLayout } from './panelLayout';

/**
 * Where a Session's open approval shows (D-261, D-448). It lays over existing splits, or opens a
 * column of its own only while that column would be the stage's second split: the column counts
 * toward the two-split cap like any group.
 */
export type StageApprovalPlacement = 'over' | 'split';

/**
 * The groups the approval lays over: the right split view of a side-by-side root; at two splits
 * with none to the right (stacked by Split Down), the last split. Empty when there is room for a
 * column of its own and no right split to cover.
 */
export function approvalTargetGroups(layout: SessionPanelLayout | null | undefined): PanelGroupNode[] {
  if (!layout) return [];
  const { root } = layout;
  if (root.type === 'split' && root.direction === 'row') return allGroups(root.children[root.children.length - 1]);
  return canSplitLayout(root) ? [] : allGroups(root).slice(-1);
}

/**
 * The placement for the mode chosen when the approval opened, recomputed from the layout as it is
 * now: a column of its own turns into an overlay once the tree reaches two splits (an agent's
 * `--split` page, Split Down), and an overlay whose split was closed gets a column of its own.
 */
export function approvalPlacement(mode: StageApprovalPlacement | null, layout: SessionPanelLayout | null | undefined): StageApprovalPlacement | null {
  if (!mode) return null;
  const covers = approvalTargetGroups(layout).length > 0;
  if (covers && (mode === 'over' || (layout !== null && layout !== undefined && !canSplitLayout(layout.root)))) return 'over';
  return 'split';
}

