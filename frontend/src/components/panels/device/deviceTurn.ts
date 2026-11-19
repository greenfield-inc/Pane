import type { DeviceOrientation } from '../../../../../shared/types/devices';

/** A point on a screen, from 0 to 1 on each axis. */
export interface ScreenPoint { x: number; y: number }

/** A movement across a screen, as fractions of it. */
export interface ScreenDelta { dx: number; dy: number }

/** Degrees clockwise the tab turns a frame so the device's screen shows upright. */
export type ScreenTurn = 0 | 90 | 180 | 270;

/**
 * How far to turn a frame of a device turned to `orientation`. A simulator's stream stays a
 * portrait framebuffer when the device turns, so a landscape app arrives on its side; a frame that
 * already has the turned shape (an emulator's) needs no turn.
 */
export function screenTurn(orientation: DeviceOrientation | undefined, width: number, height: number): ScreenTurn {
  const portraitFrame = height >= width;
  if (orientation === 'landscape_left') return portraitFrame ? 90 : 0;
  if (orientation === 'landscape_right') return portraitFrame ? 270 : 0;
  if (orientation === 'portrait_upside_down') return 180;
  return 0;
}

/** A point on the upright screen as the tab shows it (0 to 1 each way), as a point on the device's own frame. */
export function framePoint(turn: ScreenTurn, at: ScreenPoint): ScreenPoint {
  if (turn === 90) return { x: at.y, y: 1 - at.x };
  if (turn === 270) return { x: 1 - at.y, y: at.x };
  if (turn === 180) return { x: 1 - at.x, y: 1 - at.y };
  return at;
}

/** A movement on the upright screen (fractions of it) as a movement on the device's own frame. */
export function frameDelta(turn: ScreenTurn, delta: ScreenDelta): ScreenDelta {
  if (turn === 90) return { dx: delta.dy, dy: -delta.dx };
  if (turn === 270) return { dx: -delta.dy, dy: delta.dx };
  if (turn === 180) return { dx: -delta.dx, dy: -delta.dy };
  return delta;
}
