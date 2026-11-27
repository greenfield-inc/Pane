/**
 * Turns a stream of controller frames into scheme actions. Pure and
 * clock-driven: the adapter calls `update` with each new frame and, while
 * `needsTick()` is true, on a timer too, because holds and repeats fire with
 * no change in the frame.
 *
 * Timing (cover sheet, "Timing defaults"): − is a tap under HOLD_MS and a
 * hold past it; L1 and R1 act on release unless the other went down while
 * they were held, which makes the pair the column chord; the left stick and
 * the D-pad move past STICK_THRESHOLD, repeating after REPEAT_DELAY_MS and
 * then every REPEAT_INTERVAL_MS; R2 holds from press to release.
 */
import {
  CHORD_ACTION,
  HOLD_MS,
  MINUS_HOLD_ACTION,
  MINUS_TAP_ACTION,
  R2_HOLD_ACTION,
  RELEASE_ACTIONS,
  pressAction,
  type ControllerActionId,
  type ControllerContext,
  type ControllerHoldActionId,
} from './bindings';
import { keyForButton, type ControllerFamily, type ControllerKey } from './profiles';
import { RESTING_AXES, type ControllerAxes, type ControllerFrame, type Direction } from './types';

export const STICK_THRESHOLD = 0.5;
export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 120;
/** The right stick scrolls; it repeats faster than focus moves so a long scroll feels continuous. */
export const SCROLL_REPEAT_DELAY_MS = 200;
export const SCROLL_REPEAT_INTERVAL_MS = 60;

export type ControllerEvent =
  | { type: 'action'; action: ControllerActionId }
  | { type: 'hold-start'; action: ControllerHoldActionId }
  | { type: 'hold-end'; action: ControllerHoldActionId };

export interface ControllerInterpreter {
  /** Feeds the latest frame at `now` (ms) and returns what happened since the last call. */
  update(frame: ControllerFrame, now: number, context: ControllerContext): ControllerEvent[];
  /** True while a timed rule (a hold, a chord or a repeat) may still fire without a new frame. */
  needsTick(): boolean;
}

interface Repeater {
  key: string | null;
  nextAt: number;
}

const STICK_ACTIONS = {
  up: 'controller-focus-up', down: 'controller-focus-down', left: 'controller-focus-left', right: 'controller-focus-right',
} satisfies Record<Direction, ControllerActionId>;
const DPAD_KEYS = ['up', 'down', 'left', 'right'] as const satisfies readonly ControllerKey[];

function isDpad(key: ControllerKey): boolean {
  return key === 'up' || key === 'down' || key === 'left' || key === 'right';
}

function stickDirection(x: number, y: number): Direction | null {
  if (Math.max(Math.abs(x), Math.abs(y)) <= STICK_THRESHOLD) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

export function createControllerInterpreter(options: { family: ControllerFamily }): ControllerInterpreter {
  const { family } = options;
  let held = new Set<ControllerKey>();
  let axes: ControllerAxes = RESTING_AXES;
  const downAt = new Map<ControllerKey, number>();
  let minusHolding = false;
  let shoulderChord = false;
  const dpad: Repeater = { key: null, nextAt: 0 };
  const stick: Repeater = { key: null, nextAt: 0 };
  const scroll: Repeater = { key: null, nextAt: 0 };

  /** Fires `action` when `key` starts, then again on the repeat schedule while it stays the same. */
  function repeat(state: Repeater, key: string | null, now: number, delay: number, interval: number, fire: () => void) {
    if (key !== state.key) {
      state.key = key;
      if (key === null) return;
      state.nextAt = now + delay;
      fire();
      return;
    }
    if (key !== null && now >= state.nextAt) {
      state.nextAt = now + interval;
      fire();
    }
  }

  return {
    update(frame, now, context) {
      const events: ControllerEvent[] = [];
      const action = (id: ControllerActionId) => events.push({ type: 'action', action: id });
      const next = new Set<ControllerKey>();
      for (const button of frame.buttons) next.add(keyForButton(family, button));
      const pressed = [...next].filter(key => !held.has(key));
      const released = [...held].filter(key => !next.has(key));
      held = next;
      axes = frame.axes;

      for (const key of released) {
        downAt.delete(key);
        if (key === 'L1' || key === 'R1') {
          if (!shoulderChord) action(RELEASE_ACTIONS[key]);
        } else if (key === 'minus') {
          if (minusHolding) events.push({ type: 'hold-end', action: MINUS_HOLD_ACTION });
          else action(MINUS_TAP_ACTION);
          minusHolding = false;
        } else if (key === 'R2') {
          events.push({ type: 'hold-end', action: R2_HOLD_ACTION });
        }
      }

      for (const key of pressed) {
        downAt.set(key, now);
        if (key === 'L1' || key === 'R1') {
          const other = key === 'L1' ? 'R1' : 'L1';
          if (held.has(other) && !shoulderChord) {
            shoulderChord = true;
            action(CHORD_ACTION);
          }
        } else if (key === 'R2') {
          events.push({ type: 'hold-start', action: R2_HOLD_ACTION });
        } else if (key !== 'minus' && !isDpad(key)) {
          const id = pressAction(context, key);
          if (id) action(id);
        }
      }

      // The chord ends once both shoulders are up, after every release in this frame has been read.
      if (!held.has('L1') && !held.has('R1')) shoulderChord = false;

      const minusDown = downAt.get('minus');
      if (minusDown !== undefined && !minusHolding && now - minusDown >= HOLD_MS) {
        minusHolding = true;
        events.push({ type: 'hold-start', action: MINUS_HOLD_ACTION });
      }

      const dpadKey = DPAD_KEYS.find(key => held.has(key)) ?? null;
      repeat(dpad, dpadKey, now, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, () => {
        const id = dpadKey && pressAction(context, dpadKey);
        if (id) action(id);
      });

      const stickDir = stickDirection(axes.leftX, axes.leftY);
      repeat(stick, stickDir, now, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS, () => {
        if (stickDir) action(STICK_ACTIONS[stickDir]);
      });

      const scrollDir = axes.rightY > STICK_THRESHOLD ? 'down' : axes.rightY < -STICK_THRESHOLD ? 'up' : null;
      repeat(scroll, scrollDir, now, SCROLL_REPEAT_DELAY_MS, SCROLL_REPEAT_INTERVAL_MS, () => {
        if (scrollDir) action(scrollDir === 'down' ? 'scroll-focused-surface-down' : 'scroll-focused-surface-up');
      });

      return events;
    },
    needsTick() {
      return (downAt.has('minus') && !minusHolding)
        || dpad.key !== null || stick.key !== null || scroll.key !== null;
    },
  };
}
