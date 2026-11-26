import type { RawButton, RawDevice } from '../../../modules/pane-controller';

/** Button positions, as the shared controller layer names them. */
export type Position =
  | 'south' | 'east' | 'west' | 'north'
  | 'l1' | 'r1' | 'l2' | 'r2' | 'l3' | 'r3'
  | 'select' | 'start'
  | 'up' | 'down' | 'left' | 'right';

const BY_POSITION: Record<'a' | 'b' | 'x' | 'y', Position> = { a: 'south', b: 'east', x: 'west', y: 'north' };
const BY_LABEL: Record<'a' | 'b' | 'x' | 'y', Position> = { a: 'east', b: 'south', x: 'north', y: 'west' };
const NINTENDO_VENDOR = 0x057e;

/**
 * Whether the platform names this pad's face buttons by their printed letter
 * instead of by position. Android's key layout for Nintendo pads
 * (Vendor_057e_Product_*.kl) keeps the labels, so KEYCODE_BUTTON_A is the right
 * button; SDL treats Apple's buttonA on Switch pads the same way. Every other
 * pad reports positions (A is the bottom button).
 */
export function namesByLabel(platform: 'android' | 'ios', device: RawDevice | undefined): boolean {
  if (!device) return false;
  if (platform === 'android') return device.vendorId === NINTENDO_VENDOR;
  return /switch|joy-con|nintendo/i.test(device.appleCategory ?? '');
}

/** The physical position of a raw button: what the shared layer turns into a printed letter. */
export function toPosition(button: RawButton, labelled: boolean): Position {
  if (button === 'a' || button === 'b' || button === 'x' || button === 'y') {
    return (labelled ? BY_LABEL : BY_POSITION)[button];
  }
  return button;
}
