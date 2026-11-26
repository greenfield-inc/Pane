/**
 * The one "next thing that needs you" order (+ on a controller), matching
 * Home's Needs you: questions oldest first, then permissions oldest first,
 * then Panes waiting in their terminal, oldest first.
 */

export type NeedsYouKind = 'question' | 'permission' | 'terminal';

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  /** When it started waiting (ms since the epoch). */
  since: number;
}

const KIND_RANK = { question: 0, permission: 1, terminal: 2 } satisfies Record<NeedsYouKind, number>;

export function orderNeedsYou<T extends NeedsYouItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.since - b.since || a.id.localeCompare(b.id));
}

/**
 * The item + opens: the first in order, or the one after `currentId` when the
 * person is already on a waiting item, wrapping round. Null when nothing waits.
 */
export function nextNeedsYou<T extends NeedsYouItem>(items: readonly T[], currentId: string | null): T | null {
  const ordered = orderNeedsYou(items);
  if (ordered.length === 0) return null;
  const at = currentId === null ? -1 : ordered.findIndex(item => item.id === currentId);
  return ordered[(at + 1) % ordered.length];
}
