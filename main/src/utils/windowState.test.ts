import { describe, expect, it } from 'vitest';
import { fitBoundsToWorkAreas, parseSavedWindowState } from './windowState';

const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const externalRight = { x: 1512, y: -300, width: 2560, height: 1415 };

describe('fitBoundsToWorkAreas', () => {
  it('keeps bounds that already sit inside a connected display', () => {
    expect(fitBoundsToWorkAreas({ x: 100, y: 80, width: 1200, height: 800 }, [laptop]))
      .toEqual({ x: 100, y: 80, width: 1200, height: 800 });
  });

  it('keeps a window on the secondary display it was saved on', () => {
    expect(fitBoundsToWorkAreas({ x: 2000, y: 0, width: 1400, height: 900 }, [laptop, externalRight]))
      .toEqual({ x: 2000, y: 0, width: 1400, height: 900 });
  });

  it('pulls a window hanging off the edge back inside the work area', () => {
    expect(fitBoundsToWorkAreas({ x: 1300, y: 700, width: 1000, height: 600 }, [laptop]))
      .toEqual({ x: 512, y: 345, width: 1000, height: 600 });
  });

  it('shrinks a window larger than the display to its work area', () => {
    expect(fitBoundsToWorkAreas({ x: 0, y: 0, width: 2400, height: 1300 }, [laptop]))
      .toEqual({ x: 0, y: 25, width: 1512, height: 920 });
  });

  it('moves a window mostly on the laptop but straddling the external display onto the laptop', () => {
    expect(fitBoundsToWorkAreas({ x: 1000, y: 100, width: 800, height: 600 }, [laptop, externalRight]))
      .toEqual({ x: 712, y: 100, width: 800, height: 600 });
  });

  it('returns null when the display the window was on is gone', () => {
    expect(fitBoundsToWorkAreas({ x: 2000, y: 0, width: 1400, height: 900 }, [laptop])).toBeNull();
  });
});

describe('parseSavedWindowState', () => {
  it('reads a stored state', () => {
    expect(parseSavedWindowState(JSON.stringify({
      bounds: { x: 10, y: 20, width: 1400, height: 900 },
      isMaximized: true,
      isFullScreen: false,
    }))).toEqual({
      bounds: { x: 10, y: 20, width: 1400, height: 900 },
      isMaximized: true,
      isFullScreen: false,
    });
  });

  it('ignores missing, corrupt, or degenerate values', () => {
    expect(parseSavedWindowState(null)).toBeNull();
    expect(parseSavedWindowState('{not json')).toBeNull();
    expect(parseSavedWindowState(JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 900 }, isMaximized: false, isFullScreen: false }))).toBeNull();
  });
});
