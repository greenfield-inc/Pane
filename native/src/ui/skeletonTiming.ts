/** A load that finishes sooner shows no skeleton at all. */
const SKELETON_DELAY_MS = 150;
/** A skeleton that appeared stays at least this long, so it never blinks. */
const SKELETON_MIN_VISIBLE_MS = 300;
/** Content that replaces a shown skeleton fades in over this long. */
export const SKELETON_REVEAL_MS = 120;
/** A skeleton that starts this soon after another one ended continues its timing. */
const SKELETON_HANDOFF_MS = 100;

/**
 * When a load starting at `now` counts as started: a skeleton that takes over from one that just
 * ended (a Pane's skeleton handing over to its terminal's) keeps that one's start, so the screen
 * never goes blank between them for another 150 ms.
 */
export function skeletonStart(now: number, lastEnded: { started: number; ended: number } | null): number {
  return lastEnded && now - lastEnded.ended <= SKELETON_HANDOFF_MS ? lastEnded.started : now;
}

export interface SkeletonState {
  /** Draw the skeleton in place of the content. */
  skeleton: boolean;
  /** Its bones show; before the delay passes the skeleton keeps the screen's shape, blank. */
  bones: boolean;
  /** The content replaces a skeleton that showed: fade it in. */
  reveal: boolean;
  /** When this state next changes, or null. */
  changeAt: number | null;
}

/**
 * What a waiting screen draws at `now` for a load that started at `started` and ended at `ended`
 * (null while it runs), with the desktop's rules: no bones for the first 150 ms, a shown skeleton
 * held at least 300 ms, then the content fades in.
 */
export function skeletonState(started: number, ended: number | null, now: number): SkeletonState {
  const visibleAt = started + SKELETON_DELAY_MS;
  if (ended === null) {
    return now < visibleAt
      ? { skeleton: true, bones: false, reveal: false, changeAt: visibleAt }
      : { skeleton: true, bones: true, reveal: false, changeAt: null };
  }
  if (ended < visibleAt) return { skeleton: false, bones: false, reveal: false, changeAt: null };
  const releaseAt = Math.max(ended, visibleAt + SKELETON_MIN_VISIBLE_MS);
  return now < releaseAt
    ? { skeleton: true, bones: true, reveal: false, changeAt: releaseAt }
    : { skeleton: false, bones: false, reveal: true, changeAt: null };
}
