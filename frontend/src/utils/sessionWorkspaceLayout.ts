/**
 * Pure layout tree operations for tiled Sessions — the outer twin of
 * `panelLayout`.
 *
 * A leaf here is one Session filling a region of the window; a leaf there is a
 * tab group inside one Pane. The structural algebra the two share (normalize,
 * sizes, geometry, sibling insertion, drop zones) lives in `layoutTree`; this
 * module adds only what it means to be a Session tile:
 *
 * - A Session appears at most once, so moving a tiled Session moves its tile
 *   instead of cloning it.
 * - A tile is never empty, so the tree only ever shrinks by losing whole tiles.
 * - A center drop puts the dragged Session in that slot, swapping with the
 *   dragged Session's own tile when it already has one.
 *
 * Every function is side-effect-free and returns a new layout. Node ids are
 * never regenerated for a surviving node — React keys depend on stability.
 *
 * @module sessionWorkspaceLayout
 */

import {
  allLeaves,
  findLeaf,
  findLeafInDirection,
  firstLeaf,
  insertLeafBeside,
  mapLeaves,
  newLayoutId,
  normalizeTree,
  removeLeaf,
  splitForEdge,
  updateSplitSizes,
} from './layoutTree';
import type { DropZone, LayoutDirection } from './layoutTree';
import {
  MAX_SESSION_TILES,
  SESSION_WORKSPACE_LAYOUT_VERSION,
  type SessionLayoutNode,
  type SessionTileNode,
  type SessionWorkspaceLayout,
} from '../../../shared/types/sessionWorkspaceLayout';

/** Tiles always hold a Session, so nothing is ever dropped as empty. */
const NEVER_EMPTY = () => false;

export interface ReconciledSessionWorkspaceLayout {
  /** Null when no live Session is left to show. */
  layout: SessionWorkspaceLayout | null;
  changed: boolean;
}

function tile(sessionId: string): SessionTileNode {
  return { type: 'session', id: newLayoutId(), sessionId };
}

/** The whole window showing one Session — the shape every layout starts as. */
export function createSessionWorkspaceLayout(sessionId: string): SessionWorkspaceLayout {
  const root = tile(sessionId);
  return { version: SESSION_WORKSPACE_LAYOUT_VERSION, root, focusedTileId: root.id };
}

/** Every tile in reading order (left to right, top to bottom). */
export function allSessionTiles(root: SessionLayoutNode): SessionTileNode[] {
  return allLeaves<SessionTileNode>(root);
}

/** The Sessions on screen, in reading order. */
export function tiledSessionIds(root: SessionLayoutNode): string[] {
  return allSessionTiles(root).map(node => node.sessionId);
}

function findSessionTile(root: SessionLayoutNode, tileId: string): SessionTileNode | null {
  return findLeaf<SessionTileNode>(root, tileId);
}

export function findTileForSession(root: SessionLayoutNode, sessionId: string): SessionTileNode | null {
  return allSessionTiles(root).find(node => node.sessionId === sessionId) ?? null;
}

/** The tile that owns focus, falling back to the first one. */
export function focusedSessionTile(layout: SessionWorkspaceLayout): SessionTileNode {
  const focused = layout.focusedTileId ? findSessionTile(layout.root, layout.focusedTileId) : null;
  return focused ?? firstLeaf<SessionTileNode>(layout.root);
}

/** The focused tile's Session — the one the rest of the app treats as selected. */
export function focusedSessionId(layout: SessionWorkspaceLayout): string {
  return focusedSessionTile(layout).sessionId;
}

/** Whether another tile would fit. See MAX_SESSION_TILES for why there is a bound at all. */
export function canAddSessionTile(layout: SessionWorkspaceLayout): boolean {
  return allSessionTiles(layout.root).length < MAX_SESSION_TILES;
}

function withLayout(
  layout: SessionWorkspaceLayout,
  root: SessionLayoutNode,
  focusedTileId: string,
): SessionWorkspaceLayout {
  const focused = findSessionTile(root, focusedTileId);
  return {
    ...layout,
    root,
    focusedTileId: (focused ?? firstLeaf<SessionTileNode>(root)).id,
  };
}

/** Move keyboard focus to a tile. Unknown ids leave the layout alone. */
export function focusSessionTile(layout: SessionWorkspaceLayout, tileId: string): SessionWorkspaceLayout {
  if (layout.focusedTileId === tileId) return layout;
  if (!findSessionTile(layout.root, tileId)) return layout;
  return { ...layout, focusedTileId: tileId };
}

/**
 * Show a Session, the way clicking it in the sidebar should: focus its tile
 * when it is already on screen, otherwise it takes over the focused tile.
 *
 * With a single tile this is exactly the pre-tiling behaviour — switching
 * Session replaces what the window shows.
 */
export function showSessionInLayout(layout: SessionWorkspaceLayout, sessionId: string): SessionWorkspaceLayout {
  const existing = findTileForSession(layout.root, sessionId);
  if (existing) return focusSessionTile(layout, existing.id);
  const target = focusedSessionTile(layout);
  const root = mapLeaves<SessionTileNode>(
    layout.root,
    node => node.id === target.id ? { ...node, sessionId } : node,
  );
  return withLayout(layout, root, target.id);
}

/**
 * Drop a Session onto a tile.
 *
 * - An edge zone splits against that tile, 25% bands as everywhere else.
 * - The center zone puts the Session in that slot; if the dragged Session is
 *   already tiled, the two tiles trade places instead of one disappearing.
 *
 * A Session that is already tiled keeps its tile node, so an edge drop moves
 * the tile rather than adding a second view of the same Session.
 */
export function dropSessionOnTile(
  layout: SessionWorkspaceLayout,
  targetTileId: string,
  sessionId: string,
  zone: DropZone,
): SessionWorkspaceLayout {
  const target = findSessionTile(layout.root, targetTileId);
  if (!target) return layout;
  const existing = findTileForSession(layout.root, sessionId);

  if (zone === 'center') {
    if (target.sessionId === sessionId) return focusSessionTile(layout, target.id);
    const displaced = target.sessionId;
    const root = mapLeaves<SessionTileNode>(layout.root, node => {
      if (node.id === target.id) return { ...node, sessionId };
      if (existing && node.id === existing.id) return { ...node, sessionId: displaced };
      return node;
    });
    return withLayout(layout, root, target.id);
  }

  // Edge drop. Dropping a Session against its own tile changes nothing.
  if (existing && existing.id === target.id) return layout;
  if (!existing && !canAddSessionTile(layout)) return layout;

  const moving: SessionTileNode = existing ?? tile(sessionId);
  const base = existing
    ? removeLeaf<SessionTileNode>(layout.root, existing.id, NEVER_EMPTY)
    : layout.root;
  // The target has to survive the removal, or there is nothing to split against.
  if (!base || !findSessionTile(base, target.id)) return layout;

  const { direction, after } = splitForEdge(zone);
  const root = insertLeafBeside<SessionTileNode>(base, target.id, moving, direction, after);
  const normalized = normalizeTree<SessionTileNode>(root, NEVER_EMPTY) ?? root;
  return withLayout(layout, normalized, moving.id);
}

/**
 * Split a tile in a direction and show `sessionId` in the new half. The
 * keyboard route to what an edge drop does with the mouse.
 */
export function splitSessionTile(
  layout: SessionWorkspaceLayout,
  tileId: string,
  sessionId: string,
  direction: 'row' | 'column',
): SessionWorkspaceLayout {
  return dropSessionOnTile(layout, tileId, sessionId, direction === 'row' ? 'right' : 'bottom');
}

/**
 * Close a tile. The Session itself is untouched — it simply stops being tiled.
 * The last tile never closes; a window with no Session in it has nothing to show.
 */
export function closeSessionTile(layout: SessionWorkspaceLayout, tileId: string): SessionWorkspaceLayout {
  const tiles = allSessionTiles(layout.root);
  if (tiles.length < 2) return layout;
  const closing = tiles.find(node => node.id === tileId);
  if (!closing) return layout;
  const root = removeLeaf<SessionTileNode>(layout.root, tileId, NEVER_EMPTY);
  if (!root) return layout;
  // Focus the tile that took its place in reading order, as closing a tab does.
  const index = tiles.indexOf(closing);
  const neighbour = tiles[index + 1] ?? tiles[index - 1];
  return withLayout(layout, root, neighbour.id);
}

/** Persist a sash drag. */
export function resizeSessionSplit(
  layout: SessionWorkspaceLayout,
  splitNodeId: string,
  sizes: number[],
): SessionWorkspaceLayout {
  return { ...layout, root: updateSplitSizes<SessionTileNode>(layout.root, splitNodeId, sizes) };
}

/** The tile across a given edge of the focused one, for directional focus keys. */
export function findSessionTileInDirection(
  layout: SessionWorkspaceLayout,
  dir: LayoutDirection,
): string | null {
  return findLeafInDirection<SessionTileNode>(layout.root, focusedSessionTile(layout).id, dir);
}

/**
 * Reconcile a stored layout against the Sessions that actually exist on this
 * host: drop tiles whose Session is gone or archived, drop a repeat of a
 * Session that somehow appears twice, and repair focus.
 *
 * Returns a null layout when no live Session is left, which the caller answers
 * by starting a fresh single-tile layout (or showing the empty state).
 */
export function reconcileSessionWorkspaceLayout(
  layout: SessionWorkspaceLayout,
  liveSessionIds: readonly string[],
): ReconciledSessionWorkspaceLayout {
  const live = new Set(liveSessionIds);
  const seen = new Set<string>();
  let changed = false;

  function prune(node: SessionLayoutNode): SessionLayoutNode | null {
    if (node.type === 'session') {
      if (!live.has(node.sessionId) || seen.has(node.sessionId)) {
        changed = true;
        return null;
      }
      seen.add(node.sessionId);
      return node;
    }
    const children: SessionLayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, index) => {
      const kept = prune(child);
      if (!kept) return;
      children.push(kept);
      sizes.push(node.sizes[index] ?? 1);
    });
    if (children.length === 0) return null;
    return { ...node, children, sizes };
  }

  const pruned = prune(layout.root);
  const root = pruned ? normalizeTree<SessionTileNode>(pruned, NEVER_EMPTY) : null;
  if (!root) return { layout: null, changed: true };

  const tiles = allSessionTiles(root);
  const focusedTileId = layout.focusedTileId && findSessionTile(root, layout.focusedTileId)
    ? layout.focusedTileId
    : tiles[0].id;
  if (focusedTileId !== layout.focusedTileId) changed = true;

  return {
    layout: { version: SESSION_WORKSPACE_LAYOUT_VERSION, root, focusedTileId },
    changed,
  };
}
