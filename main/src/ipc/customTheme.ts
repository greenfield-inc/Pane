import { BrowserWindow, type IpcMain } from 'electron';
import { PaneError } from '../../../shared/paneError';
import { normalizeAppearance, resolveAppearanceTheme, THEME_CLASSES, type Theme } from '../../../shared/types/appearance';
import {
  CUSTOM_THEME_CSS_LIMIT,
  CUSTOM_THEME_ID,
  isThemeChoice,
  paletteForChoice,
  THEME_COLOR_TOKENS,
  type CustomThemeState,
} from '../../../shared/types/customTheme';
import { PANE_PARTS, THEME_GUIDE } from '../../../shared/types/themeGuide';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { resolveOsPrefersDark } from '../services/appearanceService';
import type { ConfigManager } from '../services/configManager';
import type { CustomThemeSetRequest } from '../services/customThemeManager';

const CUSTOM_THEME_UPDATED_CHANNEL = 'custom-theme:updated';
const TOKEN_READ_TIMEOUT_MS = 2_000;

const setRequestSchema = boundary.object({
  theme: boundary.optional(boundary.string),
  base: boundary.optional(boundary.string),
  name: boundary.optional(boundary.string),
  colors: boundary.optional(boundary.jsonObject),
  css: boundary.optional(boundary.string),
});

/** Each colour token's value in the main window now, or {} when no window can answer. */
async function readTokenValues(window: BrowserWindow | null): Promise<Record<string, string>> {
  if (!window || window.isDestroyed()) return {};
  const script = `(() => { const style = getComputedStyle(document.documentElement); return Object.fromEntries(${JSON.stringify(THEME_COLOR_TOKENS)}.map((token) => [token, style.getPropertyValue(token).trim()])); })()`;
  let timer: NodeJS.Timeout | undefined;
  try {
    const values: unknown = await Promise.race([
      window.webContents.executeJavaScript(script, false),
      new Promise((resolve) => { timer = setTimeout(() => resolve({}), TOKEN_READ_TIMEOUT_MS); }),
    ]);
    return decodeBoundary(values, boundary.record(boundary.string));
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `runpane theme read | set | reset` (read and set are MCP tools too), Settings'
 * Reset, and the push that restyles every Pane window when the theme changes.
 */
export function registerCustomThemeHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  commandRegistry: PaneCommandRegistry,
  configManager: ConfigManager,
  getMainWindow: () => BrowserWindow | null,
): void {
  const customTheme = configManager.customTheme;
  customTheme.on('changed', (state: CustomThemeState) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(CUSTOM_THEME_UPDATED_CHANNEL, state);
    }
  });

  ipcMain.handle('custom-theme:get', () => ({ success: true, data: customTheme.getState() }));
  ipcMain.handle('custom-theme:reset', async () => {
    try {
      await customTheme.reset();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const appearance = () => normalizeAppearance(configManager.getConfig()).appearance;
  const onScreen = (): Theme => paletteForChoice(resolveAppearanceTheme(appearance(), resolveOsPrefersDark()), customTheme.getState().base);

  commandRegistry.register('runpane:theme:read', async () => {
    const state = customTheme.getState();
    const values = await readTokenValues(getMainWindow());
    return {
      ok: true,
      selected: appearance(),
      showing: resolveAppearanceTheme(appearance(), resolveOsPrefersDark()),
      showingPalette: onScreen(),
      custom: state.theme,
      ignoredBecause: state.error,
      file: customTheme.filePath,
      bases: Object.keys(THEME_CLASSES),
      tokens: THEME_COLOR_TOKENS.map((name) => (values[name] ? { name, value: values[name] } : { name })),
      parts: PANE_PARTS.map((part) => `[data-pane-part="${part}"]`),
      cssLimit: CUSTOM_THEME_CSS_LIMIT,
      guide: THEME_GUIDE,
    };
  });

  commandRegistry.register('runpane:theme:set', async (request: PaneCommandValue) => {
    const { theme, base, name, colors, css } = decodeBoundary(request ?? {}, setRequestSchema);
    if (theme !== undefined) {
      if (base !== undefined || name !== undefined || colors !== undefined || css !== undefined) {
        throw new PaneError('THEME_INVALID', '--theme selects a theme on its own; it does not combine with --base, --name, --colors or --css. Nothing was changed.', 'Run `runpane theme set --theme <id>` to switch, or leave out --theme to change the Custom theme.');
      }
      if (!isThemeChoice(theme)) {
        throw new PaneError('THEME_INVALID', `${theme} is not a Pane theme. Nothing was changed.`, `Use custom or one of: ${Object.keys(THEME_CLASSES).join(', ')}.`);
      }
      await customTheme.select(theme);
      return { ok: true, selected: theme, custom: customTheme.getState().theme };
    }
    if (base !== undefined && !(base in THEME_CLASSES)) {
      throw new PaneError('THEME_INVALID', `base ${base} is not a Pane theme. Nothing was changed.`, `Use one of: ${Object.keys(THEME_CLASSES).join(', ')}.`);
    }
    for (const [token, value] of Object.entries(colors ?? {})) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON colour values are strings, or null to remove one.
      if (value !== null && typeof value !== 'string') {
        throw new PaneError('THEME_INVALID', `${token} must be a colour string, or null to remove the override. Nothing was changed.`, 'Pass --colors as a JSON object such as {"--color-border-primary": "#30363d"}.');
      }
    }
    // SAFETY: base was checked against THEME_CLASSES and every colour value is a string or null just above.
    const setRequest = { base, name, colors, css } as CustomThemeSetRequest;
    const saved = await customTheme.set(setRequest, onScreen());
    return { ok: true, selected: CUSTOM_THEME_ID, custom: saved, file: customTheme.filePath };
  });

  commandRegistry.register('runpane:theme:reset', async () => {
    const { removed, base } = await customTheme.reset();
    return { ok: true, removed, selected: base, file: customTheme.filePath };
  });
}
