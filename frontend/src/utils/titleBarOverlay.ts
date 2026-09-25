/**
 * Theme -> Window Controls Overlay colour bridge.
 *
 * On Windows and Linux the minimise/maximise/close buttons are drawn by the OS,
 * outside the page, so no CSS reaches them. Electron takes their plate and glyph
 * colours as strings, which means every theme switch has to resolve the active
 * theme's tokens and hand the pair back to the main process.
 *
 * The colours are read from the live cascade rather than a per-theme table, so
 * all 27 themes — and any future one — are covered by whatever
 * `--color-bg-primary` and `--color-text-secondary` resolve to.
 */

/** Plate colour: the title bar strip's own background (`bg-surface-primary`, shared with the sidebar). */
const OVERLAY_COLOR_TOKEN = '--color-surface-primary';
/** Glyph colour: the same token the strip's pane name uses. */
const OVERLAY_SYMBOL_COLOR_TOKEN = '--color-text-secondary';

export interface TitleBarOverlayColors {
  color: string;
  symbolColor: string;
}

/**
 * True when the main process handed this window's title bar to the page. Comes
 * from the preload (argv), so it is available synchronously on first render.
 * False in the browser-served Remote PWA, which has no Electron bridge at all.
 */
export function isWindowControlsOverlayEnabled(): boolean {
  return window.electronAPI?.windowControlsOverlayEnabled === true;
}

/** Collapsed sidebar rail width, which is where a collapsed layout's content starts. */
export const COLLAPSED_SIDEBAR_PX = 48;

/**
 * Where tabs may start in the title strip: past the sidebar, and never under the
 * macOS traffic lights and sidebar toggle (or the overlay's leading controls).
 */
export function titleStripContentLeft(sidebarPx: number, mac: boolean): number {
  return Math.max(sidebarPx, mac ? 136 : 72);
}

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX_LONG = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const FUNCTIONAL = /^rgba?\(([^)]+)\)$/i;

const toHexByte = (channel: number): string =>
  Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0');

/**
 * Narrows a CSS colour to the `#rrggbb` form Electron's overlay accepts.
 *
 * Chromium's colour parser behind `titleBarOverlay` is not the full CSS grammar:
 * it takes hex and comma-separated `rgb()`/`rgba()` and nothing else. Normalising
 * here keeps the main process from having to guess, and keeps a theme that
 * happens to author a token in some other notation from silently killing the
 * bridge. Alpha is dropped — the overlay plate is always opaque.
 */
export function toOverlayHex(cssColor: string): string | null {
  const value = cssColor.trim();
  if (!value) return null;

  const short = HEX_SHORT.exec(value);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }

  const long = HEX_LONG.exec(value);
  if (long) {
    return `#${long[1]}`.toLowerCase();
  }

  const functional = FUNCTIONAL.exec(value);
  if (!functional) return null;

  // Accepts both the legacy `rgb(r, g, b)` serialization the CSSOM returns and
  // the modern `rgb(r g b / a)` an author may have written.
  const channels = functional[1]
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((channel) => (channel.endsWith('%') ? (parseFloat(channel) * 255) / 100 : parseFloat(channel)));

  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;

  return `#${channels.map(toHexByte).join('')}`;
}

/**
 * Resolves the overlay colours from the theme classes currently stamped on the
 * document.
 *
 * The tokens are read off a probe element rather than via
 * `getComputedStyle(root).getPropertyValue('--color-bg-primary')`: a custom
 * property's computed value is only var()-substituted, so it comes back in
 * whatever notation the theme author used (`#0d1117`, `rgb(13 17 23)`, a
 * `var()` chain). Resolving them as real `background-color`/`color` declarations
 * makes the CSSOM serialize both as `rgb(r, g, b)`, one shape to parse.
 */
export function readTitleBarOverlayColors(doc: Document = document): TitleBarOverlayColors | null {
  const color = readThemeTokenHex(OVERLAY_COLOR_TOKEN, doc);
  const symbolColor = readThemeTokenHex(OVERLAY_SYMBOL_COLOR_TOKEN, doc);
  return color && symbolColor ? { color, symbolColor } : null;
}

export function readThemeTokenHex(token: string, doc: Document = document): string | null {
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = [
    'position:absolute',
    'width:0',
    'height:0',
    'overflow:hidden',
    'pointer-events:none',
    `background-color:var(${token})`,
  ].join(';');

  doc.body.appendChild(probe);
  try {
    const computed = getComputedStyle(probe);

    // A missing token makes `var()` invalid at computed-value time, which lands
    // on the initial `transparent` rather than on an error. Reporting that would
    // weld a black plate to the strip, so leave the overlay as it is instead.
    if (/^rgba\(.*,\s*0\)$/.test(computed.backgroundColor) || computed.backgroundColor === 'transparent') {
      return null;
    }

    return toOverlayHex(computed.backgroundColor);
  } finally {
    probe.remove();
  }
}
