/**
 * When the app draws Home beside the open screen: a window at least 600 dp wide and 480 dp tall,
 * whatever the device, posture or orientation. Unfolded foldables, tablets, Chromebooks and wide
 * split-screen windows qualify; a folded phone, a phone on its side and a narrow split do not.
 */
const WIDE_MIN_WIDTH = 600;
const WIDE_MIN_HEIGHT = 480;
/** Home collapsed to its rail. */
export const RAIL_WIDTH = 64;

export interface WindowSize {
  width: number;
  height: number;
}

export function isWide({ width, height }: WindowSize): boolean {
  return width >= WIDE_MIN_WIDTH && height >= WIDE_MIN_HEIGHT;
}

/** Home's column: 36% of the window, from 280 to 352 dp. */
export function columnWidth(windowWidth: number): number {
  return Math.min(352, Math.max(280, Math.round(windowWidth * 0.36)));
}
