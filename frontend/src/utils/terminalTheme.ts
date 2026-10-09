import type { ITheme } from '@xterm/xterm';

interface TerminalColorFallbacks {
  [variable: string]: { light: string; dark: string };
}

// Convert rgb(r g b) format to hex format
const rgbToHex = (rgb: string): string => {
  // Check if already in hex format
  if (rgb.startsWith('#')) return rgb;

  // Match rgb(r g b) or rgb(r, g, b) format
  const match = rgb.match(/rgb\((\d+)[\s,]+(\d+)[\s,]+(\d+)\)/);
  if (match) {
    const r = parseInt(match[1], 10);
    const g = parseInt(match[2], 10);
    const b = parseInt(match[3], 10);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }

  // If we can't parse it, return as-is
  return rgb;
};

// Get CSS variable value from the document with smart fallbacks
const getCSSVariable = (name: string): string => {
  // Force a reflow to ensure CSS variables are up to date
  void document.documentElement.offsetHeight;

  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (value) {
    // Convert to hex format if needed
    return rgbToHex(value);
  }

  // Provide smart fallbacks based on current theme
  const isLight = document.documentElement.classList.contains('light');
  const isDark = document.documentElement.classList.contains('dark');
  const isOled = document.documentElement.classList.contains('oled');
  const isDusk = document.documentElement.classList.contains('dusk');
  const isForge = document.documentElement.classList.contains('forge');

  // Define theme-aware fallbacks (already in hex format)
  const fallbacks: TerminalColorFallbacks = {
    '--color-terminal-bg': { light: '#ffffff', dark: '#111827' },
    '--color-terminal-fg': { light: '#1e2026', dark: '#f3f4f6' },
    '--color-terminal-cursor': { light: '#6366f1', dark: '#818cf8' },
    '--color-terminal-black': { light: '#1e2026', dark: '#111827' },
    '--color-terminal-white': { light: '#f9fafb', dark: '#f3f4f6' },
    '--color-terminal-bright-black': { light: '#6b7280', dark: '#6b7280' },
    '--color-terminal-bright-white': { light: '#f3f4f6', dark: '#ffffff' },
  };

  const fallback = fallbacks[name];
  if (fallback) {
    // Prioritize explicit theme classes, then default to dark
    if (isForge || isDusk || isDark || isOled) return fallback.dark;
    if (isLight) return fallback.light;
    return fallback.dark;
  }

  // Default color fallbacks
  return isLight ? '#000000' : '#ffffff';
};

// Terminal theme generator that reads from CSS variables
export const getTerminalTheme = (): ITheme => {
  // Only set when the theme defines it (no fallback — dark themes keep xterm's default selection)
  const selectionBg = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-terminal-selection-bg')
    .trim();
  const theme: ITheme = {
    background: getCSSVariable('--color-terminal-bg'),
    foreground: getCSSVariable('--color-terminal-fg'),
    cursor: getCSSVariable('--color-terminal-cursor'),
    black: getCSSVariable('--color-terminal-black'),
    red: getCSSVariable('--color-terminal-red'),
    green: getCSSVariable('--color-terminal-green'),
    yellow: getCSSVariable('--color-terminal-yellow'),
    blue: getCSSVariable('--color-terminal-blue'),
    magenta: getCSSVariable('--color-terminal-magenta'),
    cyan: getCSSVariable('--color-terminal-cyan'),
    white: getCSSVariable('--color-terminal-white'),
    brightBlack: getCSSVariable('--color-terminal-bright-black'),
    brightRed: getCSSVariable('--color-terminal-bright-red'),
    brightGreen: getCSSVariable('--color-terminal-bright-green'),
    brightYellow: getCSSVariable('--color-terminal-bright-yellow'),
    brightBlue: getCSSVariable('--color-terminal-bright-blue'),
    brightMagenta: getCSSVariable('--color-terminal-bright-magenta'),
    brightCyan: getCSSVariable('--color-terminal-bright-cyan'),
    brightWhite: getCSSVariable('--color-terminal-bright-white'),
  };
  if (selectionBg) theme.selectionBackground = selectionBg;
  return theme;
};

// Script terminal theme (slightly different background for better UI integration)
export const getScriptTerminalTheme = () => {
  const baseTheme = getTerminalTheme();
  const isLight = document.documentElement.classList.contains('light');
  const isOled = document.documentElement.classList.contains('oled');
  const isForge = document.documentElement.classList.contains('forge');
  const isDusk = document.documentElement.classList.contains('dusk');

  // Use surface colors for better integration with the UI
  const surfaceBackground = getCSSVariable('--color-surface-secondary');

  return {
    ...baseTheme,
    background: surfaceBackground || (isLight ? '#f9fafb' : isForge ? '#1E1F22' : isDusk ? '#111827' : isOled ? '#080808' : '#1f2937'),
  };
};

/**
 * Terminal typeface and contrast, shared by every xterm surface.
 *
 * These live here rather than in `TerminalPanel` because a secondary viewer
 * (a Mission Control tile) has to render in the same typeface as the panel it
 * mirrors: it measures character width to choose a font size that fits the
 * PTY's columns, and measuring one font while rendering another puts the
 * geometry maths on the wrong metrics.
 */
export const DEFAULT_TERMINAL_FONT_FAMILY = 'Geist Mono';

export function buildTerminalFontFamily(userFont: string): string {
  return `"${userFont}", "Symbols Nerd Font Mono", monospace`;
}

// xterm halves the configured ratio for dim (SGR 2) cells, so 9 is what gets dim
// CLI output (Claude Code / Codex) to 4.5:1 AA. Off-state stays a modest safety
// floor so the deliberate muted grays in the dark themes survive.
const HIGH_CONTRAST_MIN_RATIO = 9;   // dim cells get ratio/2 = 4.5 (AA)
const LIGHT_MIN_RATIO = 4.5;
const DARK_MIN_RATIO = 3;

// Takes highContrast as an argument rather than reading the `high-contrast`
// class: that class is stamped by ThemeProvider's effect, and React flushes
// passive effects child-first, so a caller's effect would observe the previous
// value and leave the terminal one toggle behind.
export function getMinimumContrastRatio(highContrast: boolean): number {
  if (highContrast) return HIGH_CONTRAST_MIN_RATIO;
  return document.documentElement.classList.contains('light') ? LIGHT_MIN_RATIO : DARK_MIN_RATIO;
}
