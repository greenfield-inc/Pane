/** Bytes the composer, the tab bar and the floating controller send to the terminal. */
export const KEYS = {
  enter: '\r',
  stop: '\x03',
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const;
