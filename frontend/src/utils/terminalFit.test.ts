import { describe, expect, it } from 'vitest';
import {
  fitFontSize,
  fitGridFontSize,
  fitTerminalViewerGeometry,
  fittedHeight,
  fittedWidth,
  MAX_FOCUS_FONT_SIZE,
  MAX_TILE_FONT_SIZE,
  MIN_FOCUS_FONT_SIZE,
  MIN_TILE_FONT_SIZE,
  widestLine,
} from './terminalFit';

// What the app's default terminal font measures at in the running app.
const RATIO = 0.6;
const HEIGHT_RATIO = 1.3;
/** `fittedWidth` counts the terminal's own padding; the fit maths does not. */
const TERMINAL_CHROME_WIDTH = fittedWidth(1, 0, RATIO);

describe('fitFontSize', () => {
  it('picks the largest size at which every column still fits', () => {
    // 80 columns in 480px of glyph width is exactly 10px per em at this ratio.
    expect(fitFontSize(80 * 10 * RATIO, 80, RATIO)).toBe(10);
  });

  it('never goes below the legibility floor, however narrow the box', () => {
    expect(fitFontSize(20, 200, RATIO)).toBe(MIN_TILE_FONT_SIZE);
  });

  it('holds to the ceiling rather than filling a wide box with huge text', () => {
    expect(fitFontSize(4000, 20, RATIO)).toBe(MAX_TILE_FONT_SIZE);
  });

  it('honours a caller ceiling above the tile default', () => {
    expect(fitFontSize(4000, 20, RATIO, 16)).toBe(16);
  });

  it('rounds a fractional ideal down, so the last column still fits', () => {
    // 80 columns in 460.8px is an ideal of exactly 9.6px. Rounding up to 10
    // puts the trailing column several pixels outside the box the caller asked
    // it to fit, which is the hard cut mid-word this helper exists to avoid.
    const width = 80 * 9.6 * RATIO;
    const fitted = fitFontSize(width, 80, RATIO);

    expect(fitted).toBe(9);
    expect(fittedWidth(fitted, 80, RATIO) - TERMINAL_CHROME_WIDTH).toBeLessThanOrEqual(width);
  });

  it('treats an unmeasured box as the floor rather than dividing by zero', () => {
    expect(fitFontSize(0, 80, RATIO)).toBe(MIN_TILE_FONT_SIZE);
    expect(fitFontSize(500, 0, RATIO)).toBe(MAX_TILE_FONT_SIZE);
  });
});

describe('fittedWidth', () => {
  it('counts the terminal chrome that sits beside the glyphs', () => {
    // Without the chrome the trailing column lands outside the tile, which is
    // the hard cut mid-word this pair of helpers exists to prevent.
    expect(fittedWidth(10, 80, RATIO)).toBeGreaterThan(80 * 10 * RATIO);
  });

  it('agrees with fitFontSize that a fitted screen fits', () => {
    const width = 600;
    const columns = 40;
    const fontSize = fitFontSize(width, columns, RATIO);
    expect(fittedWidth(fontSize, columns, RATIO)).toBeLessThanOrEqual(width);
  });

  it('reports a screen that cannot fit even at the floor', () => {
    const width = 200;
    const columns = 200;
    expect(fitFontSize(width, columns, RATIO)).toBe(MIN_TILE_FONT_SIZE);
    expect(fittedWidth(MIN_TILE_FONT_SIZE, columns, RATIO)).toBeGreaterThan(width);
  });
});

describe('widestLine', () => {
  it('measures the widest row of a snapshot with no PTY dimensions', () => {
    expect(widestLine('ab\nabcd\nabc')).toBe(4);
  });

  it('is zero for empty text, so callers fall back rather than divide by it', () => {
    expect(widestLine('')).toBe(0);
  });
});

describe('fitGridFontSize', () => {
  it('fits both axes, not just the width it could afford', () => {
    // A grid that only had to satisfy the width would take 12px here and stand
    // a third taller than the box, pushing its oldest rows out of a wrapper
    // that clips them without saying so.
    const fit = fitGridFontSize(80 * 12 * RATIO, 24 * 8 * HEIGHT_RATIO * 1.2, 80, 24, RATIO, HEIGHT_RATIO);

    expect(fit.fontSize).toBe(8);
    expect(fit.fitsWidth).toBe(true);
    expect(fit.fitsHeight).toBe(true);
  });

  it('reports a tall PTY in a short window as not fitting, rather than clipping it', () => {
    // The blocker's scenario: a 60-row screen with a 500px body budget. Even
    // the focus floor needs about 560px, so the caller is told the grid does
    // not fit and grows the tile instead of hiding the top rows.
    const fit = fitGridFontSize(2000, 500, 80, 60, RATIO, HEIGHT_RATIO);

    expect(fit.fontSize).toBe(MIN_FOCUS_FONT_SIZE);
    expect(fit.fitsHeight).toBe(false);
    expect(fittedHeight(fit.fontSize, 60, HEIGHT_RATIO)).toBeGreaterThan(500);
  });

  it('goes below the preview floor before it gives up on showing the whole grid', () => {
    // One pixel of slack, because 60 * 7 * 1.3 * 1.2 lands a hair over 655 in
    // binary floating point and the fit stays deliberately conservative.
    const fit = fitGridFontSize(2000, 60 * 7 * HEIGHT_RATIO * 1.2 + 1, 80, 60, RATIO, HEIGHT_RATIO);

    expect(fit.fontSize).toBe(7);
    expect(fit.fontSize).toBeLessThan(MIN_TILE_FONT_SIZE);
    expect(fit.fitsHeight).toBe(true);
  });

  it('holds to the focus ceiling in a box with room to spare', () => {
    const fit = fitGridFontSize(10_000, 10_000, 80, 24, RATIO, HEIGHT_RATIO);

    expect(fit.fontSize).toBe(MAX_FOCUS_FONT_SIZE);
    expect(fit.fitsWidth).toBe(true);
    expect(fit.fitsHeight).toBe(true);
  });

  it('says so when even the floor cannot fit the width', () => {
    const fit = fitGridFontSize(120, 4000, 200, 10, RATIO, HEIGHT_RATIO);

    expect(fit.fontSize).toBe(MIN_FOCUS_FONT_SIZE);
    expect(fit.fitsWidth).toBe(false);
  });
});

describe('fitTerminalViewerGeometry', () => {
  it('preserves PTY dimensions above the old preview ceiling', () => {
    expect(fitTerminalViewerGeometry(500, 300, 401, 24, RATIO, HEIGHT_RATIO, false)).toMatchObject({
      cols: 401,
      rows: 24,
    });
  });

  it('preserves the same dimensions when fitting the whole grid', () => {
    expect(fitTerminalViewerGeometry(500, 300, 512, 60, RATIO, HEIGHT_RATIO, true)).toMatchObject({
      cols: 512,
      rows: 60,
    });
  });
});
