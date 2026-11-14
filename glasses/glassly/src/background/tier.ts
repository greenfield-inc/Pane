// Which version of Pane a pair of glasses gets: the full app needs a positioned screen of at
// least 576 x 288 and tap, double tap and both swipes (from the glasses or a ring); everything
// else gets the glance, a read-only line.
import type { GlassesCapabilities } from '@glassly/miniapp';
import type { Budget } from './render';

export type Tier = { kind: 'full'; budget: Budget } | { kind: 'glance' };

const FULL_W = 576;
const FULL_H = 288;
const NEEDED = ['TAP', 'DOUBLE_TAP', 'SWIPE_UP', 'SWIPE_DOWN'];
/** Stock G2: six text-or-rect elements. */
const STOCK_TEXT = 6;
/** Glassly's Simulated Glasses has the G2 canvas, and the phone's mirror controls send every gesture. */
const SIMULATED = 'Simulated Glasses';

export function tierOf(capabilities: GlassesCapabilities | null): Tier {
  const display = capabilities?.display;
  if (!display) return { kind: 'glance' };
  const events = new Set((capabilities.button?.buttons ?? []).flatMap((surface) => surface.events.map((event) => event.toUpperCase())));
  const gestures = capabilities.modelName === SIMULATED || NEEDED.every((event) => events.has(event));
  const screen = display.canPosition !== false && (display.width ?? 0) >= FULL_W && (display.height ?? 0) >= FULL_H;
  return screen && gestures ? { kind: 'full', budget: { maxText: display.maxTextElements ?? STOCK_TEXT } } : { kind: 'glance' };
}
