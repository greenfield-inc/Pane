import { describe, expect, it } from 'vitest';

import { JOYSTICK_TRAVEL, joystickLinesPerSecond } from './joystick';

describe('joystickLinesPerSecond', () => {
  it('ignores small wobbles around center', () => {
    expect(joystickLinesPerSecond(0)).toBe(0);
    expect(joystickLinesPerSecond(8)).toBe(0);
    expect(joystickLinesPerSecond(-8)).toBe(0);
  });

  it('scrolls up for an upward drag and down for a downward one, fastest at full travel', () => {
    expect(joystickLinesPerSecond(-JOYSTICK_TRAVEL)).toBe(-72);
    expect(joystickLinesPerSecond(JOYSTICK_TRAVEL)).toBe(72);
    expect(joystickLinesPerSecond(JOYSTICK_TRAVEL * 3)).toBe(72);
  });

  it('ramps gently: halfway past the dead zone is a quarter of full speed', () => {
    expect(joystickLinesPerSecond(28)).toBe(18);
  });
});
