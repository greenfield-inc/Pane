/** Where a dragged Session lands: just before or just after the Session under the pointer. */
export interface SessionDropTarget {
  targetId: string;
  edge: 'before' | 'after';
}

/** The list's order after dropping `movedId` at `drop`, or null when nothing would move. */
export function dropOrder(ids: readonly string[], movedId: string, drop: SessionDropTarget): string[] | null {
  if (movedId === drop.targetId || !ids.includes(movedId) || !ids.includes(drop.targetId)) return null;
  const rest = ids.filter(id => id !== movedId);
  const at = rest.indexOf(drop.targetId) + (drop.edge === 'after' ? 1 : 0);
  // Landing at its own index leaves every Session where it was.
  if (at === ids.indexOf(movedId)) return null;
  return [...rest.slice(0, at), movedId, ...rest.slice(at)];
}

/** The list's order after moving `id` one place (`step` -1 up, 1 down), or null at either end. */
export function stepOrder(ids: readonly string[], id: string, step: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
