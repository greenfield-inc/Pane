export type Theme =
  | 'light' | 'light-rounded' | 'dark' | 'oled' | 'dusk' | 'dusk-oled'
  | 'forge' | 'ember' | 'aurora' | 'night-owl' | 'night-owl-oled'
  | 'terracotta' | 'synthwave' | 'acid' | 'tokyo-rain' | 'folio'
  | 'newsprint' | 'walnut' | 'amber-crt' | 'teletype' | 'dot-matrix'
  | 'haar' | 'abyss' | 'understory' | 'colorblind-safe' | 'low-fatigue'
  | 'high-legibility';

/** Canonical map, also inlined into the pre-React bootstrap by the Vite HTML transform. */
export const THEME_CLASSES = {
  light: ['light'],
  'light-rounded': ['light', 'light-rounded'],
  dark: ['dark'],
  oled: ['dark', 'oled'],
  dusk: ['dark', 'dusk'],
  'dusk-oled': ['dark', 'dusk', 'dusk-oled'],
  forge: ['dark', 'forge'],
  ember: ['dark', 'ember'],
  aurora: ['dark', 'aurora'],
  'night-owl': ['dark', 'night-owl'],
  'night-owl-oled': ['dark', 'night-owl', 'night-owl-oled'],
  terracotta: ['dark', 'terracotta'],
  synthwave: ['dark', 'synthwave'],
  acid: ['dark', 'acid'],
  'tokyo-rain': ['dark', 'tokyo-rain'],
  folio: ['light', 'folio'],
  newsprint: ['light', 'newsprint'],
  walnut: ['dark', 'walnut'],
  'amber-crt': ['dark', 'amber-crt'],
  teletype: ['light', 'teletype'],
  'dot-matrix': ['dark', 'dot-matrix'],
  haar: ['light', 'haar'],
  abyss: ['dark', 'abyss'],
  understory: ['dark', 'understory'],
  'colorblind-safe': ['dark', 'colorblind-safe'],
  'low-fatigue': ['dark', 'low-fatigue'],
  'high-legibility': ['light', 'high-legibility'],
} satisfies Record<Theme, string[]>;

export type LightTheme = 'light' | 'light-rounded' | 'folio' | 'newsprint' | 'teletype' | 'haar' | 'high-legibility';
export type DarkTheme = Exclude<Theme, LightTheme>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the canonical type guard used directly at untrusted config and IPC boundaries.
export const isTheme = (value: unknown): value is Theme =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Establishes the primitive representation before the closed-map membership check.
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEME_CLASSES, value);

export const isLightTheme = (theme: Theme): theme is LightTheme =>
  THEME_CLASSES[theme][0] === 'light';

// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: THEME_CLASSES is a closed Record<Theme, ...>, so its runtime keys are Theme values.
export const LIGHT_THEMES: readonly LightTheme[] = (Object.keys(THEME_CLASSES) as Theme[])
  .filter(isLightTheme);
// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: THEME_CLASSES is a closed Record<Theme, ...>, so its runtime keys are Theme values.
export const DARK_THEMES: readonly DarkTheme[] = (Object.keys(THEME_CLASSES) as Theme[])
  .filter((theme): theme is DarkTheme => !isLightTheme(theme));

// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: THEME_CLASSES first elements are authored as the two canonical base classes.
export const themeBase = (theme: Theme): 'light' | 'dark' => THEME_CLASSES[theme][0] as 'light' | 'dark';

export type AppearanceMode = 'system' | 'fixed';

export interface AppearanceConfig {
  appearanceMode: AppearanceMode;
  theme: Theme;
  systemLightTheme: LightTheme;
  systemDarkTheme: DarkTheme;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  appearanceMode: 'system',
  theme: 'light-rounded',
  systemLightTheme: 'light-rounded',
  systemDarkTheme: 'dark',
};

export class AppearanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppearanceValidationError';
  }
}

interface AppearanceInput {
  appearanceMode?: unknown;
  theme?: unknown;
  systemLightTheme?: unknown;
  systemDarkTheme?: unknown;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- normalizeAppearance is the shared parser for disk, argv, cache, and IPC representations.
const asRecord = (raw: unknown): AppearanceInput => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This establishes the object representation before field-by-field domain parsing below.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  // SAFETY: No field is trusted by this assertion; every AppearanceInput property remains unknown and is validated below.
  return raw as AppearanceInput;
};

export interface NormalizedAppearance {
  appearance: AppearanceConfig;
  diagnostics: string[];
  migrated: boolean;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This function is the named parser at all appearance representation boundaries.
export function normalizeAppearance(raw: unknown): NormalizedAppearance {
  const source = asRecord(raw);
  const diagnostics: string[] = [];
  const hasNewAppearanceField = ['appearanceMode', 'systemLightTheme', 'systemDarkTheme']
    .some((field) => Object.prototype.hasOwnProperty.call(source, field));
  const legacyTheme = isTheme(source.theme) ? source.theme : undefined;

  let appearance: AppearanceConfig;
  if (!hasNewAppearanceField && legacyTheme) {
    appearance = {
      appearanceMode: 'fixed',
      theme: legacyTheme,
      systemLightTheme: isLightTheme(legacyTheme) ? legacyTheme : DEFAULT_APPEARANCE.systemLightTheme,
      systemDarkTheme: isLightTheme(legacyTheme) ? DEFAULT_APPEARANCE.systemDarkTheme : legacyTheme,
    };
  } else {
    const appearanceMode = source.appearanceMode === 'system' || source.appearanceMode === 'fixed'
      ? source.appearanceMode
      : DEFAULT_APPEARANCE.appearanceMode;
    const theme = isTheme(source.theme) ? source.theme : DEFAULT_APPEARANCE.theme;
    const systemLightTheme = isTheme(source.systemLightTheme) && isLightTheme(source.systemLightTheme)
      ? source.systemLightTheme
      : DEFAULT_APPEARANCE.systemLightTheme;
    const systemDarkTheme = isTheme(source.systemDarkTheme) && !isLightTheme(source.systemDarkTheme)
      ? source.systemDarkTheme
      : DEFAULT_APPEARANCE.systemDarkTheme;

    if (Object.prototype.hasOwnProperty.call(source, 'appearanceMode') && source.appearanceMode !== 'system' && source.appearanceMode !== 'fixed') {
      diagnostics.push('invalid appearanceMode; restored system');
    }
    if (Object.prototype.hasOwnProperty.call(source, 'theme') && !isTheme(source.theme)) {
      diagnostics.push('invalid theme; restored light-rounded');
    }
    if (Object.prototype.hasOwnProperty.call(source, 'systemLightTheme') && systemLightTheme !== source.systemLightTheme) {
      diagnostics.push('invalid systemLightTheme; restored light-rounded');
    }
    if (Object.prototype.hasOwnProperty.call(source, 'systemDarkTheme') && systemDarkTheme !== source.systemDarkTheme) {
      diagnostics.push('invalid systemDarkTheme; restored dark');
    }

    appearance = { appearanceMode, theme, systemLightTheme, systemDarkTheme };
  }

  // SAFETY: appearance is an AppearanceConfig object created above, so its keys are exactly AppearanceConfig keys.
  const migrated = (Object.keys(appearance) as (keyof AppearanceConfig)[])
    .some((key) => source[key] !== appearance[key]);
  return { appearance, diagnostics, migrated } satisfies NormalizedAppearance;
}

export const resolveAppearanceTheme = (appearance: AppearanceConfig, prefersDark: boolean): Theme =>
  appearance.appearanceMode === 'fixed'
    ? appearance.theme
    : prefersDark ? appearance.systemDarkTheme : appearance.systemLightTheme;

export type AppearanceSnapshot = AppearanceConfig;
export const APPEARANCE_ARG_PREFIX = '--pane-appearance=';

export const encodeAppearanceSnapshotArg = (snapshot: AppearanceSnapshot): string =>
  Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64url');

const decodeBase64UrlUtf8 = (value: string): string => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export function decodeAppearanceSnapshotArg(argv: readonly string[]): AppearanceSnapshot | undefined {
  const argument = argv.find((value) => value.startsWith(APPEARANCE_ARG_PREFIX));
  if (!argument) return undefined;
  try {
    const parsed: unknown = JSON.parse(decodeBase64UrlUtf8(argument.slice(APPEARANCE_ARG_PREFIX.length)));
    const source = asRecord(parsed);
    const { appearance, diagnostics, migrated } = normalizeAppearance(source);
    return migrated || diagnostics.length > 0 ? undefined : appearance;
  } catch {
    return undefined;
  }
}
