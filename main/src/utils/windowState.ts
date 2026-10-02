import type { BrowserWindow, Rectangle } from 'electron';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

export const WINDOW_STATE_KEY = 'pane.window-state';
const SAVE_DELAY_MS = 500;

export interface SavedWindowState {
  bounds: Rectangle;
  isMaximized: boolean;
  isFullScreen: boolean;
}

const savedWindowStateSchema = boundary.object({
  bounds: boundary.object({
    x: boundary.number,
    y: boundary.number,
    width: boundary.number,
    height: boundary.number,
  }),
  isMaximized: boundary.boolean,
  isFullScreen: boundary.boolean,
});

export function parseSavedWindowState(raw: string | null): SavedWindowState | null {
  if (!raw) return null;
  try {
    const state = decodeBoundary(JSON.parse(raw), savedWindowStateSchema);
    const { x, y, width, height } = state.bounds;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return state;
  } catch {
    return null;
  }
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Places saved bounds on the connected display they overlap most, shrunk and
 * moved to fit inside its work area. Returns null when they overlap no display
 * (the monitor they were saved on is gone), so the caller uses its defaults.
 */
export function fitBoundsToWorkAreas(bounds: Rectangle, workAreas: readonly Rectangle[]): Rectangle | null {
  let best: Rectangle | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const overlap = overlapArea(bounds, area);
    if (overlap > bestArea) {
      best = area;
      bestArea = overlap;
    }
  }
  if (!best) return null;

  const width = Math.min(bounds.width, best.width);
  const height = Math.min(bounds.height, best.height);
  return {
    x: Math.min(Math.max(bounds.x, best.x), best.x + best.width - width),
    y: Math.min(Math.max(bounds.y, best.y), best.y + best.height - height),
    width,
    height,
  };
}

/**
 * Saves the window's normal bounds and maximized/full-screen state as the user
 * moves and resizes it. The returned function writes any pending change now.
 */
export function trackWindowState(win: BrowserWindow, save: (state: SavedWindowState) => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const saveNow = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (win.isDestroyed()) return;
    save({
      bounds: win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    });
  };
  const scheduleSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveNow, SAVE_DELAY_MS);
  };

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('enter-full-screen', scheduleSave);
  win.on('leave-full-screen', scheduleSave);
  win.on('close', saveNow);
  return saveNow;
}
