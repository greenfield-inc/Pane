import { useSyncExternalStore } from 'react';

/**
 * Carets and text cursors blink while someone is typing and hold steady once
 * they stop.
 *
 * Every blink repaints, and on macOS each repaint keeps the display link
 * ticking for ~165 ms: 55-70 wakeups a second while a focused field sits idle.
 * A steady cursor costs nothing. Linux GTK stops its blink after a similar idle
 * timeout.
 *
 * Native carets follow `html.caret-resting` in index.css. Cursors an editor
 * draws itself (Monaco, xterm) read `useCaretResting()`.
 */
const CARET_BLINK_IDLE_MS = 10_000;

const CARET_RESTING_CLASS = 'caret-resting';

const ACTIVITY_EVENTS = ['keydown', 'input', 'pointerdown', 'focusin'] as const;

let resting = false;
const listeners = new Set<() => void>();

function setResting(next: boolean): void {
  if (next === resting) return;
  resting = next;
  document.documentElement.classList.toggle(CARET_RESTING_CLASS, next);
  for (const listener of listeners) listener();
}

/** Watches for typing, clicks and focus for the life of the window. */
export function startCaretRest(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    setResting(false);
    clearTimeout(timer);
    timer = setTimeout(() => setResting(true), CARET_BLINK_IDLE_MS);
  };

  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, wake, { capture: true, passive: true });
  wake();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while cursors should hold steady instead of blinking. */
export function useCaretResting(): boolean {
  return useSyncExternalStore(subscribe, () => resting);
}
