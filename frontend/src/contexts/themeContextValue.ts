import { createContext } from 'react';
import type { AppearanceConfig, Theme, ThemeChoice } from '../../../shared/types/appearance';
import type { CustomThemeState } from '../../../shared/types/customTheme';

export { THEME_CLASSES, isLightTheme } from '../../../shared/types/appearance';
export type { Theme } from '../../../shared/types/appearance';

export interface ThemeContextType {
  /** The palette on screen; the Custom theme shows as its base. */
  theme: Theme;
  /** What is selected for the slot on screen: a palette, or custom. */
  themeChoice: ThemeChoice;
  /** Changes whenever the colours on screen do, including edits to the Custom theme; effects that copy colours depend on it. */
  themeRevision: string;
  customTheme: CustomThemeState;
  appearance: AppearanceConfig;
  prefersDark: boolean;
  activeSystemSlot: 'light' | 'dark' | undefined;
  setTheme: (theme: ThemeChoice) => Promise<void>;
  setAppearance: (patch: Partial<AppearanceConfig>) => Promise<void>;
  // Read-only here: the Appearance settings toggle writes it through
  // persistence.saveConfig, and it flows back via the config sync effect.
  highContrast: boolean;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
