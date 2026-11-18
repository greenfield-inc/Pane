import { create } from 'zustand';

/** How long a key's quiet hint stays at the bottom of the window. */
const HINT_MS = 2500;

/**
 * A short line a key shows when it has nothing to do here ("Nothing in this Session is waiting on
 * you."), in the same place as the two-step key hint. One at a time; a new one replaces it.
 */
export const useKeyHintStore = create<{ text: string | null }>(() => ({ text: null }));

let timer: ReturnType<typeof setTimeout> | null = null;

export function showKeyHint(text: string): void {
  if (timer) clearTimeout(timer);
  useKeyHintStore.setState({ text });
  timer = setTimeout(() => {
    timer = null;
    useKeyHintStore.setState({ text: null });
  }, HINT_MS);
}
