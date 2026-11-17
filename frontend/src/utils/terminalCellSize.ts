import type { Terminal } from '@xterm/xterm';

interface CellSize { width: number; height: number }

/** Cell sizes by xterm font (`${size}px ${family}`): taken from revealed terminals, else measured. */
const cellSizes = new Map<string, CellSize>();

/** Records a revealed terminal's real cell, so later skeletons for its font sit exactly on its rows. */
export function noteTerminalCell(terminal: Terminal, screen: Element): void {
  if (terminal.rows <= 0 || terminal.cols <= 0) return;
  const box = screen.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return;
  cellSizes.set(`${terminal.options.fontSize}px ${terminal.options.fontFamily}`, { width: box.width / terminal.cols, height: box.height / terminal.rows });
}

/**
 * The cell xterm lays text out on for this font, measured the way xterm does:
 * the canvas font box, rounded to device pixels (height up, width down).
 */
export function measureTerminalCell(fontFamily: string, fontSize: number): CellSize {
  const key = `${fontSize}px ${fontFamily}`;
  const known = cellSizes.get(key);
  if (known) return known;
  const fallback = { width: fontSize * 0.6, height: Math.ceil(fontSize * 1.3) };
  // Server rendering (tests) has no document to measure in.
  const context = globalThis.document?.createElement('canvas').getContext('2d');
  if (!context) return fallback;
  context.font = key;
  const metrics = context.measureText('W');
  const ratio = window.devicePixelRatio || 1;
  const height = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
  const cell = height > 0 && metrics.width > 0
    ? { width: Math.floor(metrics.width * ratio) / ratio, height: Math.ceil(height * ratio) / ratio }
    : fallback;
  // A font still loading measures as its fallback; only keep a real measure.
  let loaded = true;
  try { loaded = document.fonts?.check?.(key) !== false; } catch { loaded = false; }
  if (loaded) cellSizes.set(key, cell);
  return cell;
}
