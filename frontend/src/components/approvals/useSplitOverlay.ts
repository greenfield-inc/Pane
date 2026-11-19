import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { closeFindWithin } from '../find/findController';
import { leaveApprovalColumn } from '../../services/regionFocus';
import { coverRect, isTypingTarget, sameRect, type OverlayRect } from './splitOverlay';

/** The approval column over a right split (D-261, D-418): its Esc, its leave-on-close focus, its measured placement. */

/**
 * Esc in an approval column, not while typing a reply: an open find bar in the column closes
 * first, then `onEscape` runs. A Session's default goes back to the chat beside it (D-336).
 */
export function escapeApprovalColumn(event: ReactKeyboardEvent, onEscape: () => void = leaveApprovalColumn): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (isTypingTarget(event.target instanceof HTMLElement ? event.target : null)) return;
  event.preventDefault();
  if (closeFindWithin(event.currentTarget)) return;
  onEscape();
}

/**
 * The column going away (✕, Esc, an answer) with focus in it would leave focus on nothing:
 * `onLeave` puts it back (the chat in a Session, the card you came from on a to-do). It runs a
 * frame after `open` turns false, only when nothing else took focus meanwhile.
 */
export function useLeaveOnClose(open: boolean, enabled: boolean, onLeave: () => void): void {
  const wasOpen = useRef(open);
  const leave = useRef(onLeave);
  useEffect(() => { leave.current = onLeave; });
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed || !enabled) return;
    requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) leave.current();
    });
  }, [open, enabled]);
}

/**
 * Measures what `targets` covers, relative to `baseRef`, while `enabled`, and again whenever
 * the base or a target resizes. `targetsKey` names the targets: change it when they change.
 */
export function useSplitOverlayRect(
  baseRef: RefObject<HTMLElement | null>,
  targets: (base: HTMLElement) => readonly Element[],
  targetsKey: string,
  enabled: boolean,
): OverlayRect | null {
  const [rect, setRect] = useState<OverlayRect | null>(null);
  // Rendered inside its own base and open from its first mount, it runs before the base's ref is
  // attached: it looks again on the next frame.
  const [retry, setRetry] = useState(0);
  const latestTargets = useRef(targets);
  useLayoutEffect(() => { latestTargets.current = targets; });
  useLayoutEffect(() => {
    const base = baseRef.current;
    if (!enabled || !base) {
      setRect(null);
      if (!enabled || retry > 0) return;
      const frame = requestAnimationFrame(() => setRetry(value => value + 1));
      return () => cancelAnimationFrame(frame);
    }
    const measure = () => {
      const next = coverRect(base.getBoundingClientRect(), latestTargets.current(base).map(element => element.getBoundingClientRect()));
      setRect(previous => (sameRect(previous, next) ? previous : next));
    };
    measure();
    // It follows the split as it is dragged or the window resizes; it never resizes the split itself.
    const observer = new ResizeObserver(measure);
    observer.observe(base);
    for (const element of latestTargets.current(base)) observer.observe(element);
    return () => observer.disconnect();
  }, [baseRef, targetsKey, enabled, retry]);
  return rect;
}
