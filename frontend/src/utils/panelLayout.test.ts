/**
 * Unit tests for the pure layout tree operations behind split tab groups.
 *
 * Everything here is pure data-in/data-out: no DOM, no React. Trees are built
 * with fixed ids so id stability through normalize can be asserted directly.
 */

import { describe, it, expect } from 'vitest';
import type {
  PanelGroupNode,
  PanelSplitNode,
  PanelLayoutNode,
  SessionPanelLayout,
} from '../../../shared/types/panels';
import {
  primaryGroup,
  allGroups,
  allPanelIds,
  findGroup,
  findGroupContainingPanel,
  activatePanelInLayout,
  createSingleGroupLayout,
  addPanelToGroup,
  normalize,
  splitGroup,
  movePanel,
  removePanelFromLayout,
  reconcile,
  updateSizes,
  groupRects,
  findGroupInDirection,
  dropZoneFor,
  subsetInsertIndex,
  mergeAllGroups,
} from './panelLayout';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function group(id: string, panelIds: string[], activePanelId?: string | null): PanelGroupNode {
  return { type: 'group', id, panelIds, activePanelId: activePanelId ?? panelIds[0] ?? null };
}

function split(
  id: string,
  direction: 'row' | 'column',
  children: PanelLayoutNode[],
  sizes?: number[],
): PanelSplitNode {
  return { type: 'split', id, direction, children, sizes: sizes ?? children.map(() => 1 / children.length) };
}

function layoutOf(root: PanelLayoutNode, extra?: Partial<SessionPanelLayout>): SessionPanelLayout {
  return { version: 1, root, focusedGroupId: primaryGroup(root).id, ...extra };
}

function requireGroup(node: PanelLayoutNode): PanelGroupNode {
  if (node.type !== 'group') throw new Error(`Expected group, received ${node.type}`);
  return node;
}

function requireSplit(node: PanelLayoutNode): PanelSplitNode {
  if (node.type !== 'split') throw new Error(`Expected split, received ${node.type}`);
  return node;
}

function requireFoundGroup(node: PanelLayoutNode, id: string): PanelGroupNode {
  const found = findGroup(node, id);
  if (!found) throw new Error(`Expected group ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Tree queries
// ---------------------------------------------------------------------------

describe('tree queries', () => {
  const tree = split('s1', 'row', [
    group('g1', ['a', 'b']),
    split('s2', 'column', [group('g2', ['c']), group('g3', ['d'])]),
  ]);

  it('primaryGroup returns the leftmost/topmost leaf', () => {
    expect(primaryGroup(tree).id).toBe('g1');
  });

  it('allGroups walks depth-first in reading order', () => {
    expect(allGroups(tree).map(g => g.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('allPanelIds collects every panel in reading order', () => {
    expect(allPanelIds(tree)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('findGroup and findGroupContainingPanel locate nested groups', () => {
    expect(findGroup(tree, 'g3')?.panelIds).toEqual(['d']);
    expect(findGroup(tree, 'nope')).toBeNull();
    expect(findGroupContainingPanel(tree, 'c')?.id).toBe('g2');
    expect(findGroupContainingPanel(tree, 'nope')).toBeNull();
  });
});

describe('activatePanelInLayout', () => {
  it('activates the requested panel and focuses its split group', () => {
    const layout = layoutOf(split('s1', 'row', [
      group('g1', ['a', 'b'], 'a'),
      group('g2', ['c', 'd'], 'c'),
    ]), { focusedGroupId: 'g1' });

    const result = activatePanelInLayout(layout, 'd');

    expect(findGroup(result.root, 'g1')?.activePanelId).toBe('a');
    expect(findGroup(result.root, 'g2')?.activePanelId).toBe('d');
    expect(result.focusedGroupId).toBe('g2');
  });

  it('exits zoom when activating a panel in another group', () => {
    const layout = layoutOf(split('s1', 'row', [
      group('g1', ['a']),
      group('g2', ['b']),
    ]), { focusedGroupId: 'g1', zoomedGroupId: 'g1' });

    expect(activatePanelInLayout(layout, 'b').zoomedGroupId).toBeNull();
  });

  it('returns the same layout when the panel is not present', () => {
    const layout = layoutOf(group('g1', ['a']));

    expect(activatePanelInLayout(layout, 'missing')).toBe(layout);
  });
});

// ---------------------------------------------------------------------------
// createSingleGroupLayout / addPanelToGroup
// ---------------------------------------------------------------------------

describe('createSingleGroupLayout', () => {
  it('uses the requested active panel when present', () => {
    const layout = createSingleGroupLayout(['a', 'b'], 'b');
    expect(layout.root.type).toBe('group');
    expect(requireGroup(layout.root).activePanelId).toBe('b');
    expect(layout.focusedGroupId).toBe(layout.root.id);
  });

  it('falls back to the first panel when the active id is unknown', () => {
    const layout = createSingleGroupLayout(['a', 'b'], 'zzz');
    expect(requireGroup(layout.root).activePanelId).toBe('a');
  });

  it('handles an empty panel list', () => {
    const layout = createSingleGroupLayout([], null);
    expect(requireGroup(layout.root).panelIds).toEqual([]);
    expect(requireGroup(layout.root).activePanelId).toBeNull();
  });
});

describe('addPanelToGroup', () => {
  it('appends the panel and makes it active', () => {
    const root = group('g1', ['a'], 'a');
    const next = requireGroup(addPanelToGroup(root, 'g1', 'b'));
    expect(next.panelIds).toEqual(['a', 'b']);
    expect(next.activePanelId).toBe('b');
  });

  it('appends the panel without activating it when requested', () => {
    const root = group('g1', ['a'], 'a');
    const next = requireGroup(addPanelToGroup(root, 'g1', 'b', { activate: false }));
    expect(next.panelIds).toEqual(['a', 'b']);
    expect(next.activePanelId).toBe('a');
  });

  it('is idempotent: returns the same tree when the panel exists anywhere', () => {
    const root = split('s1', 'row', [group('g1', ['a']), group('g2', ['b'])]);
    expect(addPanelToGroup(root, 'g1', 'b')).toBe(root);
    expect(addPanelToGroup(root, 'g1', 'a')).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

describe('normalize', () => {
  it('returns groups unchanged and preserves ids', () => {
    const g = group('g1', ['a']);
    expect(normalize(g)).toBe(g);
  });

  it('drops empty groups and unwraps single-child splits, keeping ids', () => {
    const tree = split('s1', 'row', [group('g1', []), group('g2', ['a'])]);
    const result = normalize(tree);
    expect(result.type).toBe('group');
    expect(result.id).toBe('g2');
  });

  it('flattens same-direction nested splits with proportional sizes', () => {
    const tree = split('s1', 'row', [
      group('g1', ['a']),
      split('s2', 'row', [group('g2', ['b']), group('g3', ['c'])], [0.5, 0.5]),
    ], [0.5, 0.5]);
    const result = requireSplit(normalize(tree));
    expect(result.children.map(c => c.id)).toEqual(['g1', 'g2', 'g3']);
    expect(result.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('keeps differing-direction nesting intact', () => {
    const tree = split('s1', 'row', [
      group('g1', ['a']),
      split('s2', 'column', [group('g2', ['b']), group('g3', ['c'])]),
    ]);
    const result = requireSplit(normalize(tree));
    expect(result.children.map(c => c.id)).toEqual(['g1', 's2']);
  });

  it('renormalizes sizes to sum 1', () => {
    const tree = split('s1', 'row', [group('g1', ['a']), group('g2', ['b'])], [2, 6]);
    const result = requireSplit(normalize(tree));
    expect(result.sizes).toEqual([0.25, 0.75]);
  });
});

// ---------------------------------------------------------------------------
// splitGroup
// ---------------------------------------------------------------------------

describe('splitGroup', () => {
  it('wraps a root group into a 50/50 split', () => {
    const root = group('g1', ['a', 'b'], 'a');
    const result = requireSplit(splitGroup(root, 'g1', 'a', 'row'));
    expect(result.type).toBe('split');
    expect(result.direction).toBe('row');
    expect(result.sizes).toEqual([0.5, 0.5]);
    const [leftNode, rightNode] = result.children;
    if (!leftNode || !rightNode) throw new Error('Expected both split children');
    const left = requireGroup(leftNode);
    const right = requireGroup(rightNode);
    expect(left.id).toBe('g1');
    expect(left.panelIds).toEqual(['b']);
    expect(left.activePanelId).toBe('b');
    expect(right.panelIds).toEqual(['a']);
    expect(right.activePanelId).toBe('a');
  });

  it('inserts an n-ary sibling in a same-direction split, halving the source size', () => {
    const root = split('s1', 'row', [group('g1', ['a', 'b']), group('g2', ['c'])], [0.6, 0.4]);
    const result = requireSplit(splitGroup(root, 'g1', 'a', 'row'));
    expect(result.id).toBe('s1');
    expect(result.children).toHaveLength(3);
    expect(result.children.map(c => c.id)).toEqual(['g1', result.children[1].id, 'g2']);
    expect(result.sizes.map(s => Math.round(s * 100) / 100)).toEqual([0.3, 0.3, 0.4]);
  });

  it('nests a new split when the direction differs', () => {
    const root = split('s1', 'row', [group('g1', ['a', 'b']), group('g2', ['c'])]);
    const result = requireSplit(splitGroup(root, 'g1', 'a', 'column'));
    expect(result.id).toBe('s1');
    const firstChild = result.children[0];
    if (!firstChild) throw new Error('Expected nested split');
    const nested = requireSplit(firstChild);
    expect(nested.type).toBe('split');
    expect(nested.direction).toBe('column');
    expect(allPanelIds(nested)).toEqual(['b', 'a']);
  });

  it('splitting out a sole panel collapses the emptied source group', () => {
    const root = group('g1', ['a'], 'a');
    const result = splitGroup(root, 'g1', 'a', 'row');
    expect(result.type).toBe('group');
    expect(allPanelIds(result)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// movePanel
// ---------------------------------------------------------------------------

describe('movePanel center drops', () => {
  it('moves a panel into another group at the given index', () => {
    const root = split('s1', 'row', [group('g1', ['a', 'b'], 'a'), group('g2', ['c'], 'c')]);
    const result = requireSplit(movePanel(root, 'a', { groupId: 'g2', index: 0 }));
    const g1 = requireFoundGroup(result, 'g1');
    const g2 = requireFoundGroup(result, 'g2');
    expect(g1.panelIds).toEqual(['b']);
    expect(g1.activePanelId).toBe('b');
    expect(g2.panelIds).toEqual(['a', 'c']);
    expect(g2.activePanelId).toBe('a');
  });

  it('same-group rightward reorder lands at the drop indicator, not one past it', () => {
    const root = group('g1', ['a', 'b', 'c']);
    // Indicator before 'c' (index 2): expect [b, a, c]
    const result = requireGroup(movePanel(root, 'a', { groupId: 'g1', index: 2 }));
    expect(result.panelIds).toEqual(['b', 'a', 'c']);
  });

  it('same-group move to the end (index = length) appends', () => {
    const root = group('g1', ['a', 'b', 'c']);
    const result = requireGroup(movePanel(root, 'a', { groupId: 'g1', index: 3 }));
    expect(result.panelIds).toEqual(['b', 'c', 'a']);
  });

  it('same-group leftward reorder needs no index adjustment', () => {
    const root = group('g1', ['a', 'b', 'c']);
    const result = requireGroup(movePanel(root, 'c', { groupId: 'g1', index: 0 }));
    expect(result.panelIds).toEqual(['c', 'a', 'b']);
  });

  it('dropping a panel on its own position is a no-op order-wise', () => {
    const root = group('g1', ['a', 'b', 'c']);
    expect(requireGroup(movePanel(root, 'a', { groupId: 'g1', index: 0 })).panelIds)
      .toEqual(['a', 'b', 'c']);
    // Right half of its own tab resolves to index 1, adjusted back to 0
    expect(requireGroup(movePanel(root, 'a', { groupId: 'g1', index: 1 })).panelIds)
      .toEqual(['a', 'b', 'c']);
  });

  it('emptying the source group collapses it', () => {
    const root = split('s1', 'row', [group('g1', ['a']), group('g2', ['b'])]);
    const result = movePanel(root, 'a', { groupId: 'g2', index: 1 });
    expect(result.type).toBe('group');
    expect(result.id).toBe('g2');
    expect(requireGroup(result).panelIds).toEqual(['b', 'a']);
  });
});

describe('movePanel edge drops', () => {
  it('splits against the target group in the edge direction', () => {
    const root = split('s1', 'row', [group('g1', ['a', 'b'], 'a'), group('g2', ['c'])]);
    const result = requireSplit(movePanel(root, 'a', { groupId: 'g2', edge: 'bottom' }));
    expect(result.id).toBe('s1');
    const secondChild = result.children[1];
    if (!secondChild) throw new Error('Expected nested split');
    const nested = requireSplit(secondChild);
    expect(nested.type).toBe('split');
    expect(nested.direction).toBe('column');
    const firstNestedChild = nested.children[0];
    const secondNestedChild = nested.children[1];
    if (!firstNestedChild || !secondNestedChild) throw new Error('Expected both nested groups');
    expect(requireGroup(firstNestedChild).panelIds).toEqual(['c']);
    expect(requireGroup(secondNestedChild).panelIds).toEqual(['a']);
  });

  it('inserts an n-ary sibling when the edge matches the parent direction', () => {
    const root = split('s1', 'row', [group('g1', ['a', 'b']), group('g2', ['c'])], [0.5, 0.5]);
    const result = requireSplit(movePanel(root, 'a', { groupId: 'g2', edge: 'right' }));
    expect(result.id).toBe('s1');
    expect(result.children).toHaveLength(3);
    expect(allPanelIds(result)).toEqual(['b', 'c', 'a']);
    expect(result.sizes.map(s => Math.round(s * 100) / 100)).toEqual([0.5, 0.25, 0.25]);
  });

  it('never loses a panel when a sole tab is edge-dropped onto its own group', () => {
    const root = group('g1', ['a'], 'a');
    const result = movePanel(root, 'a', { groupId: 'g1', edge: 'right' });
    expect(allPanelIds(result)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// removePanelFromLayout
// ---------------------------------------------------------------------------

describe('removePanelFromLayout', () => {
  it('removes a panel and reassigns the group active id', () => {
    const root = group('g1', ['a', 'b'], 'a');
    const removed = removePanelFromLayout(root, 'a');
    if (!removed) throw new Error('Expected surviving group');
    const result = requireGroup(removed);
    expect(result.panelIds).toEqual(['b']);
    expect(result.activePanelId).toBe('b');
  });

  it('collapses the split when a group empties, preserving the survivor id', () => {
    const root = split('s1', 'row', [group('g1', ['a']), group('g2', ['b'])]);
    const result = removePanelFromLayout(root, 'a');
    expect(result?.type).toBe('group');
    expect(result?.id).toBe('g2');
  });

  it('returns null when the whole tree collapses', () => {
    expect(removePanelFromLayout(group('g1', ['a']), 'a')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  it('reports no change for a layout matching the live panels', () => {
    const layout = layoutOf(split('s1', 'row', [group('g1', ['a']), group('g2', ['b'])]));
    const { layout: result, changed } = reconcile(layout, ['a', 'b']);
    expect(changed).toBe(false);
    expect(allPanelIds(result.root)).toEqual(['a', 'b']);
  });

  it('prunes dead panel ids and collapses emptied groups', () => {
    const layout = layoutOf(split('s1', 'row', [group('g1', ['a']), group('g2', ['dead'])]));
    const { layout: result, changed } = reconcile(layout, ['a']);
    expect(changed).toBe(true);
    expect(result.root.type).toBe('group');
    expect(allPanelIds(result.root)).toEqual(['a']);
  });

  it('drops duplicate panel ids, keeping the first in reading order', () => {
    const layout = layoutOf(split('s1', 'row', [group('g1', ['a', 'b']), group('g2', ['a', 'c'])]));
    const { layout: result, changed } = reconcile(layout, ['a', 'b', 'c']);
    expect(changed).toBe(true);
    expect(findGroup(result.root, 'g1')?.panelIds).toEqual(['a', 'b']);
    expect(findGroup(result.root, 'g2')?.panelIds).toEqual(['c']);
  });

  it('adopts orphan live panels into the primary group', () => {
    const layout = layoutOf(split('s1', 'row', [group('g1', ['a']), group('g2', ['b'])]));
    const { layout: result, changed } = reconcile(layout, ['a', 'b', 'new1', 'new2']);
    expect(changed).toBe(true);
    expect(findGroup(result.root, 'g1')?.panelIds).toEqual(['a', 'new1', 'new2']);
  });

  it('repairs a dead focusedGroupId and clears a dead zoomedGroupId', () => {
    const layout = layoutOf(split('s1', 'row', [group('g1', ['a']), group('g2', ['b'])]), {
      focusedGroupId: 'gone',
      zoomedGroupId: 'gone',
    });
    const { layout: result, changed } = reconcile(layout, ['a', 'b']);
    expect(changed).toBe(true);
    expect(result.focusedGroupId).toBe('g1');
    expect(result.zoomedGroupId).toBeNull();
  });

  it('rebuilds a fully-collapsed tree from the live panel list', () => {
    const layout = layoutOf(group('g1', ['dead1', 'dead2']));
    const { layout: result, changed } = reconcile(layout, ['a', 'b']);
    expect(changed).toBe(true);
    expect(result.root.type).toBe('group');
    expect(allPanelIds(result.root)).toEqual(['a', 'b']);
  });

  it('fixes a group activePanelId that no longer exists', () => {
    const layout = layoutOf(group('g1', ['a', 'b'], 'b'));
    const { layout: result, changed } = reconcile({
      ...layout,
      root: { ...requireGroup(layout.root), activePanelId: 'dead' },
    }, ['a', 'b']);
    expect(changed).toBe(true);
    expect(requireGroup(result.root).activePanelId).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// updateSizes
// ---------------------------------------------------------------------------

describe('updateSizes', () => {
  it('updates only the target split node', () => {
    const root = split('s1', 'row', [
      group('g1', ['a']),
      split('s2', 'column', [group('g2', ['b']), group('g3', ['c'])], [0.5, 0.5]),
    ], [0.5, 0.5]);
    const result = requireSplit(updateSizes(root, 's2', [0.7, 0.3]));
    expect(result.sizes).toEqual([0.5, 0.5]);
    const nested = result.children[1];
    if (!nested) throw new Error('Expected nested split');
    expect(requireSplit(nested).sizes).toEqual([0.7, 0.3]);
  });
});

// ---------------------------------------------------------------------------
// Geometry: groupRects / findGroupInDirection
// ---------------------------------------------------------------------------

describe('directional focus geometry', () => {
  // 2x2 grid: row of two columns
  // g1 g2
  // g3 g4
  const grid = split('s1', 'row', [
    split('s2', 'column', [group('g1', ['a']), group('g3', ['c'])]),
    split('s3', 'column', [group('g2', ['b']), group('g4', ['d'])]),
  ]);

  it('assigns unit-space rects by split proportions', () => {
    const rects = groupRects(grid);
    expect(rects.get('g1')).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rects.get('g4')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('finds neighbors in each direction', () => {
    expect(findGroupInDirection(grid, 'g1', 'right')).toBe('g2');
    expect(findGroupInDirection(grid, 'g1', 'down')).toBe('g3');
    expect(findGroupInDirection(grid, 'g4', 'up')).toBe('g2');
    expect(findGroupInDirection(grid, 'g4', 'left')).toBe('g3');
  });

  it('returns null at the edges', () => {
    expect(findGroupInDirection(grid, 'g1', 'left')).toBeNull();
    expect(findGroupInDirection(grid, 'g1', 'up')).toBeNull();
    expect(findGroupInDirection(grid, 'g4', 'right')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mergeAllGroups
// ---------------------------------------------------------------------------

describe('mergeAllGroups', () => {
  it('returns a single group unchanged', () => {
    const g = group('g1', ['a', 'b'], 'b');
    expect(mergeAllGroups(g)).toBe(g);
  });

  it('collapses a nested tree into the primary group, preserving id, order, and active', () => {
    const tree = split('s1', 'row', [
      group('g1', ['a', 'b'], 'b'),
      split('s2', 'column', [group('g2', ['c']), group('g3', ['d'])]),
    ]);
    const merged = mergeAllGroups(tree);
    expect(merged.id).toBe('g1');
    expect(merged.panelIds).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.activePanelId).toBe('b');
  });

  it('dedupes panel ids, keeping the first occurrence', () => {
    const tree = split('s1', 'row', [group('g1', ['a', 'b']), group('g2', ['a', 'c'])]);
    const merged = mergeAllGroups(tree);
    expect(merged.panelIds).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// subsetInsertIndex
// ---------------------------------------------------------------------------

describe('subsetInsertIndex', () => {
  // Full group order: permanent tabs (d, e) interleaved with working tabs
  const full = ['d', 't1', 'e', 't2', 't3'];

  it('maps a subset index to the position of that panel in the full order', () => {
    const working = ['t1', 't2', 't3'];
    expect(subsetInsertIndex(full, working, 0)).toBe(1); // before t1
    expect(subsetInsertIndex(full, working, 1)).toBe(3); // before t2
    expect(subsetInsertIndex(full, working, 2)).toBe(4); // before t3
  });

  it('maps an end-of-subset drop to just after the last subset panel', () => {
    const working = ['t1', 't2', 't3'];
    expect(subsetInsertIndex(full, working, 3)).toBe(5);
    expect(subsetInsertIndex(['d', 't1', 'e'], ['t1'], 1)).toBe(2);
  });

  it('appends to the full list when the subset is empty', () => {
    expect(subsetInsertIndex(full, [], 0)).toBe(5);
  });

  it('falls back to the end for unknown subset ids', () => {
    expect(subsetInsertIndex(full, ['zzz'], 0)).toBe(5);
    expect(subsetInsertIndex(full, ['zzz'], 1)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// dropZoneFor
// ---------------------------------------------------------------------------

describe('dropZoneFor', () => {
  const rect: DOMRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    }),
  };

  it('returns center inside the inner band', () => {
    expect(dropZoneFor(50, 50, rect)).toBe('center');
  });

  it('returns the nearest edge inside the 25% bands', () => {
    expect(dropZoneFor(10, 50, rect)).toBe('left');
    expect(dropZoneFor(90, 50, rect)).toBe('right');
    expect(dropZoneFor(50, 10, rect)).toBe('top');
    expect(dropZoneFor(50, 90, rect)).toBe('bottom');
  });

  it('picks the closest edge in a corner', () => {
    expect(dropZoneFor(5, 20, rect)).toBe('left');
    expect(dropZoneFor(20, 5, rect)).toBe('top');
  });
});
