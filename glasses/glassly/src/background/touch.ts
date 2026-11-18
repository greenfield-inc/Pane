// Glassly touch events as the glasses app's gestures. Hold to talk is a held press
// (tap_start, or long_press where a device reports that instead) and its release (tap_end).
// (assumed: stock G2 under Glassly reports tap_start and tap_end; P0 checks.)
import type { Gesture } from '../../../src/platform';

/** A release can also arrive as a tap; one this soon after it is ignored, as on Even. */
const RELEASE_TAP_MS = 500;

export class TouchMapper {
  private holding = false;
  private releasedAt = -Infinity;

  constructor(private readonly now: () => number) {}

  gesture(kind: string): Gesture | null {
    switch (kind) {
      case 'single_tap':
        return this.now() - this.releasedAt < RELEASE_TAP_MS ? null : { type: 'press' };
      case 'double_tap':
        return { type: 'double' };
      case 'swipe_up':
        return { type: 'up' };
      case 'swipe_down':
        return { type: 'down' };
      case 'tap_start':
      case 'long_press':
        if (this.holding) return null;
        this.holding = true;
        return { type: 'hold' };
      case 'tap_end':
        if (!this.holding) return null;
        this.holding = false;
        this.releasedAt = this.now();
        return { type: 'release' };
      default:
        return null;
    }
  }
}
