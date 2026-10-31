import { Platform } from 'react-native';

/**
 * Light comes from the Remote Pane PWA's fixed `light-rounded` theme, with values resolved from
 * frontend/src/styles/tokens/colors.css (tmp/assets/mobile/reference/tokens.json).
 * The PWA has no dark mode; dark uses the desktop's default dark theme. Home and Settings now
 * follow the phone's own design rather than the PWA's.
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
  dangerSoft: 'rgba(248, 81, 73, 0.12)',
  info: '#58a6ff',
  neutral: '#6e7681',
  skeleton: '#161b22',
  scrim: 'rgba(1, 4, 9, 0.6)',
  selected: 'rgba(31, 111, 235, 0.15)',
  // Grouped screens (Settings): the page behind the cards, and the cards on it.
  grouped: '#010409',
  card: '#161b22',
  cardBorder: 'transparent',
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
  dangerSoft: '#ffebe9',
  info: '#2563eb',
  neutral: '#6b7280',
  skeleton: '#eaeef2',
  scrim: 'rgba(31, 35, 40, 0.4)',
  selected: '#dbeafe', // --color-surface-navigation-selected
  grouped: '#f2f4f7',
  card: '#ffffff',
  cardBorder: 'rgba(31, 35, 40, 0.12)',
};

export const colors = { light, dark };

/** The Pane app icon's own colors (main/assets/icon-source.svg), the same in both themes. */
export const brandColors = { tile: '#080a0c', silver: ['#ffffff', '#f5f7f9', '#d7dce1'] } as const;

/**
 * Machine colors by slot (shared/utils/machineColor.ts): violet, cyan, pink, lime, orange, rose. Clear of the agent
 * status dots and the danger red; the first four stay apart for red-green and blue-yellow color
 * blindness. Dark uses lighter tints of the same hues.
 */
export const machineColors = {
  // The desktop's light-theme machine colours (--color-machine-* in frontend/src/styles/tokens/colors.css).
  light: ['#7c3aed', '#0e7490', '#db2777', '#4d7c0f', '#c2410c', '#e11d48'],
  dark: ['#c4b5fd', '#67e8f9', '#f9a8d4', '#bef264', '#fdba74', '#fb7185'],
} as const;

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

/**
 * Code colors by highlight.js scope, from GitHub's light and dark themes (github.css,
 * github-dark.css). Scopes not listed draw in the text color.
 */
export const syntaxColors = {
  light: {
    keyword: '#cf222e', 'meta keyword': '#cf222e', doctag: '#cf222e', 'template-tag': '#cf222e',
    title: '#8250df', 'title.function': '#8250df',
    type: '#953800', built_in: '#953800', 'title.class': '#953800', variable: '#953800', params: '#1f2328',
    attr: '#0550ae', attribute: '#0550ae', literal: '#0550ae', meta: '#0550ae', number: '#0550ae', operator: '#0550ae', selector: '#0550ae', property: '#0550ae',
    string: '#0a3069', regexp: '#0a3069', symbol: '#0a3069',
    comment: '#6e7781', quote: '#6e7781',
    name: '#116329', 'selector-tag': '#116329', tag: '#116329',
    addition: '#116329', deletion: '#82071e', section: '#0550ae', bullet: '#953800',
  },
  dark: {
    keyword: '#ff7b72', 'meta keyword': '#ff7b72', doctag: '#ff7b72', 'template-tag': '#ff7b72',
    title: '#d2a8ff', 'title.function': '#d2a8ff',
    type: '#ffa657', built_in: '#ffa657', 'title.class': '#ffa657', variable: '#ffa657', params: '#c9d1d9',
    attr: '#79c0ff', attribute: '#79c0ff', literal: '#79c0ff', meta: '#79c0ff', number: '#79c0ff', operator: '#79c0ff', selector: '#79c0ff', property: '#79c0ff',
    string: '#a5d6ff', regexp: '#a5d6ff', symbol: '#a5d6ff',
    comment: '#8b949e', quote: '#8b949e',
    name: '#7ee787', 'selector-tag': '#7ee787', tag: '#7ee787',
    addition: '#aff5b4', deletion: '#ffdcd7', section: '#1f6feb', bullet: '#f2cc60',
  },
} as const satisfies Record<'light' | 'dark', Record<string, string>>;

// The PWA draws its terminal dark in its light theme too (useRemoteTerminal.ts).
export const terminalColors = { light: darkTerminal, dark: darkTerminal };
export type ThemeColors = ColorTokens;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
// --button-radius / --input-radius / --modal-radius 8, --card-radius 12.
export const radius = { sm: 6, md: 8, lg: 12, card: 14, hero: 20, pill: 999 } as const;

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
  // Grouped lists (Settings), on the iOS Settings scale.
  rowTitle: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  rowValue: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  rowDetail: { fontSize: 13, lineHeight: 18, fontWeight: '400' }, // row subtitles, section footers
  sectionLabel: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
} as const;
export type TypographyVariant = keyof typeof typography;

export const monoFontFamily = Platform.select({ ios: 'Menlo', default: 'monospace' });
