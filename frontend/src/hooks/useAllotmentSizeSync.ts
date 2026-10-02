import { useCallback, useEffect, useRef } from 'react';
import { isSplit, type LayoutLeaf, type LayoutTree } from '../utils/layoutTree';

/**
 * Keeps a stored layout tree's sizes in step with what Allotment actually drew.
 *
 * Allotment's `defaultSizes` is mount-only, so when a sibling is added to or
 * removed from an existing split, the on-screen distribution diverges from the
 * stored model until the next sash drag. `record` keeps a live snapshot per
 * split (in a ref, so no re-render); when a split's child count changes, the
 * model syncs from that snapshot once.
 *
 * Shared by both layout trees — panel groups in a Pane and Session tiles in the
 * window — because the problem is Allotment's, not either leaf type's.
 */
export function useAllotmentSizeSync<Leaf extends LayoutLeaf>(
  root: LayoutTree<Leaf>,
  onSizesChange: (splitNodeId: string, sizes: number[]) => void,
): (splitNodeId: string, sizes: number[]) => void {
  const liveSizesRef = useRef(new Map<string, number[]>());
  const childCountsRef = useRef(new Map<string, number>());

  useEffect(() => {
    const changed: string[] = [];
    const seen = new Set<string>();
    (function walk(node: LayoutTree<Leaf>) {
      if (!isSplit(node)) return;
      seen.add(node.id);
      const previous = childCountsRef.current.get(node.id);
      if (previous !== undefined && previous !== node.children.length) changed.push(node.id);
      childCountsRef.current.set(node.id, node.children.length);
      node.children.forEach(walk);
    })(root);
    for (const id of Array.from(childCountsRef.current.keys())) {
      if (!seen.has(id)) {
        childCountsRef.current.delete(id);
        liveSizesRef.current.delete(id);
      }
    }
    if (changed.length === 0) return;
    // Allotment re-lays out the new pane set after this render; read the
    // snapshot on the next tick. The length guard skips stale pre-change
    // snapshots if onChange has not fired yet (no sync beats a wrong one).
    const timer = setTimeout(() => {
      for (const id of changed) {
        const sizes = liveSizesRef.current.get(id);
        if (sizes && sizes.length === childCountsRef.current.get(id)) {
          onSizesChange(id, sizes);
        }
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [root, onSizesChange]);

  // Stable, so the recursive renderers can keep it in a memo dependency list.
  return useCallback((splitNodeId: string, sizes: number[]) => {
    liveSizesRef.current.set(splitNodeId, sizes);
  }, []);
}
