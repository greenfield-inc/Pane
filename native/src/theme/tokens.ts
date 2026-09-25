import { Platform } from 'react-native';

/**
 * Light is the Remote Pane PWA's design, which is this app's spec: its fixed
 * `light-rounded` theme, with values resolved from
 * frontend/src/styles/tokens/colors.css (tmp/assets/mobile/reference/tokens.json).
 * The PWA has no dark mode; dark uses the desktop's default dark theme.
 */
const dark = {
  background: '#010409',
  surface: '#0d1117',
  surfaceRaised: '#161b22',
  surfacePressed: '#21262d',
  border: 'rgba(240, 246, 252, 0.10)',
  text: '#e6edf3',
  textSecondary: '#c8d0d9',
  textMuted: '#7d8590',
  accent: '#1f6feb',
  accentText: '#58a6ff',
  onAccent: '#ffffff',
  success: '#3fb950',
  warning: '#d29922',
  danger: '#f85149',
  info: '#58a6ff',
  neutral: '#6e7681',
  skeleton: '#161b22',
  scrim: 'rgba(1, 4, 9, 0.6)',
  selected: 'rgba(31, 111, 235, 0.15)',
};

type ColorTokens = { [Key in keyof typeof dark]: string };

const light: ColorTokens = {
  background: '#ffffff', // --color-bg-primary
  surface: '#ffffff', // --color-surface-primary
  surfaceRaised: '#f6f8fa', // --color-surface-secondary
  surfacePressed: '#eaeef2', // --color-surface-hover
  border: 'rgba(31, 35, 40, 0.12)', // --color-border-primary
  text: '#1f2328', // --color-text-primary
  textSecondary: '#5d656e', // --color-text-secondary
  textMuted: '#6b7280', // --color-text-muted
  accent: '#2563eb', // --color-interactive
  accentText: '#1d4ed8', // --color-interactive-text
  onAccent: '#ffffff', // --color-text-on-interactive
  success: '#1a7f37',
  warning: '#9a6700',
  danger: '#cf222e',
  info: '#2563eb',
  neutral: '#6b7280',
  skeleton: '#eaeef2',
  scrim: 'rgba(31, 35, 40, 0.4)',
  selected: '#dbeafe', // --color-surface-navigation-selected
};

export const colors = { light, dark };

/**
 * xterm palettes from the desktop app's default terminal themes
 * (`--color-terminal-*` in frontend/src/styles/tokens/colors.css).
 */
const darkTerminal = {
  background: '#010409',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  cursorAccent: '#010409',
  selectionBackground: '#264f78',
  black: '#010409',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39d3de',
  white: '#e6edf3',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e0af3f',
  brightBlue: '#79b8ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#5ae1ea',
  brightWhite: '#ffffff',
};

// The PWA draws its terminal dark in its light theme too (useRemoteTerminal.ts).
export const terminalColors = { light: darkTerminal, dark: darkTerminal };
export type ThemeColors = ColorTokens;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
// --button-radius / --input-radius / --modal-radius 8, --card-radius 12.
export const radius = { sm: 6, md: 8, lg: 12, pill: 999 } as const;

/** System fonts; sizes are the PWA's Tailwind scale (text-xs 12 … text-2xl 24). */
export const typography = {
  largeTitle: { fontSize: 24, lineHeight: 32, fontWeight: '700' }, // text-2xl bold
  title: { fontSize: 20, lineHeight: 28, fontWeight: '600' }, // text-xl semibold
  headline: { fontSize: 16, lineHeight: 24, fontWeight: '600' }, // text-base semibold
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' }, // text-base
  callout: { fontSize: 14, lineHeight: 20, fontWeight: '500' }, // text-sm medium
  subhead: { fontSize: 14, lineHeight: 20, fontWeight: '400' }, // text-sm
  footnote: { fontSize: 12, lineHeight: 16, fontWeight: '400' }, // text-xs
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '600' }, // text-xs section labels
} as const;
export type TypographyVariant = keyof typeof typography;

export const monoFontFamily = Platform.select({ ios: 'Menlo', default: 'monospace' });
