import { Platform } from 'react-native';

/**
 * Colors mirror the desktop app's default dark and light themes
 * (frontend/src/styles/tokens/colors.css) so the phone reads as the same product.
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
};

type ColorTokens = { [Key in keyof typeof dark]: string };

const light: ColorTokens = {
  background: '#f6f8fa',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfacePressed: '#eaeef2',
  border: 'rgba(31, 35, 40, 0.15)',
  text: '#1f2328',
  textSecondary: '#5d656e',
  textMuted: '#656d76',
  accent: '#2563eb',
  accentText: '#1d4ed8',
  onAccent: '#ffffff',
  success: '#1a7f37',
  warning: '#9a6700',
  danger: '#cf222e',
  info: '#2563eb',
  neutral: '#6e7781',
  skeleton: '#eaeef2',
  scrim: 'rgba(31, 35, 40, 0.4)',
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

type TerminalColors = { [Key in keyof typeof darkTerminal]: string };

const lightTerminal: TerminalColors = {
  background: '#f9fcff',
  foreground: '#0d141a',
  cursor: '#1f6dc6',
  cursorAccent: '#f9fcff',
  selectionBackground: '#1f6dc640',
  black: '#f9fcff',
  red: '#ff6860',
  green: '#0f8920',
  yellow: '#985f00',
  blue: '#1f6dc6',
  magenta: '#7e4ec1',
  cyan: '#006c77',
  white: '#0d141a',
  brightBlack: '#838b96',
  brightRed: '#d14d44',
  brightGreen: '#007102',
  brightYellow: '#7c4b00',
  brightBlue: '#19589f',
  brightMagenta: '#633990',
  brightCyan: '#00565f',
  brightWhite: '#000000',
};

export const terminalColors = { light: lightTerminal, dark: darkTerminal };
export type ThemeColors = ColorTokens;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

/** System fonts only; sizes follow the iOS text styles. */
export const typography = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400' },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
} as const;
export type TypographyVariant = keyof typeof typography;

export const monoFontFamily = Platform.select({ ios: 'Menlo', default: 'monospace' });
