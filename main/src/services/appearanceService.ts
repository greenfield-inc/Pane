import { nativeTheme, type BrowserWindow } from 'electron';
import {
  APPEARANCE_ARG_PREFIX,
  encodeAppearanceSnapshotArg,
  resolveAppearanceTheme,
  themeBase,
  type AppearanceConfig,
  type AppearanceSnapshot,
  type ThemeChoice,
} from '../../../shared/types/appearance';
import { paletteForChoice } from '../../../shared/types/customTheme';
import type { Theme } from '../../../shared/types/appearance';

/** Keyed by theme choice: Custom keeps its own colour, since its background can differ from its base's. */
export type StoredBackgroundColors = Partial<Record<ThemeChoice, string>>;
export interface WindowAppearanceOptions {
  additionalArguments: string[];
  backgroundColor: string;
}

let lastOsPrefersDark: boolean | undefined;
let forwardingRegistered = false;

export function resolveOsPrefersDark(): boolean {
  if (lastOsPrefersDark === undefined || nativeTheme.themeSource === 'system') {
    lastOsPrefersDark = nativeTheme.shouldUseDarkColors;
  }
  return lastOsPrefersDark;
}

export function applyNativeThemeSource(appearance: AppearanceConfig, customBase: Theme | null = null): void {
  nativeTheme.themeSource = appearance.appearanceMode === 'system'
    ? 'system'
    : themeBase(paletteForChoice(appearance.theme, customBase));
}

export const buildAppearanceSnapshot = (appearance: AppearanceConfig): AppearanceSnapshot => ({
  appearanceMode: appearance.appearanceMode,
  theme: appearance.theme,
  systemLightTheme: appearance.systemLightTheme,
  systemDarkTheme: appearance.systemDarkTheme,
});

export function resolveWindowBackgroundColor(
  appearance: AppearanceConfig,
  osPrefersDark: boolean,
  storedColors: StoredBackgroundColors,
  customBase: Theme | null = null,
): string {
  const theme = resolveAppearanceTheme(appearance, osPrefersDark);
  return storedColors[theme] ?? (themeBase(paletteForChoice(theme, customBase)) === 'light' ? '#ffffff' : '#0d1117');
}

export function buildWindowAppearanceOptions(
  appearance: AppearanceConfig,
  osPrefersDark: boolean,
  storedColors: StoredBackgroundColors,
  customBase: Theme | null = null,
): WindowAppearanceOptions {
  return {
    additionalArguments: [`${APPEARANCE_ARG_PREFIX}${encodeAppearanceSnapshotArg(buildAppearanceSnapshot(appearance))}`],
    backgroundColor: resolveWindowBackgroundColor(appearance, osPrefersDark, storedColors, customBase),
  };
}

export function ensureNativeThemeForwarding(getWindow: () => BrowserWindow | null): void {
  if (forwardingRegistered) return;
  forwardingRegistered = true;
  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource !== 'system') return;
    lastOsPrefersDark = nativeTheme.shouldUseDarkColors;
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send('window:appearance-native-updated', { prefersDark: lastOsPrefersDark });
    }
  });
}
