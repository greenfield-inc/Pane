import { describe, expect, it } from 'vitest';
import type { PanelGroupNode, PanelLayoutNode, SessionPanelLayout } from '../../../shared/types/panels';
import { approvalPlacement, approvalTargetGroups } from './stageApprovalPlacement';

const group = (id: string, panelIds: string[]): PanelGroupNode => ({ type: 'group', id, panelIds, activePanelId: panelIds[0] ?? null });
const layoutOf = (root: PanelLayoutNode): SessionPanelLayout => ({ version: 1, root, focusedGroupId: 'chat' });
const one = layoutOf(group('chat', ['agent', 'overview']));
const sideBySide = layoutOf({ type: 'split', id: 's', direction: 'row', sizes: [0.5, 0.5], children: [group('chat', ['agent']), group('side', ['overview'])] });
const stacked = layoutOf({ type: 'split', id: 's', direction: 'column', sizes: [0.5, 0.5], children: [group('chat', ['agent']), group('below', ['overview'])] });

describe('where a Session\'s approval shows (D-261, D-448)', () => {
  it('opens a column of its own beside a single group: that column is the second split', () => {
    expect(approvalTargetGroups(one)).toEqual([]);
    expect(approvalPlacement('split', one)).toBe('split');
  });

  it('lays over the right split', () => {
    expect(approvalTargetGroups(sideBySide).map(g => g.id)).toEqual(['side']);
  });

  it('at two stacked splits (Split Down), lays over the lower one instead of opening a third column', () => {
    expect(approvalTargetGroups(stacked).map(g => g.id)).toEqual(['below']);
    expect(approvalPlacement('over', stacked)).toBe('over');
  });

  it('a column opened at one group turns into an overlay once the tree grows to two splits', () => {
    expect(approvalPlacement('split', sideBySide)).toBe('over');
    expect(approvalPlacement('split', stacked)).toBe('over');
  });

  it('an overlay whose split was closed gets a column of its own', () => {
    expect(approvalPlacement('over', one)).toBe('split');
  });

  it('shows nothing while no approval is open', () => {
    expect(approvalPlacement(null, sideBySide)).toBeNull();
  });
});
