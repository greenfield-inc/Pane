import { create } from 'zustand';

/** A link the popover offers actions for, and where on screen it shows. */
export interface LinkPopoverTarget {
  url: string;
  /** The Pane the link belongs to; without one, Open in Pane is hidden. */
  paneId?: string;
  x: number;
  y: number;
  /** Where its bottom edge goes when there is no room below; defaults to `y`. */
  flipY?: number;
}

const SHOW_DELAY_MS = 500;
/** Time for the pointer to cross from the link onto the popover. */
const HIDE_GRACE_MS = 200;

export const useLinkPopoverStore = create<{ target: LinkPopoverTarget | null }>(() => ({ target: null }));
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let hovered: LinkPopoverTarget | null = null;

function clearTimers(): void {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
}

/** The pointer reached the popover: it stays open. */
export function keepLinkPopover(): void {
  clearTimers();
}

/** The pointer rests on a link: the popover shows after a short delay. */
export function hoverLink(target: LinkPopoverTarget): void {
  clearTimers();
  hovered = target;
  if (useLinkPopoverStore.getState().target?.url === target.url) return;
  showTimer = setTimeout(() => useLinkPopoverStore.setState({ target }), SHOW_DELAY_MS);
}

/** The pointer left a link (or the popover): it closes unless the pointer reaches the popover. */
export function leaveLink(): void {
  clearTimers();
  hovered = null;
  hideTimer = setTimeout(() => useLinkPopoverStore.setState({ target: null }), HIDE_GRACE_MS);
}

/** The link under the pointer, for a right-click on a surface that has no link element (the terminal). */
export function hoveredLink(): LinkPopoverTarget | null {
  return hovered;
}

/** Shows the popover now, as a right-click does. */
export function showLinkPopover(target: LinkPopoverTarget): void {
  clearTimers();
  useLinkPopoverStore.setState({ target });
}

export function closeLinkPopover(): void {
  clearTimers();
  useLinkPopoverStore.setState({ target: null });
}
