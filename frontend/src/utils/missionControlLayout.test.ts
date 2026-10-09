import { describe, expect, it } from 'vitest';
import { fitColumns } from './missionControlLayout';

/** What an 80-column tile at the legibility floor measures in the running app. */
const TILE_WIDTH = 450;

describe('fitColumns', () => {
  it('honours the stored density when the width and the tiles both allow it', () => {
    expect(fitColumns(4, 4000, TILE_WIDTH, 12)).toBe(4);
  });

  it('steps down rather than shrinking tiles past readable on a narrow window', () => {
    // Room for two nominal tiles, whatever the user asked for.
    expect(fitColumns(4, 2 * TILE_WIDTH + 10, TILE_WIDTH, 12)).toBe(2);
  });

  it('gives a lone agent the whole row instead of a third of it', () => {
    // The default density on a wide display used to lay out three columns for
    // one agent, leaving two thirds of the row empty and its terminal small for
    // no reason.
    expect(fitColumns(3, 4000, TILE_WIDTH, 1)).toBe(1);
    expect(fitColumns(3, 4000, TILE_WIDTH, 2)).toBe(2);
  });

  it('restores the requested layout as soon as there are agents to fill it', () => {
    // The cap is on what gets laid out, never on the stored density.
    expect(fitColumns(3, 4000, TILE_WIDTH, 3)).toBe(3);
    expect(fitColumns(3, 4000, TILE_WIDTH, 9)).toBe(3);
  });

  it('keeps a column for an empty group rather than collapsing its template', () => {
    expect(fitColumns(3, 4000, TILE_WIDTH, 0)).toBe(1);
  });

  it('holds the stored density until the grid has been measured', () => {
    expect(fitColumns(3, 0, TILE_WIDTH, 8)).toBe(3);
  });
});
