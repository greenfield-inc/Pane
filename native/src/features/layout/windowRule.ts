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

/**
 * How far the person can drag Home's column: from 240 dp to the desktop sidebar's 500 dp, always
 * leaving the open screen 320 dp (a small phone's width).
 */
export function columnRange(windowWidth: number): { min: number; max: number } {
  const min = 240;
  return { min, max: Math.max(min, Math.min(500, windowWidth - 320)) };
}

/** Home's column: the width the person dragged it to, kept in range, or the default. */
export function homeColumnWidth(windowWidth: number, dragged: number | undefined): number {
  if (dragged === undefined) return columnWidth(windowWidth);
  const { min, max } = columnRange(windowWidth);
  return Math.round(Math.min(max, Math.max(min, dragged)));
}

/** Widths are kept per orientation: an unfolded phone held either way has room for different columns. */
export type Orientation = 'portrait' | 'landscape';

export function orientationOf({ width, height }: WindowSize): Orientation {
  return width > height ? 'landscape' : 'portrait';
}
