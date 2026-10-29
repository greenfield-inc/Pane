import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_APPEARANCE,
  isTheme,
  normalizeAppearance,
  resolveAppearanceTheme,
  themeBase,
  type AppearanceConfig,
  type Theme,
} from '../../../shared/types/appearance';
import { useConfigStore } from '../stores/configStore';
import { readAppearanceCache, readLegacyThemeAsFixed, writeAppearanceCache } from '../utils/appearanceCache';
import { isWindowControlsOverlayEnabled, readThemeTokenHex, readTitleBarOverlayColors } from '../utils/titleBarOverlay';
import { THEME_CLASSES, ThemeContext } from './themeContextValue';

const ALL_THEME_CLASSES = [...new Set(Object.values(THEME_CLASSES).flat())];
const mediaQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)');
const initialAppearance = (): AppearanceConfig =>
  window.electronAPI?.appearanceSnapshot
  ?? readAppearanceCache()
  ?? readLegacyThemeAsFixed()
  ?? DEFAULT_APPEARANCE;

function validatePatch(patch: Partial<AppearanceConfig>): void {
  if (patch.theme !== undefined && !isTheme(patch.theme)) throw new Error('theme must be a valid palette');
  if (patch.systemLightTheme !== undefined && !isTheme(patch.systemLightTheme)) {
    throw new Error('systemLightTheme must be a valid palette');
  }
  if (patch.systemDarkTheme !== undefined && !isTheme(patch.systemDarkTheme)) {
    throw new Error('systemDarkTheme must be a valid palette');
  }
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { config, updateConfig } = useConfigStore();
  const [appearance, setAppearanceState] = useState<AppearanceConfig>(initialAppearance);
  const appearanceRef = useRef(appearance);
  const deferConfigAppearanceSyncRef = useRef(false);
  const [prefersDark, setPrefersDark] = useState(() => mediaQuery().matches);
  const [highContrast, setHighContrast] = useState(() => localStorage.getItem('high-contrast') === 'true');
  const resolvedTheme = resolveAppearanceTheme(appearance, prefersDark);
  const activeSystemSlot = appearance.appearanceMode === 'system' ? (prefersDark ? 'dark' : 'light') : undefined;
  const configAppearanceMode = config?.appearanceMode;
  const configTheme = config?.theme;
  const configSystemLightTheme = config?.systemLightTheme;
  const configSystemDarkTheme = config?.systemDarkTheme;
  const hasConfig = config !== null;
  const configAppearance = useMemo(() => hasConfig ? {
    appearanceMode: configAppearanceMode,
    theme: configTheme,
    systemLightTheme: configSystemLightTheme,
    systemDarkTheme: configSystemDarkTheme,
  } : undefined, [hasConfig, configAppearanceMode, configTheme, configSystemLightTheme, configSystemDarkTheme]);

  useEffect(() => { appearanceRef.current = appearance; }, [appearance]);

  useEffect(() => {
    const query = mediaQuery();
    const refresh = (): void => {
      if (appearanceRef.current.appearanceMode === 'system') setPrefersDark(query.matches);
    };
    query.addEventListener('change', refresh);
    const unsubscribe = window.electronAPI?.events.onNativeAppearanceUpdated(({ prefersDark: next }) => {
      if (appearanceRef.current.appearanceMode === 'system') setPrefersDark(next);
    });
    return () => {
      query.removeEventListener('change', refresh);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!configAppearance || deferConfigAppearanceSyncRef.current) return;
    const normalized = normalizeAppearance(configAppearance).appearance;
    setAppearanceState(normalized);
    writeAppearanceCache(normalized);
  }, [configAppearance]);

  useEffect(() => {
    if (config?.highContrast !== undefined) {
      setHighContrast(config.highContrast);
      localStorage.setItem('high-contrast', String(config.highContrast));
    }
  }, [config?.highContrast]);

  // Layout effect (not passive): descendants read the stamped classes and color-scheme via
  // getComputedStyle in their own effects (terminal palette, log ANSI colours), while the
  // passive background-colour and overlay-colour readers need current tokens; a passive
  // effect here would leave them one theme behind.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.classList.remove(...ALL_THEME_CLASSES);
    body.classList.remove(...ALL_THEME_CLASSES);
    root.classList.add(...THEME_CLASSES[resolvedTheme]);
    body.classList.add(...THEME_CLASSES[resolvedTheme]);
    root.style.colorScheme = themeBase(resolvedTheme);
    root.classList.toggle('high-contrast', highContrast);
    body.classList.toggle('high-contrast', highContrast);
  }, [resolvedTheme, highContrast]);

  useEffect(() => {
    const color = readThemeTokenHex('--color-bg-primary');
    if (!color) return;
    void window.electronAPI?.setBackgroundColor({ theme: resolvedTheme, color })
      .then((response) => {
        if (!response.success) {
          console.error('Failed to apply window background colour:', response.error);
        }
      })
      .catch((error) => {
        console.error('Failed to apply window background colour:', error);
      });
  }, [resolvedTheme, highContrast]);

  useEffect(() => {
    if (!isWindowControlsOverlayEnabled()) return;
    const colors = readTitleBarOverlayColors();
    if (!colors) return;
    void window.electronAPI?.setTitleBarOverlay(colors)
      .then((response) => {
        if (!response.success) {
          console.error('Failed to apply title bar overlay colors:', response.error);
        }
      })
      .catch((error) => {
        console.error('Failed to apply title bar overlay colors:', error);
      });
  }, [resolvedTheme, highContrast]);

  const setAppearance = useCallback(async (patch: Partial<AppearanceConfig>): Promise<void> => {
    validatePatch(patch);
    const previous = appearanceRef.current;
    const next = { ...previous, ...patch };
    const switchingToSystem = previous.appearanceMode === 'fixed' && patch.appearanceMode === 'system';
    deferConfigAppearanceSyncRef.current = switchingToSystem;
    if (!switchingToSystem) {
      appearanceRef.current = next;
      setAppearanceState(next);
      writeAppearanceCache(next);
    }
    try {
      await updateConfig(patch);
      if (switchingToSystem) {
        await new Promise<void>((resolve) => {
          const query = mediaQuery();
          const finish = (): void => {
            query.removeEventListener('change', finish);
            unsubscribeNative?.();
            window.clearTimeout(timeout);
            resolve();
          };
          query.addEventListener('change', finish);
          const unsubscribeNative = window.electronAPI?.events.onNativeAppearanceUpdated(finish);
          const timeout = window.setTimeout(finish, 250);
        });
        setPrefersDark(mediaQuery().matches);
        appearanceRef.current = next;
        setAppearanceState(next);
        writeAppearanceCache(next);
        deferConfigAppearanceSyncRef.current = false;
      }
    } catch (error) {
      deferConfigAppearanceSyncRef.current = false;
      appearanceRef.current = previous;
      setAppearanceState(previous);
      writeAppearanceCache(previous);
      throw error;
    }
  }, [updateConfig]);

  const setTheme = useCallback((theme: Theme): Promise<void> => {
    if (appearanceRef.current.appearanceMode === 'fixed') return setAppearance({ theme });
    return setAppearance(prefersDark ? { systemDarkTheme: theme } : { systemLightTheme: theme });
  }, [prefersDark, setAppearance]);

  return (
    <ThemeContext.Provider value={{
      theme: resolvedTheme, appearance, prefersDark, activeSystemSlot,
      setTheme, setAppearance, highContrast,
    }}>
      {children}
    </ThemeContext.Provider>
  );
};
