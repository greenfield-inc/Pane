/**
 * Rows an agent keeps at the bottom of its terminal: Claude Code draws a rule,
 * its input line, a rule and a status line. One more row of margin.
 */
const AGENT_CHROME_ROWS = 5;
const GAP = 8;
/** The D-pad cluster's height, and the joystick's height and least top offset. */
const PAD_HEIGHT = 108;
const JOYSTICK_HEIGHT = 160;
const JOYSTICK_MIN_TOP = 12;

export interface ControllerLayout {
  /** The joystick's top, in points: centered, or higher when the D-pad needs the room. */
  joystickTop: number;
  /** The D-pad's distance above the bottom edge, clear of the agent's input box and status line; null hides it. */
  padBottom: number | null;
}

/**
 * Places the floating controls on a terminal `height` points tall that fits
 * `rows` rows. The D-pad hides when the terminal is too short to hold it
 * clear of the agent's bottom rows and the joystick (with the keyboard up,
 * for example); the joystick always shows.
 */
export function controllerLayout(height: number, rows: number): ControllerLayout {
  const centered = Math.max(JOYSTICK_MIN_TOP, Math.round((height - JOYSTICK_HEIGHT) / 2));
  if (height <= 0 || rows <= 0) return { joystickTop: centered, padBottom: null };
  const padBottom = Math.ceil((height / rows) * AGENT_CHROME_ROWS) + GAP;
  const highestPadTop = height - padBottom - PAD_HEIGHT;
  const lowestJoystickTop = highestPadTop - GAP - JOYSTICK_HEIGHT;
  if (lowestJoystickTop < JOYSTICK_MIN_TOP) return { joystickTop: centered, padBottom: null };
  return { joystickTop: Math.min(centered, lowestJoystickTop), padBottom };
}
