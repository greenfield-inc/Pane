import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import type { BoundaryCursor, BoundarySchema } from '../validation/boundaryDecoder';

/**
 * How the window divides itself between Sessions.
 *
 * This is the outer twin of `SessionPanelLayout`: the same recursive row/column
 * tree with the same sash sizes, one level up. Its leaves are Sessions, not
 * panels, so a tiled Session still owns its own `SessionPanelLayout` inside.
 * Keeping the two trees separate keeps every operation on either one honest
 * about what a leaf is; the structural algebra they share lives in the
 * renderer's `layoutTree` module.
 *
 * Scope is per host, like `HostNavigationMemory`: Session ids only mean
 * anything on the host they were saved under, so a stored layout is revalidated
 * against that host's live Sessions before it is restored.
 */

export const SESSION_WORKSPACE_LAYOUT_VERSION = 1 as const;

/**
 * Upper bound on tiles in one layout. The locked decision is that the tree is
 * not capped at two, and this is nowhere near a working limit — it exists so a
 * corrupt or hand-edited store cannot ask the renderer to mount an unbounded
 * number of live agent terminals.
 */
export const MAX_SESSION_TILES = 16;

/** Nesting bound, for the same reason as MAX_SESSION_TILES. */
export const MAX_SESSION_LAYOUT_DEPTH = 8;

/** A leaf: one Session fills this region of the window. */
export interface SessionTileNode {
  type: 'session';
  /** Stable node id; used as the React key and the focus target. */
  id: string;
  /** The orchestration Session shown here. Unique across the tree. */
  sessionId: string;
}

/** A branch: children arranged in a row or column with sash-resizable sizes. */
export interface SessionSplitNode {
  type: 'split';
  /** Stable node id; used as the React key. */
  id: string;
  /** 'row' = tiles side by side; 'column' = tiles stacked. */
  direction: 'row' | 'column';
  /** Child nodes (tiles or nested splits). Length >= 2 after normalization. */
  children: SessionLayoutNode[];
  /** Proportional sizes parallel to children (allotment normalizes). */
  sizes: number[];
}

export type SessionLayoutNode = SessionTileNode | SessionSplitNode;

export interface SessionWorkspaceLayout {
  version: typeof SESSION_WORKSPACE_LAYOUT_VERSION;
  root: SessionLayoutNode;
  /** Tile that owns keyboard focus; its Session is the selected one. */
  focusedTileId?: string;
}

const tileSchema: BoundarySchema<SessionTileNode> = boundary.object({
  type: boundary.literal('session'),
  id: boundary.nonEmptyString,
  sessionId: boundary.nonEmptyString,
});

// The tree is recursive, so the node schema is a thunk: `decodeNode` is hoisted
// and only ever called once both schemas below it have initialized.
const nodeSchema: BoundarySchema<SessionLayoutNode> = {
  decode(current: BoundaryCursor): SessionLayoutNode {
    return decodeNode(current);
  },
};

const splitSchema: BoundarySchema<SessionSplitNode> = boundary.object({
  type: boundary.literal('split'),
  id: boundary.nonEmptyString,
  direction: boundary.enumeration('row', 'column'),
  children: boundary.array(nodeSchema),
  sizes: boundary.array(boundary.number),
});

const unionSchema = boundary.union(tileSchema, splitSchema);

function decodeNode(current: BoundaryCursor): SessionLayoutNode {
  return unionSchema.decode(current);
}

const layoutSchema: BoundarySchema<SessionWorkspaceLayout> = boundary.object({
  version: boundary.literal(SESSION_WORKSPACE_LAYOUT_VERSION),
  root: nodeSchema,
  focusedTileId: boundary.optional(boundary.nonEmptyString),
});

interface LayoutCensus {
  tiles: number;
  depth: number;
  nodeIds: Set<string>;
  sessionIds: Set<string>;
}

function measure(node: SessionLayoutNode, depth: number, census: LayoutCensus): boolean {
  if (depth > census.depth) census.depth = depth;
  if (census.depth > MAX_SESSION_LAYOUT_DEPTH) return false;
  if (census.nodeIds.has(node.id)) return false;
  census.nodeIds.add(node.id);
  if (node.type === 'session') {
    census.tiles += 1;
    if (census.sessionIds.has(node.sessionId)) return false;
    census.sessionIds.add(node.sessionId);
    return census.tiles <= MAX_SESSION_TILES;
  }
  if (node.children.length < 1 || node.children.length !== node.sizes.length) return false;
  if (!node.sizes.every(size => Number.isFinite(size) && size > 0)) return false;
  return node.children.every(child => measure(child, depth + 1, census));
}

/**
 * Returns null for anything that is not a usable layout: older shapes, trees
 * past the tile or depth bounds, duplicate node or Session ids, split nodes
 * whose sizes do not line up with their children.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External saved data is decoded immediately with layoutSchema, then measured for structural bounds.
export function decodeSessionWorkspaceLayout(value: unknown): SessionWorkspaceLayout | null {
  const decoded = decodeOptionalBoundary(value, layoutSchema) ?? null;
  if (!decoded) return null;
  const census: LayoutCensus = { tiles: 0, depth: 1, nodeIds: new Set(), sessionIds: new Set() };
  if (!measure(decoded.root, 1, census)) return null;
  if (census.tiles === 0) return null;
  if (decoded.focusedTileId && !census.nodeIds.has(decoded.focusedTileId)) {
    return { version: decoded.version, root: decoded.root };
  }
  return decoded;
}
