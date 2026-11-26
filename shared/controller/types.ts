/**
 * The platform-neutral controller frame every adapter produces. Buttons are
 * named by position (south is the bottom face button on every pad); only the
 * family profile (profiles.ts) decides which printed letter a position wears.
 */

export const CONTROLLER_BUTTONS = [
  'south', 'east', 'west', 'north',
  'l1', 'r1', 'l2', 'r2', 'l3', 'r3',
  'select', 'start',
  'up', 'down', 'left', 'right',
] as const;

export type ControllerButton = typeof CONTROLLER_BUTTONS[number];

/** Stick axes from -1 to 1, with +Y pointing down (the Gamepad API's convention). */
export interface ControllerAxes {
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

export const RESTING_AXES: ControllerAxes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };

/** One sample of a pad: the buttons held down now and where the sticks sit. */
export interface ControllerFrame {
  buttons: ReadonlySet<ControllerButton>;
  axes: ControllerAxes;
}

/** What an adapter knows about the pad, used to find its family. */
export interface ControllerDevice {
  id: string;
  name: string;
  /** USB vendor id, lower-case hex without 0x (`045e`), when the OS reports one. */
  vendorId?: string;
  productId?: string;
  /** Apple's GCController.productCategory (`DualSense`, `Xbox One`, `Switch Pro Controller`, `HID`…). */
  appleCategory?: string;
  hasRumble: boolean;
  /**
   * False when the OS has no layout for the pad (Chromium's `mapping === ''`),
   * so positions can't be trusted. Adapters that always know positions omit it.
   */
  standardMapping?: boolean;
}

export type Direction = 'up' | 'down' | 'left' | 'right';
