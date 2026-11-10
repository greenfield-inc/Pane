/**
 * Where keyboard focus can stop in the window, and which stop lies in a
 * direction from another (D-234, D-237). A stop is a region on screen: the
 * sidebar, one split group (in a worktree Pane or a Session tile), a right
 * panel, an open terminal, Approvals, or a main view without splits.
 *
 * The geometry is pure so it can be tested without a DOM; regionFocus.ts
 * reads the rectangles from the page.
 */
export type FocusDirection = 'left' | 'right' | 'up' | 'down';

export type FocusStopKind = 'sidebar' | 'group' | 'right-panel' | 'terminal' | 'approvals' | 'main';

interface StopRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FocusStop<Ref = unknown> {
  id: string;
  kind: FocusStopKind;
  rect: StopRect;
  /** The group the main area last focused; preferred when two stops tie. */
  preferred?: boolean;
  ref: Ref;
}

/** Pixels two stops may overlap at a shared edge (borders, sashes) and still count as beside each other. */
const EDGE_SLACK = 4;

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * The nearest stop across `from`'s edge in `dir` that shares some of its
 * span: the closest gap first, then the preferred (last focused) stop, then
 * the top or left one.
 */
export function stopInDirection<Ref>(
  stops: readonly FocusStop<Ref>[],
  from: FocusStop<Ref>,
  dir: FocusDirection,
): FocusStop<Ref> | null {
  const r = from.rect;
  let best: { stop: FocusStop<Ref>; gap: number; position: number } | null = null;
  for (const stop of stops) {
    if (stop.id === from.id) continue;
    const c = stop.rect;
    let gap: number;
    let shared: number;
    if (dir === 'right') { gap = c.left - r.right; shared = overlap(r.top, r.bottom, c.top, c.bottom); }
    else if (dir === 'left') { gap = r.left - c.right; shared = overlap(r.top, r.bottom, c.top, c.bottom); }
    else if (dir === 'down') { gap = c.top - r.bottom; shared = overlap(r.left, r.right, c.left, c.right); }
    else { gap = r.top - c.bottom; shared = overlap(r.left, r.right, c.left, c.right); }
    if (gap < -EDGE_SLACK || shared <= 0) continue;
    const roundedGap = Math.max(0, Math.round(gap));
    const position = dir === 'left' || dir === 'right' ? c.top : c.left;
    const samePreference = Boolean(stop.preferred) === Boolean(best?.stop.preferred);
    if (!best
      || roundedGap < best.gap
      || (roundedGap === best.gap && Boolean(stop.preferred) && !best.stop.preferred)
      || (roundedGap === best.gap && samePreference && position < best.position)) {
      best = { stop, gap: roundedGap, position };
    }
  }
  return best?.stop ?? null;
}

const CYCLE_ORDER = {
  sidebar: 0, approvals: 1, main: 1, group: 1, 'right-panel': 2, terminal: 3,
} satisfies Record<FocusStopKind, number>;

/**
 * The order F6 walks (VS Code's focusNextPart): the sidebar, then the main
 * area's groups in reading order, then right panels, then terminals.
 */
export function cycleOrder<Ref>(stops: readonly FocusStop<Ref>[]): FocusStop<Ref>[] {
  return [...stops].sort((a, b) =>
    CYCLE_ORDER[a.kind] - CYCLE_ORDER[b.kind]
    || Math.round(a.rect.top) - Math.round(b.rect.top)
    || Math.round(a.rect.left) - Math.round(b.rect.left));
}

/** The stop `delta` places after `current` in F6 order, wrapping around. */
export function stepStop<Ref>(
  stops: readonly FocusStop<Ref>[],
  currentId: string | null,
  delta: 1 | -1,
): FocusStop<Ref> | null {
  const ordered = cycleOrder(stops);
  if (ordered.length === 0) return null;
  const index = ordered.findIndex(stop => stop.id === currentId);
  if (index === -1) return delta === 1 ? ordered[0] : ordered[ordered.length - 1];
  return ordered[(index + delta + ordered.length) % ordered.length];
}
