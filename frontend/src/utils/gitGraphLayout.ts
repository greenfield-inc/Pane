import type {
  GitGraphEdge,
  GitGraphLayout,
  GitGraphNode,
  GitGraphRow,
} from '../../../shared/types/gitGraph';

/**
 * Number of distinct lane colours. Lanes map to colours by index so a branch
 * keeps the same colour for as long as it occupies the same lane, which is
 * what makes the graph readable while scrolling.
 */
const GRAPH_PALETTE_LENGTH = 8;

/**
 * Assign a lane (column) to every commit and derive the edges to draw between
 * consecutive rows — the same job `git log --graph` does with ASCII art, but
 * as data.
 *
 * The algorithm is a single top-to-bottom sweep over a date-ordered commit
 * list, maintaining `lanes[i]` = "the hash this lane is currently waiting to
 * see". For each row:
 *
 *  1. The commit takes the leftmost lane reserved for its hash; if no lane is
 *     waiting for it (a branch tip), it takes the leftmost free lane and the
 *     row is flagged `isBranchTip` so nothing is drawn above its dot.
 *  2. Any *other* lane also waiting for this commit ends here and emits a
 *     `join` edge into the dot — without it those branches simply vanished
 *     mid-air.
 *  3. Its first parent inherits that same lane — this keeps mainline history
 *     in a straight vertical line.
 *  4. Every additional parent (a merge) reserves the leftmost free lane and
 *     emits a diagonal `merge` edge.
 *  5. Lanes still reserved after that emit `passthrough` edges spanning the
 *     full row height. They must not be `straight`: a straight edge starts at
 *     the dot, half a row down, which is what left the vertical lines of
 *     unrelated branches broken into dashes.
 *
 * Complexity is O(commits x lanes). The input is not mutated.
 */
export function computeGitGraphLayout(nodes: GitGraphNode[]): GitGraphLayout {
  if (nodes.length === 0) return { rows: [], laneCount: 0 };

  const knownHashes = new Set(nodes.map(node => node.hash));
  // lanes[i] holds the hash lane i is reserved for, or null when free.
  const lanes: Array<string | null> = [];
  const rows: GitGraphRow[] = [];
  let laneCount = 0;

  const claimLane = (hash: string): number => {
    const reserved = lanes.indexOf(hash);
    if (reserved >= 0) return reserved;
    const free = lanes.indexOf(null);
    if (free >= 0) {
      lanes[free] = hash;
      return free;
    }
    lanes.push(hash);
    return lanes.length - 1;
  };

  for (const node of nodes) {
    // Nothing above points at this commit: it is the newest on its branch.
    const isBranchTip = lanes.indexOf(node.hash) < 0;
    const lane = claimLane(node.hash);

    const edges: GitGraphEdge[] = [];

    // Any other lane also waiting for this commit (two branches converging on
    // the same ancestor) ends here, and says so with a join edge.
    for (let i = 0; i < lanes.length; i++) {
      if (i === lane || lanes[i] !== node.hash) continue;
      lanes[i] = null;
      edges.push({
        fromLane: i,
        toLane: lane,
        kind: 'join',
        // The ending branch keeps its own colour into the dot, so the eye can
        // follow it to where it was absorbed.
        colorIndex: i % GRAPH_PALETTE_LENGTH,
      });
    }

    lanes[lane] = null;

    const [firstParent, ...otherParents] = node.parents;

    if (firstParent) {
      lanes[lane] = firstParent;
      const edge: GitGraphEdge = {
        fromLane: lane,
        toLane: lane,
        kind: 'straight',
        colorIndex: lane % GRAPH_PALETTE_LENGTH,
      };
      if (!knownHashes.has(firstParent)) edge.danglesBelow = true;
      edges.push(edge);
    }

    for (const parent of otherParents) {
      const parentLane = claimLane(parent);
      const edge: GitGraphEdge = {
        fromLane: lane,
        toLane: parentLane,
        kind: 'merge',
        colorIndex: parentLane % GRAPH_PALETTE_LENGTH,
      };
      if (!knownHashes.has(parent)) edge.danglesBelow = true;
      edges.push(edge);
    }

    // Unrelated branches still in flight keep their column through this row,
    // top edge to bottom edge — anything shorter leaves a gap.
    for (let i = 0; i < lanes.length; i++) {
      const reservedFor = lanes[i];
      if (!reservedFor) continue;
      if (i === lane && firstParent) continue;
      if (edges.some(edge => edge.toLane === i)) continue;
      const edge: GitGraphEdge = {
        fromLane: i,
        toLane: i,
        kind: 'passthrough',
        colorIndex: i % GRAPH_PALETTE_LENGTH,
      };
      if (!knownHashes.has(reservedFor)) edge.danglesBelow = true;
      edges.push(edge);
    }

    // Trim trailing free lanes so the gutter does not stay wide after a branch
    // ends, while `laneCount` still reflects the widest point of the graph.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    laneCount = Math.max(
      laneCount,
      lane + 1,
      ...edges.map(edge => Math.max(edge.fromLane, edge.toLane) + 1)
    );

    rows.push({
      node,
      lane,
      colorIndex: lane % GRAPH_PALETTE_LENGTH,
      edges,
      isBranchTip,
    });
  }

  return { rows, laneCount };
}
