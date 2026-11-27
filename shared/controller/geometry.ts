/**
 * Spatial navigation: from the focused control, the nearest control in a
 * direction. Desktop feeds it DOM rectangles and the phone feeds it measured
 * frames, so focus moves the same way on both.
 */
import type { Direction } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocusCandidate<Id> {
  id: Id;
  rect: Rect;
}

/** How much sideways drift costs against distance travelled; above 1 keeps moves in their lane. */
const CROSS_AXIS_WEIGHT = 2;

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * The candidate whose near edge lies beyond `from` in `direction`, scored by
 * the gap along the direction plus a weighted sideways offset. A candidate
 * that shares the row (or column) with `from` has no sideways offset, so it
 * wins over a closer one off to the side. Null when nothing lies that way.
 */
export function pickInDirection<Id>(from: Rect, candidates: ReadonlyArray<FocusCandidate<Id>>, direction: Direction): Id | null {
  const horizontal = direction === 'left' || direction === 'right';
  let best: { id: Id; score: number } | null = null;
  for (const candidate of candidates) {
    const to = candidate.rect;
    const gap = direction === 'right' ? to.x - (from.x + from.width)
      : direction === 'left' ? from.x - (to.x + to.width)
        : direction === 'down' ? to.y - (from.y + from.height)
          : from.y - (to.y + to.height);
    // Allow a small overlap so touching or slightly overlapping neighbours count.
    if (gap < -Math.min(horizontal ? from.width : from.height, horizontal ? to.width : to.height) / 2) continue;
    const shared = horizontal
      ? overlap(from.y, from.y + from.height, to.y, to.y + to.height)
      : overlap(from.x, from.x + from.width, to.x, to.x + to.width);
    const fromCenter = horizontal ? from.y + from.height / 2 : from.x + from.width / 2;
    const toCenter = horizontal ? to.y + to.height / 2 : to.x + to.width / 2;
    const sideways = shared > 0 ? 0 : Math.abs(toCenter - fromCenter);
    const score = Math.max(0, gap) + CROSS_AXIS_WEIGHT * sideways;
    if (!best || score < best.score) best = { id: candidate.id, score };
  }
  return best?.id ?? null;
}
