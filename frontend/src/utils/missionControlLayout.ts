import type { MissionControlDensity } from '../../../shared/types/missionControl';
import { charWidthRatio, fittedWidth, MIN_TILE_FONT_SIZE } from './terminalFit';

/**
 * How many columns of tiles the grid actually lays out.
 *
 * Two things reduce the user's stored density, and both are about not wasting
 * the display: the window may be too narrow to carry that many readable
 * terminals, and there may simply not be that many agents to show.
 */

/**
 * The width a tile needs before it is worth calling a view of a terminal.
 *
 * Derived rather than picked: a conventional 80-column screen at the legibility
 * floor is the narrowest thing that still reads as a terminal, and the cell
 * width depends on the font the user configured. An arbitrary constant here
 * would either starve tiles on a laptop or waste a 4K display.
 */
const NOMINAL_TILE_COLUMNS = 80;
/** Matches the grid's `gap-2.5`. */
const GRID_GAP_PX = 10;

export const DENSITY_OPTIONS: readonly MissionControlDensity[] = [1, 2, 3, 4];

export function minTileWidth(fontFamily: string): number {
  return fittedWidth(MIN_TILE_FONT_SIZE, NOMINAL_TILE_COLUMNS, charWidthRatio(fontFamily));
}

/**
 * The requested column count, reduced to what this width and this many tiles
 * can carry.
 *
 * The cap is a function of the space available, so the same setting means more
 * columns on a large display and fewer on a laptop: a 4K screen honours 4x,
 * and a narrow window steps down rather than shrinking tiles past the point
 * where their content is readable.
 *
 * The tile width is passed in rather than measured here: measuring needs the
 * DOM, and keeping the arithmetic free of it is what makes it testable.
 *
 * `tileCount` caps it again from the other side. Three columns for one agent
 * gives that agent a third of the row and leaves two thirds empty, so its
 * terminal is small for no reason at all. The user's stored density is
 * untouched — this is only what gets laid out — so the requested layout comes
 * back as soon as there are agents to fill it.
 *
 * Walking the option list keeps the result inside the density union without an
 * assertion, and the options are ordered, so the last one that fits wins.
 */
export function fitColumns(
  density: MissionControlDensity,
  width: number,
  tileWidth: number,
  tileCount: number,
): MissionControlDensity {
  if (width <= 0) return density;
  // n tiles carry n-1 gaps between them, so counting on width alone overshoots
  // and leaves the last column a few characters short of nominal.
  const capacity = Math.max(1, Math.floor((width + GRID_GAP_PX) / (Math.max(tileWidth, 1) + GRID_GAP_PX)));
  // An empty group still needs a column count for its (empty) grid template.
  const wanted = Math.min(capacity, Math.max(tileCount, 1));

  let fitted: MissionControlDensity = 1;
  for (const option of DENSITY_OPTIONS) {
    if (option <= density && option <= wanted) fitted = option;
  }
  return fitted;
}
