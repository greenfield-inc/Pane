/**
 * Lane palette for the commit graph.
 *
 * Explicit hex values rather than CSS variables: these are consumed as SVG
 * `stroke`/`fill` attributes, and the hues are chosen to stay legible on both
 * the light and dark surfaces.
 */
const LANE_COLORS = [
  '#4f8ef7',
  '#37b877',
  '#e0913a',
  '#c765d6',
  '#e05a6b',
  '#3fb8c4',
  '#8f8ff0',
  '#c2a63a',
];

export function laneColor(colorIndex: number): string {
  return LANE_COLORS[colorIndex % LANE_COLORS.length];
}

export const LANE_WIDTH = 14;
export const ROW_HEIGHT = 44;
