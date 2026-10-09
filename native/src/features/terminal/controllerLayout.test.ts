import { describe, expect, it } from 'vitest';

import { controllerLayout } from './controllerLayout';

describe('controllerLayout', () => {
  it('centers the joystick and lifts the D-pad five rows plus a gap above the bottom', () => {
    // 600 pt, 40 rows: 15 pt rows, so the pad sits 75 + 8 = 83 pt up.
    // The joystick centers at (600 - 160) / 2 = 220; the lowest it may sit is 600 - 83 - 108 - 8 - 160 = 241.
    expect(controllerLayout(600, 40)).toEqual({ joystickTop: 220, padBottom: 83 });
  });

  it('raises the joystick above center when the D-pad needs the room', () => {
    // 420 pt, 28 rows: pad 83 pt up; center would be 130, but the lowest clear top is 420 - 83 - 108 - 8 - 160 = 61.
    expect(controllerLayout(420, 28)).toEqual({ joystickTop: 61, padBottom: 83 });
  });

  it('hides the D-pad when the terminal is too short, as with the keyboard up', () => {
    // 200 pt, 13 rows: the pad would need 77 + 8 + 108 pt below a 172 pt joystick.
    expect(controllerLayout(200, 13)).toEqual({ joystickTop: 20, padBottom: null });
  });
});
