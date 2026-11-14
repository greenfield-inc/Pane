// What every glasses host (the Even app, Glassly) hands the shared app: gestures in, cancellable timers.

export type Gesture =
  | { type: 'press' }
  /** A press on a native list row. */
  | { type: 'select'; index: number }
  | { type: 'double' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'hold' }
  | { type: 'release' }
  | { type: 'audio'; pcm: Uint8Array }
  | { type: 'foreground' }
  | { type: 'background' }
  | { type: 'exit' };

export interface Cancel {
  cancel(): void;
}
