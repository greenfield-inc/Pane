/**
 * Fitting a monospace screen into a Mission Control tile.
 *
 * A tile is a fraction of the width the real terminal panel gets, and it must
 * never resize the agent's PTY — the PTY's width is what the agent painted
 * against, and changing it would reflow output the agent has already drawn. So
 * the only lever a tile has is the font size.
 *
 * Both tile bodies fit through here: the live terminal and the cheap snapshot
 * it is promoted from. Sharing the maths is the point — a tile that fitted one
 * way as a snapshot and another way once live would visibly jump the moment the
 * pointer landed on it.
 */

/** Legibility floor and a ceiling that keeps tiles from looking oversized. */
export const MIN_TILE_FONT_SIZE = 9;
export const MAX_TILE_FONT_SIZE = 13;
/** The focus view has room to breathe, so it may go a little larger. */
export const MAX_FOCUS_FONT_SIZE = 16;
/**
 * A lower floor, for the one view that promises the agent's *whole* screen.
 *
 * A preview clips what does not fit and says so with a fade, so its floor is
 * about legibility. The expanded view makes a different promise: every row of
 * the PTY, at once. A 60-row screen in a short window cannot keep that promise
 * at 9px, and the rows that lose are the oldest — pushed up and out behind the
 * wrapper's clip, with nothing on screen to say so. Six pixels is small, but a
 * small whole screen is what was asked for; below it the caller grows the tile
 * instead and the grid scrolls.
 */
export const MIN_FOCUS_FONT_SIZE = 6;
export const TILE_LINE_HEIGHT = 1.2;

/**
 * Space the rendered terminal occupies on top of its glyphs: the `.xterm`
 * padding on both sides plus the `.xterm-screen` left margin, as set in
 * index.css. Choosing a font against the raw box instead leaves the trailing
 * column outside it, and a column that lands outside a tile whose overflow is
 * hidden reads as a hard cut mid-word.
 */
export const TERMINAL_CHROME_X = 18;
export const TERMINAL_CHROME_Y = 15;

/**
 * Width of a character cell relative to the font size, measured once offscreen.
 *
 * Geometry has to be known *before* a terminal is constructed: calling
 * `terminal.resize()` after content has been written discards the
 * alternate-screen buffer, which is where full-screen agent TUIs live — the
 * tile then renders blank.
 */
/** A character cell's size relative to the font size it was measured at. */
interface CellRatios {
  width: number;
  height: number;
}

const cachedCharRatios = new Map<string, CellRatios>();

function measureCell(fontFamily: string): CellRatios {
  const cached = cachedCharRatios.get(fontFamily);
  if (cached !== undefined) return cached;

  const reference = 20;
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${fontFamily};font-size:${reference}px;`;
  probe.textContent = 'M'.repeat(100);
  document.body.appendChild(probe);
  const box = probe.getBoundingClientRect();
  const width = box.width / 100;
  const height = box.height;
  probe.remove();

  // Keyed by family: the fit maths is only correct when the font it measured is
  // the font the text renders in.
  const ratios = {
    width: width > 0 ? width / reference : 0.6,
    height: height > 0 ? height / reference : 1.3,
  };
  cachedCharRatios.set(fontFamily, ratios);
  return ratios;
}

export function charWidthRatio(fontFamily: string): number {
  return measureCell(fontFamily).width;
}

/**
 * Height of a character cell relative to the font size.
 *
 * Not 1: a font's natural line box is taller than its size, and xterm's
 * `lineHeight` option multiplies that box rather than the size. Assuming a row
 * is `fontSize * lineHeight` therefore under-counts every row — for the default
 * terminal font by about a quarter — and a grid fitted with that estimate comes
 * out taller than the box it was fitted to.
 */
export function charHeightRatio(fontFamily: string): number {
  return measureCell(fontFamily).height;
}


/**
 * Rendered height of one row at this font, as xterm lays it out.
 *
 * The single answer to a question three places used to guess at with
 * `fontSize * lineHeight`, which under-counts every row by about a quarter.
 */
export function rowHeight(fontSize: number, fontFamily: string): number {
  return fontSize * charHeightRatio(fontFamily) * TILE_LINE_HEIGHT;
}

/**
 * Largest font at which `columns` cells still fit `width`, held between the
 * legibility floor and the caller's ceiling.
 *
 * The cell ratio is passed in rather than measured here: the caller already
 * knows which font family it is about to render in, and keeping the arithmetic
 * free of the DOM is what makes it testable.
 *
 * Below the floor the answer is the floor: shrinking further would trade text
 * nobody can read for text that merely fits, so the surplus columns are clipped
 * instead and the caller says so.
 */
export function fitFontSize(
  width: number,
  columns: number,
  ratio: number,
  maxFontSize: number = MAX_TILE_FONT_SIZE,
): number {
  const ideal = width / Math.max(columns, 1) / ratio;
  // Floored, not rounded: an ideal of 9.6px rounds up to 10, and 10 is the size
  // at which the last column lands outside the box this was asked to fit. The
  // helper promises the largest size that *fits*, so it may only round down.
  return Math.max(Math.min(Math.floor(ideal), maxFontSize), MIN_TILE_FONT_SIZE);
}

/** Rendered height of `rows` at this font. */
export function fittedHeight(fontSize: number, rows: number, heightRatio: number): number {
  return rows * fontSize * heightRatio * TILE_LINE_HEIGHT;
}

/** How a whole grid came out against the box it was fitted to. */
export interface GridFit {
  fontSize: number;
  /** True when `columns` cells at `fontSize` fit the width they were given. */
  fitsWidth: boolean;
  /** True when `rows` at `fontSize` fit the height they were given. */
  fitsHeight: boolean;
}

export interface TerminalViewerGeometry {
  fontSize: number;
  cols: number;
  rows: number;
}

/**
 * Fit a secondary terminal without ever changing the PTY dimensions it mirrors.
 * The caller removes terminal chrome from the available glyph box first.
 */
export function fitTerminalViewerGeometry(
  width: number,
  height: number,
  cols: number,
  rows: number,
  widthRatio: number,
  heightRatio: number,
  fitWholeGrid: boolean,
): TerminalViewerGeometry {
  const fontSize = fitWholeGrid
    ? fitGridFontSize(width, height, cols, rows, widthRatio, heightRatio).fontSize
    : fitFontSize(width, cols, widthRatio);
  return { fontSize, cols, rows };
}

/**
 * Largest font at which a whole `columns` x `rows` grid fits `width` x `height`.
 *
 * The expanded tile's fit, where both axes matter: the point of that view is
 * the agent's entire screen, so a size that only satisfies the width would push
 * the top rows out of a wrapper that clips them silently.
 *
 * The height divisor is the measured cell, not `fontSize * lineHeight`: xterm
 * multiplies the font's natural line box, which is taller than the font size.
 *
 * Both boxes are glyph space — terminal chrome already taken out. The two
 * `fits` flags are the caller's cue that the floor was reached before the grid
 * fitted, and that it owes the user a scrollbar rather than a silent clip.
 */
export function fitGridFontSize(
  width: number,
  height: number,
  columns: number,
  rows: number,
  widthRatio: number,
  heightRatio: number,
): GridFit {
  const byWidth = width / Math.max(columns, 1) / widthRatio;
  const byHeight = height / Math.max(rows, 1) / (heightRatio * TILE_LINE_HEIGHT);
  const fontSize = Math.max(
    Math.min(Math.floor(Math.min(byWidth, byHeight)), MAX_FOCUS_FONT_SIZE),
    MIN_FOCUS_FONT_SIZE,
  );

  // A pixel of slack: the browser lays glyphs out in fractional pixels, and a
  // grid that misses by a rounding error is not a grid that needs a scrollbar.
  return {
    fontSize,
    fitsWidth: columns * fontSize * widthRatio <= width + 1,
    fitsHeight: fittedHeight(fontSize, rows, heightRatio) <= height + 1,
  };
}

/** Rendered width of `columns` cells at this font, chrome included. */
export function fittedWidth(fontSize: number, columns: number, ratio: number): number {
  return columns * fontSize * ratio + TERMINAL_CHROME_X;
}

/**
 * Columns in a block of already-rendered terminal text.
 *
 * A snapshot of a stopped pane carries no PTY dimensions, so the text itself is
 * the only record of how wide the screen was when it was painted.
 */
export function widestLine(text: string): number {
  let widest = 0;
  for (const line of text.split('\n')) {
    if (line.length > widest) widest = line.length;
  }
  return widest;
}
