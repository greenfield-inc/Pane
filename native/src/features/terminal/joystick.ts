/** How far the joystick thumb travels from center, in points. */
export const JOYSTICK_TRAVEL = 60;
const DEAD_ZONE = 8;
const MAX_LINES_PER_SECOND = 72;

/**
 * Scroll speed for a thumb dragged `offset` points from center (negative is
 * up). Speed ramps quadratically past a small dead zone, so short drags read
 * line by line and full drags fly.
 */
export function joystickLinesPerSecond(offset: number): number {
  'worklet';
  const distance = Math.min(Math.abs(offset), JOYSTICK_TRAVEL);
  if (distance <= DEAD_ZONE) return 0;
  const ratio = (distance - DEAD_ZONE) / (JOYSTICK_TRAVEL - DEAD_ZONE);
  return Math.sign(offset) * ratio * ratio * MAX_LINES_PER_SECOND;
}
