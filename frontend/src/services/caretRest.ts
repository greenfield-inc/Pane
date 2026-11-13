/**
 * The text caret blinks while someone is typing and holds steady once they stop.
 *
 * Chromium repaints a blinking caret every 500 ms, and on macOS each repaint
 * keeps the display link ticking for ~165 ms: 55-70 wakeups a second
 * while a focused field sits idle. A steady caret costs nothing. Linux GTK stops
 * the blink after a similar idle timeout.
 */
const CARET_BLINK_IDLE_MS = 10_000;

/** Set on the root element while the caret holds steady; index.css reads it. */
const CARET_RESTING_CLASS = 'caret-resting';

const ACTIVITY_EVENTS = ['keydown', 'input', 'pointerdown', 'focusin'] as const;

interface CaretRestTarget {
  addEventListener: EventTarget['addEventListener'];
}

interface CaretRestRoot {
  classList: Pick<DOMTokenList, 'add' | 'remove' | 'contains'>;
}

/** Watches for typing, clicks and focus for the life of the window. */
export function startCaretRest(
  events: CaretRestTarget = window,
  root: CaretRestRoot = document.documentElement,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rest = () => root.classList.add(CARET_RESTING_CLASS);
  const wake = () => {
    if (root.classList.contains(CARET_RESTING_CLASS)) root.classList.remove(CARET_RESTING_CLASS);
    clearTimeout(timer);
    timer = setTimeout(rest, CARET_BLINK_IDLE_MS);
  };

  for (const type of ACTIVITY_EVENTS) events.addEventListener(type, wake, { capture: true, passive: true });
  wake();
}
