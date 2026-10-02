/**
 * Unit tests for the pure Session tile operations, the outer twin of
 * `panelLayout.test.ts`.
 *
 * Everything here is data-in/data-out: no DOM, no React. Trees are built with
 * fixed ids so node-id stability through a move can be asserted directly.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_SESSION_TILES,
  decodeSessionWorkspaceLayout,
  type SessionLayoutNode,
  type SessionSplitNode,
  type SessionTileNode,
  type SessionWorkspaceLayout,
} from '../../../shared/types/sessionWorkspaceLayout';
import {
  allSessionTiles,
  canAddSessionTile,
  closeSessionTile,
  createSessionWorkspaceLayout,
  dropSessionOnTile,
  findSessionTileInDirection,
  findTileForSession,
  focusSessionTile,
  focusedSessionId,
  focusedSessionTile,
  reconcileSessionWorkspaceLayout,
  resizeSessionSplit,
  showSessionInLayout,
  splitSessionTile,
  tiledSessionIds,
} from './sessionWorkspaceLayout';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function tile(id: string, sessionId: string): SessionTileNode {
  return { type: 'session', id, sessionId };
}

function split(
  id: string,
  direction: 'row' | 'column',
  children: SessionLayoutNode[],
  sizes?: number[],
): SessionSplitNode {
  return { type: 'split', id, direction, children, sizes: sizes ?? children.map(() => 1 / children.length) };
}

function layoutOf(root: SessionLayoutNode, focusedTileId?: string): SessionWorkspaceLayout {
  return { version: 1, root, focusedTileId: focusedTileId ?? allSessionTiles(root)[0].id };
}

function requireSplit(node: SessionLayoutNode): SessionSplitNode {
  if (node.type !== 'split') throw new Error(`Expected split, received ${node.type}`);
  return node;
}

// ---------------------------------------------------------------------------
// Create, inspect, focus
// ---------------------------------------------------------------------------

describe('createSessionWorkspaceLayout', () => {
  it('starts as the whole window showing one Session', () => {
    const layout = createSessionWorkspaceLayout('s1');
    expect(layout.root.type).toBe('session');
    expect(tiledSessionIds(layout.root)).toEqual(['s1']);
    expect(focusedSessionId(layout)).toBe('s1');
    expect(layout.focusedTileId).toBe(layout.root.id);
  });
});

describe('focus', () => {
  it('falls back to the first tile when the focused id is unknown', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]), 'gone');
    expect(focusedSessionTile(layout).id).toBe('t1');
  });

  it('ignores a focus request for a tile that is not there', () => {
    const layout = layoutOf(tile('t1', 's1'));
    expect(focusSessionTile(layout, 'nope')).toBe(layout);
  });
});

describe('showSessionInLayout', () => {
  it('focuses the tile a Session already has', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]), 't1');
    const next = showSessionInLayout(layout, 's2');
    expect(next.focusedTileId).toBe('t2');
    expect(tiledSessionIds(next.root)).toEqual(['s1', 's2']);
  });

  it('replaces the focused tile when the Session is not on screen', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]), 't2');
    const next = showSessionInLayout(layout, 's3');
    expect(tiledSessionIds(next.root)).toEqual(['s1', 's3']);
    expect(next.focusedTileId).toBe('t2');
  });

  it('is a plain Session switch while the window shows one tile', () => {
    const layout = createSessionWorkspaceLayout('s1');
    const next = showSessionInLayout(layout, 's2');
    expect(next.root.type).toBe('session');
    expect(tiledSessionIds(next.root)).toEqual(['s2']);
  });
});

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

describe('dropSessionOnTile — edges', () => {
  it('splits the window and focuses the Session that arrived', () => {
    const layout = createSessionWorkspaceLayout('s1');
    const next = dropSessionOnTile(layout, layout.root.id, 's2', 'right');
    const root = requireSplit(next.root);
    expect(root.direction).toBe('row');
    expect(tiledSessionIds(root)).toEqual(['s1', 's2']);
    expect(focusedSessionId(next)).toBe('s2');
  });

  it('drops before the target for a left or top edge', () => {
    const layout = createSessionWorkspaceLayout('s1');
    expect(tiledSessionIds(dropSessionOnTile(layout, layout.root.id, 's2', 'left').root)).toEqual(['s2', 's1']);
    const below = dropSessionOnTile(layout, layout.root.id, 's2', 'bottom');
    expect(requireSplit(below.root).direction).toBe('column');
    expect(tiledSessionIds(below.root)).toEqual(['s1', 's2']);
  });

  it('inserts a sibling rather than nesting when the direction already matches', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]));
    const next = dropSessionOnTile(layout, 't2', 's3', 'right');
    const root = requireSplit(next.root);
    expect(root.id).toBe('x');
    expect(root.children).toHaveLength(3);
    expect(root.children.every(child => child.type === 'session')).toBe(true);
    expect(tiledSessionIds(root)).toEqual(['s1', 's2', 's3']);
  });

  it('nests when the direction differs', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]));
    const next = dropSessionOnTile(layout, 't2', 's3', 'bottom');
    const root = requireSplit(next.root);
    expect(root.direction).toBe('row');
    expect(root.children[0]).toEqual(tile('t1', 's1'));
    const nested = requireSplit(root.children[1]);
    expect(nested.direction).toBe('column');
    expect(tiledSessionIds(nested)).toEqual(['s2', 's3']);
  });

  it('moves a Session that is already tiled instead of showing it twice', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2'), tile('t3', 's3')]));
    const next = dropSessionOnTile(layout, 't1', 's3', 'bottom');
    expect(allSessionTiles(next.root)).toHaveLength(3);
    expect(tiledSessionIds(next.root)).toEqual(['s1', 's3', 's2']);
    // The moved tile keeps its node id, so focus and the layout agree.
    expect(findTileForSession(next.root, 's3')?.id).toBe('t3');
    expect(next.focusedTileId).toBe('t3');
  });

  it('leaves the layout alone when a Session is dropped on its own tile', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]));
    expect(dropSessionOnTile(layout, 't2', 's2', 'right')).toBe(layout);
  });

  it('unwraps the split a move empties', () => {
    const layout = layoutOf(split('x', 'row', [
      tile('t1', 's1'),
      split('y', 'column', [tile('t2', 's2'), tile('t3', 's3')]),
    ]));
    const next = dropSessionOnTile(layout, 't1', 's3', 'left');
    const root = requireSplit(next.root);
    expect(root.direction).toBe('row');
    expect(tiledSessionIds(root)).toEqual(['s3', 's1', 's2']);
    expect(root.children.every(child => child.type === 'session')).toBe(true);
  });

  it('refuses a new tile once the layout is full', () => {
    const tiles = Array.from({ length: MAX_SESSION_TILES }, (_, index) => tile(`t${index}`, `s${index}`));
    const layout = layoutOf(split('x', 'row', tiles));
    expect(canAddSessionTile(layout)).toBe(false);
    expect(dropSessionOnTile(layout, 't0', 'extra', 'right')).toBe(layout);
    // Rearranging what is already there still works.
    expect(dropSessionOnTile(layout, 't0', 's5', 'bottom')).not.toBe(layout);
  });
});

describe('dropSessionOnTile — center', () => {
  it('puts an untiled Session in the slot', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]), 't1');
    const next = dropSessionOnTile(layout, 't2', 's9', 'center');
    expect(tiledSessionIds(next.root)).toEqual(['s1', 's9']);
    expect(next.focusedTileId).toBe('t2');
  });

  it('trades places when the dragged Session is already tiled', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2'), tile('t3', 's3')]));
    const next = dropSessionOnTile(layout, 't1', 's3', 'center');
    expect(tiledSessionIds(next.root)).toEqual(['s3', 's2', 's1']);
    expect(next.focusedTileId).toBe('t1');
  });

  it('only focuses when a Session is dropped on itself', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]), 't1');
    const next = dropSessionOnTile(layout, 't2', 's2', 'center');
    expect(next.focusedTileId).toBe('t2');
    expect(next.root).toBe(layout.root);
  });
});

describe('splitSessionTile', () => {
  it('is the keyboard route to an edge drop', () => {
    const layout = createSessionWorkspaceLayout('s1');
    const next = splitSessionTile(layout, layout.root.id, 's2', 'column');
    expect(requireSplit(next.root).direction).toBe('column');
    expect(tiledSessionIds(next.root)).toEqual(['s1', 's2']);
  });
});

// ---------------------------------------------------------------------------
// Close and resize
// ---------------------------------------------------------------------------

describe('closeSessionTile', () => {
  it('removes the tile and collapses the split it emptied', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]), 't2');
    const next = closeSessionTile(layout, 't2');
    expect(next.root).toEqual(tile('t1', 's1'));
    expect(next.focusedTileId).toBe('t1');
  });

  it('focuses the next tile in reading order', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2'), tile('t3', 's3')]), 't2');
    expect(closeSessionTile(layout, 't2').focusedTileId).toBe('t3');
    expect(closeSessionTile(layout, 't3').focusedTileId).toBe('t2');
  });

  it('never closes the last tile — a window with no Session has nothing to show', () => {
    const layout = createSessionWorkspaceLayout('s1');
    expect(closeSessionTile(layout, layout.root.id)).toBe(layout);
  });

  it('ignores an unknown tile', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]));
    expect(closeSessionTile(layout, 'nope')).toBe(layout);
  });
});

describe('resizeSessionSplit', () => {
  it('writes the sizes of one split node', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]));
    const next = resizeSessionSplit(layout, 'x', [0.7, 0.3]);
    expect(requireSplit(next.root).sizes).toEqual([0.7, 0.3]);
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe('findSessionTileInDirection', () => {
  it('crosses the focused tile edge', () => {
    const layout = layoutOf(split('x', 'row', [
      tile('t1', 's1'),
      split('y', 'column', [tile('t2', 's2'), tile('t3', 's3')]),
    ]), 't2');
    expect(findSessionTileInDirection(layout, 'left')).toBe('t1');
    expect(findSessionTileInDirection(layout, 'down')).toBe('t3');
    expect(findSessionTileInDirection(layout, 'up')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe('reconcileSessionWorkspaceLayout', () => {
  it('reports an unchanged layout as unchanged', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]));
    const result = reconcileSessionWorkspaceLayout(layout, ['s1', 's2']);
    expect(result.changed).toBe(false);
    expect(tiledSessionIds(result.layout!.root)).toEqual(['s1', 's2']);
  });

  it('retires the tile of a Session that is gone', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')]), 't2');
    const result = reconcileSessionWorkspaceLayout(layout, ['s1']);
    expect(result.changed).toBe(true);
    expect(result.layout!.root).toEqual(tile('t1', 's1'));
    expect(result.layout!.focusedTileId).toBe('t1');
  });

  it('keeps only the first tile of a Session that somehow appears twice', () => {
    const layout = layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's1')]));
    const result = reconcileSessionWorkspaceLayout(layout, ['s1']);
    expect(result.changed).toBe(true);
    expect(result.layout!.root).toEqual(tile('t1', 's1'));
  });

  it('returns no layout when nothing live is left', () => {
    const layout = layoutOf(tile('t1', 's1'));
    expect(reconcileSessionWorkspaceLayout(layout, [])).toEqual({ layout: null, changed: true });
  });
});

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

describe('decodeSessionWorkspaceLayout', () => {
  it('reads back a layout it wrote', () => {
    const layout = layoutOf(split('x', 'row', [
      tile('t1', 's1'),
      split('y', 'column', [tile('t2', 's2'), tile('t3', 's3')]),
    ]), 't3');
    expect(decodeSessionWorkspaceLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });

  it('rejects anything that is not a usable layout', () => {
    expect(decodeSessionWorkspaceLayout(null)).toBeNull();
    expect(decodeSessionWorkspaceLayout({ version: 2, root: tile('t1', 's1') })).toBeNull();
    // The same Session twice, duplicate node ids, and empty splits are all
    // shapes the renderer must never be handed.
    expect(decodeSessionWorkspaceLayout(layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t2', 's1')])))).toBeNull();
    expect(decodeSessionWorkspaceLayout(layoutOf(split('x', 'row', [tile('t1', 's1'), tile('t1', 's2')])))).toBeNull();
    expect(decodeSessionWorkspaceLayout({ version: 1, root: split('x', 'row', [], []) })).toBeNull();
  });

  it('rejects split sizes that do not line up with the children', () => {
    expect(decodeSessionWorkspaceLayout({
      version: 1,
      root: split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')], [1]),
    })).toBeNull();
    expect(decodeSessionWorkspaceLayout({
      version: 1,
      root: split('x', 'row', [tile('t1', 's1'), tile('t2', 's2')], [1, 0]),
    })).toBeNull();
  });

  it('rejects a layout with more tiles than the renderer will mount', () => {
    const tiles = Array.from({ length: MAX_SESSION_TILES + 1 }, (_, index) => tile(`t${index}`, `s${index}`));
    expect(decodeSessionWorkspaceLayout(layoutOf(split('x', 'row', tiles)))).toBeNull();
  });

  it('drops a focus marker that names no tile', () => {
    const decoded = decodeSessionWorkspaceLayout({ version: 1, root: tile('t1', 's1'), focusedTileId: 'gone' });
    expect(decoded).toEqual({ version: 1, root: tile('t1', 's1') });
  });
});
