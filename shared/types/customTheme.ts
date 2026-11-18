import {
  CUSTOM_THEME_ID,
  DEFAULT_APPEARANCE,
  isTheme,
  THEME_CLASSES,
  type AppearanceConfig,
  type Theme,
  type ThemeChoice,
} from './appearance';

export { CUSTOM_THEME_ID, isThemeChoice, type ThemeChoice } from './appearance';
import type { JsonValue } from '../validation/boundaryDecoder';

/**
 * The Custom theme: one file, custom-theme.json in Pane's data folder, that an
 * agent writes through `runpane theme set`. It names a base theme, overrides
 * colour tokens, and may carry CSS. main checks it on every write and load; the
 * renderer filters the parsed CSS again (frontend/src/utils/customThemeCss.ts).
 */

export const CUSTOM_THEME_FILE = 'custom-theme.json';
export const CUSTOM_THEME_CSS_LIMIT = 20_000;
export const CUSTOM_THEME_FILE_LIMIT = 32 * 1024;
/** Added beside the base theme's classes while Custom shows; the colour rule keys on it. */
export const CUSTOM_THEME_CLASS = 'pane-custom-theme';

export interface CustomTheme {
  base: Theme;
  name?: string;
  colors: Record<string, string>;
  css?: string;
}

/** What main knows about the file: the theme when it loaded, or why it was ignored. */
export interface CustomThemeState {
  theme: CustomTheme | null;
  /** The base to show while Custom is selected: the file's, or the last one loaded. */
  base: Theme | null;
  error: string | null;
}

/** The palette a choice shows: Custom shows its base, or the default palette when there is none. */
export function paletteForChoice(choice: ThemeChoice, customBase: Theme | null | undefined, fallback: Theme = DEFAULT_APPEARANCE.theme): Theme {
  if (choice !== CUSTOM_THEME_ID) return choice;
  return customBase ?? fallback;
}

/** The classes stamped on <html> and <body>: the palette's, plus the Custom class while Custom shows. */
export function themeChoiceClasses(choice: ThemeChoice, customBase: Theme | null | undefined, fallback?: Theme): string[] {
  const palette = paletteForChoice(choice, customBase, fallback);
  return choice === CUSTOM_THEME_ID && customBase ? [...THEME_CLASSES[palette], CUSTOM_THEME_CLASS] : [...THEME_CLASSES[palette]];
}

export const selectsCustomTheme = (appearance: AppearanceConfig): boolean =>
  appearance.theme === CUSTOM_THEME_ID
  || appearance.systemLightTheme === CUSTOM_THEME_ID
  || appearance.systemDarkTheme === CUSTOM_THEME_ID;

/** Every colour token a Custom theme may set. themeTokens.test.ts keeps it equal to colors.css. */
export const THEME_COLOR_TOKENS = [
  '--color-bg-primary',
  '--color-bg-secondary',
  '--color-bg-tertiary',
  '--color-bg-hover',
  '--color-bg-active',
  '--color-surface-primary',
  '--color-surface-secondary',
  '--color-surface-tertiary',
  '--color-surface-hover',
  '--color-surface-selected',
  '--color-status-success-on-tint',
  '--color-status-warning-on-tint',
  '--color-status-error-on-tint',
  '--color-status-info-on-tint',
  '--color-interactive-on-tint',
  '--color-bg-chrome',
  '--color-bg-editor',
  '--color-text-primary',
  '--color-text-secondary',
  '--color-text-tertiary',
  '--color-text-muted',
  '--color-text-disabled',
  '--color-border-primary',
  '--color-border-secondary',
  '--color-border-hover',
  '--color-border-focus',
  '--color-interactive-primary',
  '--color-interactive-hover',
  '--color-interactive-active',
  '--color-interactive-text',
  '--color-focus-ring',
  '--color-text-interactive-on-dark',
  '--color-text-interactive-on-dark-hover',
  '--color-text-interactive-on-dark-active',
  '--color-text-interactive-on-dark-focus',
  '--color-surface-interactive',
  '--color-surface-interactive-hover',
  '--color-interactive-surface',
  '--color-interactive-surface-hover',
  '--color-border-interactive-subtle',
  '--color-border-interactive',
  '--color-interactive-border',
  '--color-interactive-border-hover',
  '--color-text-interactive-muted',
  '--color-focus-ring-subtle',
  '--color-status-success',
  '--color-status-success-hover',
  '--color-status-warning',
  '--color-status-warning-hover',
  '--color-status-error',
  '--color-status-error-hover',
  '--color-status-info',
  '--color-status-neutral',
  '--color-autopilot',
  '--color-autopilot-subtle',
  '--color-autopilot-border',
  '--color-autopilot-on-tint',
  // Snoozed to-dos (round 9).
  '--color-status-snoozed',
  '--color-status-snoozed-subtle',
  '--color-status-snoozed-border',
  '--color-status-snoozed-on-tint',
  // A phone's bezel and dark screen in a device tab.
  '--color-device-bezel',
  '--color-device-screen',
  '--color-device-screen-text',
  '--color-text-on-primary',
  '--color-text-on-secondary',
  '--color-text-on-tertiary',
  '--color-text-on-surface',
  '--color-text-on-interactive',
  '--color-text-on-status-success',
  '--color-text-on-status-warning',
  '--color-text-on-status-error',
  '--color-text-on-status-info',
  '--color-text-on-navigation',
  '--color-button-primary-bg',
  '--color-button-primary-hover',
  '--color-button-primary-text',
  '--color-button-secondary-bg',
  '--color-button-secondary-hover',
  '--color-button-secondary-text',
  '--color-button-ghost-hover',
  '--color-button-ghost-text',
  '--color-card-bg',
  '--color-card-border',
  '--color-card-nested-bg',
  '--color-input-bg',
  '--color-input-border',
  '--color-input-focus',
  '--color-input-text',
  '--color-input-placeholder',
  '--color-modal-overlay',
  '--color-modal-bg',
  '--color-surface-navigation',
  '--color-surface-navigation-hover',
  '--color-surface-navigation-active',
  '--color-surface-navigation-selected',
  '--color-surface-navigation-selected-hover',
  '--color-text-navigation-primary',
  '--color-text-navigation-secondary',
  '--color-text-navigation-muted',
  '--color-text-navigation-selected',
  '--color-text-navigation-hover',
  '--color-text-navigation-section',
  '--color-text-navigation-brand',
  '--color-border-navigation',
  '--color-divider-navigation',
  '--color-divider-navigation-subtle',
  '--color-scrollbar-track',
  '--color-scrollbar-thumb',
  '--color-scrollbar-thumb-hover',
  '--color-terminal-bg',
  '--color-terminal-fg',
  '--color-terminal-cursor',
  '--color-terminal-black',
  '--color-terminal-red',
  '--color-terminal-green',
  '--color-terminal-yellow',
  '--color-terminal-blue',
  '--color-terminal-magenta',
  '--color-terminal-cyan',
  '--color-terminal-white',
  '--color-terminal-bright-black',
  '--color-terminal-bright-red',
  '--color-terminal-bright-green',
  '--color-terminal-bright-yellow',
  '--color-terminal-bright-blue',
  '--color-terminal-bright-magenta',
  '--color-terminal-bright-cyan',
  '--color-terminal-bright-white',
  '--color-machine-1',
  '--color-machine-2',
  '--color-machine-3',
  '--color-machine-4',
  '--color-machine-5',
  '--color-machine-6',
  '--color-border-tertiary',
  '--color-interactive',
  '--color-terminal-selection-bg',
  '--color-diff-add-bg',
  '--color-diff-del-bg',
  '--color-diff-add-gutter',
  '--color-diff-del-gutter',
  '--color-diff-add-highlight',
  '--color-diff-del-highlight',
  '--color-diff-hunk-bg',
  '--color-diff-hunk-gutter',
] as const;

const TOKEN_SET: ReadonlySet<string> = new Set(THEME_COLOR_TOKENS);
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = String.raw`\s*-?(?:\d+\.?\d*|\.\d+)%?\s*`;
const RGB_COLOR = new RegExp(`^rgba?\\((?:${NUMBER},${NUMBER},${NUMBER}(?:,${NUMBER})?|${NUMBER}\\s${NUMBER}\\s${NUMBER}(?:/${NUMBER})?)\\)$`, 'i');

export const isThemeColorValue = (value: string): boolean => HEX_COLOR.test(value.trim()) || RGB_COLOR.test(value.trim());

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

export function nearestThemeToken(name: string): string {
  let best: string = THEME_COLOR_TOKENS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const token of THEME_COLOR_TOKENS) {
    const distance = editDistance(name, token);
    if (distance < bestDistance) {
      best = token;
      bestDistance = distance;
    }
  }
  return best;
}

/** Why a colour override is refused, or null when it is accepted. */
export function checkThemeColor(token: string, value: string): string | null {
  if (!TOKEN_SET.has(token)) {
    return `${token} is not a Pane colour token. Did you mean ${nearestThemeToken(token)}? \`runpane theme read\` lists them all.`;
  }
  if (!isThemeColorValue(value)) {
    return `${token} is set to "${value}", which is not a colour Pane accepts. Use a hex colour (#1f6feb), rgb() or rgba().`;
  }
  return null;
}

/** The end of a url( argument: past its closing quote, if quoted, then its ')'. */
function urlArgument(css: string, start: number): string {
  let index = start;
  while (/\s/.test(css[index] ?? '')) index++;
  const quote = css[index] === '"' || css[index] === "'" ? css[index] : '';
  if (quote) {
    const close = css.indexOf(quote, index + 1);
    return css.slice(index + 1, close === -1 ? css.length : close);
  }
  const close = css.indexOf(')', index);
  return css.slice(index, close === -1 ? css.length : close).trim();
}

/**
 * The text check on custom CSS (T3 Code's rules): nothing in it may fetch a
 * file. It refuses @import, image-set(), src() and any url() whose address is
 * not data: or #id. Escapes are left to the renderer's parsed-rule filter.
 */
export function checkThemeCss(css: string): string | null {
  if (css.length > CUSTOM_THEME_CSS_LIMIT) {
    return `The CSS is ${css.length.toLocaleString('en-US')} characters; the limit is ${CUSTOM_THEME_CSS_LIMIT.toLocaleString('en-US')}.`;
  }
  const lower = css.toLowerCase();
  if (lower.includes('@import')) return 'The CSS uses @import, which would load a file. Put the rules in the CSS itself.';
  if (/image-set\s*\(/.test(lower)) return 'The CSS uses image-set(), which can load a file. Use url("data:...") instead.';
  if (/(^|[^a-z0-9_-])src\s*\(/.test(lower)) return 'The CSS uses src(), which loads a file. Remote fonts and images are not supported.';
  const urls = /(^|[^a-z0-9_-])url\s*\(/g;
  for (let match = urls.exec(lower); match; match = urls.exec(lower)) {
    const address = urlArgument(lower, match.index + match[0].length).trim();
    if (!address.startsWith('data:') && !address.startsWith('#')) {
      return `The CSS has url(${address.slice(0, 60)}), which would load a file. Only data: and #id addresses are allowed.`;
    }
  }
  return null;
}

export type CustomThemeCheck = { ok: true; theme: CustomTheme } | { ok: false; reason: string; base: Theme | null };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The parser for the file on disk and the set request.
const isRecord = (value: unknown): value is { readonly [key: string]: JsonValue | undefined } =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establishes the JSON object representation before field checks.
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a Custom theme is acceptable, and why not when it isn't. The command and the file load both use it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The named parser for custom-theme.json and set requests.
export function checkCustomTheme(raw: unknown): CustomThemeCheck {
  if (!isRecord(raw)) return { ok: false, reason: 'The theme must be a JSON object with base, colors and css.', base: null };
  const base = isTheme(raw.base) ? raw.base : null;
  const refuse = (reason: string): CustomThemeCheck => ({ ok: false, reason, base });
  if (!base) {
    return refuse(`base ${JSON.stringify(raw.base ?? null)} is not a Pane theme. Use one of: ${Object.keys(THEME_CLASSES).join(', ')}.`);
  }
  const unknownField = Object.keys(raw).find((key) => !['base', 'name', 'colors', 'css'].includes(key));
  if (unknownField) return refuse(`"${unknownField}" is not a Custom theme field. The fields are base, name, colors and css.`);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Optional JSON string field.
  if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 60)) return refuse('name must be text of 60 characters or fewer.');
  const colors: Record<string, string> = {};
  if (raw.colors !== undefined) {
    if (!isRecord(raw.colors)) return refuse('colors must be an object of token to colour, such as {"--color-border-primary": "#30363d"}.');
    for (const [token, value] of Object.entries(raw.colors)) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON value check before the colour check.
      const reason = checkThemeColor(token, typeof value === 'string' ? value : JSON.stringify(value));
      if (reason) return refuse(reason);
      // SAFETY: checkThemeColor accepted it, so it is a string.
      colors[token] = (value as string).trim();
    }
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Optional JSON string field.
  if (raw.css !== undefined && typeof raw.css !== 'string') return refuse('css must be text.');
  const css = raw.css ?? '';
  const cssReason = checkThemeCss(css);
  if (cssReason) return refuse(cssReason);
  const theme: CustomTheme = { base, colors };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrowed above.
  if (typeof raw.name === 'string' && raw.name.trim()) theme.name = raw.name.trim();
  if (css.trim()) theme.css = css;
  return { ok: true, theme };
}

/** The colour overrides as one rule: above the base palette (0,2,1 beats :root.<palette>), below :root.high-contrast.<palette> (0,3,0). */
export function customThemeColorRule(colors: Record<string, string>): string {
  const declarations = Object.entries(colors)
    .filter(([token, value]) => TOKEN_SET.has(token) && isThemeColorValue(value))
    .map(([token, value]) => `  ${token}: ${value};`);
  return declarations.length > 0 ? `html:root.${CUSTOM_THEME_CLASS} {\n${declarations.join('\n')}\n}` : '';
}
