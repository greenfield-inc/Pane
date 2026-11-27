/**
 * Controller families: which printed letter sits at each position, and the
 * glyph a pad shows for every button. SDL, Steam and Apple find the family
 * from the vendor and product ids, the OS category or the name, and let the
 * person override it; Pane does the same.
 */
import type { ControllerButton, ControllerDevice } from './types';

export type ControllerFamily = 'xbox' | 'playstation' | 'nintendo' | 'generic' | 'unrecognised';
/** The Settings › Controller "Button letters" row. */
export type ButtonLettersOverride = 'auto' | 'xbox' | 'playstation' | 'nintendo';

export const BUTTON_LETTERS_OVERRIDES: readonly ButtonLettersOverride[] = ['auto', 'xbox', 'playstation', 'nintendo'];

/**
 * A button by what the scheme calls it. Face buttons are printed letters (A
 * picks on every pad, wherever the pad prints it); the rest are positions.
 */
export type ControllerKey =
  | 'A' | 'B' | 'X' | 'Y'
  | 'L1' | 'R1' | 'L2' | 'R2' | 'L3' | 'R3'
  | 'minus' | 'plus'
  | 'up' | 'down' | 'left' | 'right';

type Face = 'south' | 'east' | 'west' | 'north';
type FaceLetters = Record<Face, 'A' | 'B' | 'X' | 'Y'>;

const XBOX_FACES = { south: 'A', east: 'B', west: 'X', north: 'Y' } satisfies FaceLetters;
const NINTENDO_FACES = { south: 'B', east: 'A', west: 'Y', north: 'X' } satisfies FaceLetters;

const POSITION_KEYS = {
  l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', l3: 'L3', r3: 'R3',
  select: 'minus', start: 'plus',
  up: 'up', down: 'down', left: 'left', right: 'right',
} satisfies Record<Exclude<ControllerButton, Face>, ControllerKey>;

function isFace(button: ControllerButton): button is Face {
  return button === 'south' || button === 'east' || button === 'west' || button === 'north';
}

/** The scheme's name for the button at `position` on a pad of `family`. */
export function keyForButton(family: ControllerFamily, position: ControllerButton): ControllerKey {
  if (!isFace(position)) return POSITION_KEYS[position];
  return (family === 'nintendo' ? NINTENDO_FACES : XBOX_FACES)[position];
}

const SHARED_LABELS = { up: '↑', down: '↓', left: '←', right: '→' } satisfies Record<'up' | 'down' | 'left' | 'right', string>;

const FAMILY_LABELS = {
  xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', L1: 'LB', R1: 'RB', L2: 'LT', R2: 'RT', L3: 'LS', R3: 'RS', minus: 'View', plus: 'Menu' },
  playstation: { A: '✕', B: '○', X: '□', Y: '△', L1: 'L1', R1: 'R1', L2: 'L2', R2: 'R2', L3: 'L3', R3: 'R3', minus: 'Create', plus: 'Options' },
  nintendo: { A: 'A', B: 'B', X: 'X', Y: 'Y', L1: 'L', R1: 'R', L2: 'ZL', R2: 'ZR', L3: 'L3', R3: 'R3', minus: '−', plus: '+' },
  generic: { A: 'A', B: 'B', X: 'X', Y: 'Y', L1: 'L1', R1: 'R1', L2: 'L2', R2: 'R2', L3: 'L3', R3: 'R3', minus: 'Select', plus: 'Start' },
  unrecognised: { A: 'A', B: 'B', X: 'X', Y: 'Y', L1: 'L1', R1: 'R1', L2: 'L2', R2: 'R2', L3: 'L3', R3: 'R3', minus: '−', plus: '+' },
} satisfies Record<ControllerFamily, Record<Exclude<ControllerKey, 'up' | 'down' | 'left' | 'right'>, string>>;

/** What the pad prints on `key` (✕ for A on a PlayStation pad, ZR for R2 on a Nintendo one). */
export function keyLabel(family: ControllerFamily, key: ControllerKey): string {
  if (key === 'up' || key === 'down' || key === 'left' || key === 'right') return SHARED_LABELS[key];
  return FAMILY_LABELS[family][key];
}

const VENDOR_FAMILIES = new Map<string, ControllerFamily>([
  ['045e', 'xbox'],
  ['054c', 'playstation'],
  ['057e', 'nintendo'],
  // 8BitDo prints Nintendo letters in every mode that reports its own vendor.
  ['2dc8', 'nintendo'],
]);

function familyFromAppleCategory(category: string): ControllerFamily | null {
  if (/dualsense|dualshock/i.test(category)) return 'playstation';
  if (/xbox/i.test(category)) return 'xbox';
  if (/switch|joy-?con|nintendo/i.test(category)) return 'nintendo';
  return null;
}

function familyFromName(name: string): ControllerFamily | null {
  if (/xinput|xbox/i.test(name)) return 'xbox';
  if (/dualsense|dualshock|playstation/i.test(name)) return 'playstation';
  if (/pro controller|joy-?con|nintendo|switch/i.test(name)) return 'nintendo';
  return null;
}

/** The pad's family from what the OS reports about it. */
export function detectFamily(device: ControllerDevice): ControllerFamily {
  if (device.standardMapping === false) return 'unrecognised';
  const byVendor = device.vendorId ? VENDOR_FAMILIES.get(device.vendorId.toLowerCase()) : undefined;
  if (byVendor) return byVendor;
  const byCategory = device.appleCategory ? familyFromAppleCategory(device.appleCategory) : null;
  if (byCategory) return byCategory;
  return familyFromName(device.name) ?? 'generic';
}

/** The family Pane uses: the person's override, unless the pad's layout can't be read at all. */
export function resolveFamily(device: ControllerDevice, override: ButtonLettersOverride): ControllerFamily {
  const detected = detectFamily(device);
  if (detected === 'unrecognised' || override === 'auto') return detected;
  return override;
}

/**
 * Reads a Chromium `Gamepad.id` and `Gamepad.mapping` into a device. Chromium
 * writes `Name (STANDARD GAMEPAD Vendor: 054c Product: 09cc)`, and on Windows
 * `Xbox 360 Controller (XInput STANDARD GAMEPAD)` for every XInput pad.
 */
export function deviceFromGamepadId(id: string, mapping: string, hasRumble: boolean): ControllerDevice {
  const ids = /Vendor:\s*([0-9a-f]{4})\s+Product:\s*([0-9a-f]{4})/i.exec(id)
    ?? /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(id);
  const name = id.replace(/\s*\([^)]*\)\s*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '').trim() || id;
  return {
    id,
    name: /xinput/i.test(id) ? `${name} (XInput)` : name,
    vendorId: ids?.[1]?.toLowerCase(),
    productId: ids?.[2]?.toLowerCase(),
    hasRumble,
    standardMapping: mapping === 'standard',
  };
}
