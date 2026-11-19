/** The pure half of SplitApprovalOverlay: geometry and labels, kept free of the DOM and the stores. */

/** Where the column sits, relative to the positioned base it is drawn in. */
export interface OverlayRect { left: number; top: number; width: number; height: number }

/** The edges of one measured element (a `DOMRect` fits). */
export interface MeasuredEdges { left: number; top: number; right: number; bottom: number }

/** The smallest rect, relative to `base`, that covers every one of `rects`; none: null. */
export function coverRect(base: MeasuredEdges, rects: readonly MeasuredEdges[]): OverlayRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map(rect => rect.left)) - base.left;
  const top = Math.min(...rects.map(rect => rect.top)) - base.top;
  return {
    left,
    top,
    width: Math.max(...rects.map(rect => rect.right)) - base.left - left,
    height: Math.max(...rects.map(rect => rect.bottom)) - base.top - top,
  };
}

export function sameRect(a: OverlayRect | null, b: OverlayRect | null): boolean {
  if (!a || !b) return a === b;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

/** ✕'s words over a split: "Back to Plan", or "Back" when nothing is named underneath. */
export function backToLabel(underneath: string | undefined): string {
  return underneath ? `Back to ${underneath}` : 'Back';
}

/** What a keydown's target is, for deciding whether Esc is the person's or the field's. */
export interface KeyTarget { tagName: string; isContentEditable: boolean }

/** Typing in a field (or a page in a webview) keeps its own Esc. */
export function isTypingTarget(target: KeyTarget | null): boolean {
  return Boolean(target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'WEBVIEW'].includes(target.tagName)));
}
