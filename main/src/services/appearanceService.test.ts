import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeTheme, type BrowserWindow } from 'electron';
import { APPEARANCE_ARG_PREFIX, DEFAULT_APPEARANCE } from '../../../shared/types/appearance';
import {
  applyNativeThemeSource,
  buildAppearanceSnapshot,
  buildWindowAppearanceOptions,
  ensureNativeThemeForwarding,
  resolveOsPrefersDark,
  resolveWindowBackgroundColor,
} from './appearanceService';

describe('appearance service', () => {
  beforeEach(() => {
    nativeTheme.themeSource = 'system';
    nativeTheme.shouldUseDarkColors = false;
    vi.clearAllMocks();
  });

  it('applies system and fixed native sources', () => {
    expect(resolveOsPrefersDark()).toBe(false);
    nativeTheme.shouldUseDarkColors = true;
    applyNativeThemeSource(DEFAULT_APPEARANCE);
    expect(nativeTheme.themeSource).toBe('system');
    applyNativeThemeSource({ ...DEFAULT_APPEARANCE, appearanceMode: 'fixed', theme: 'abyss' });
    expect(nativeTheme.themeSource).toBe('dark');
    expect(resolveOsPrefersDark()).toBe(false);
  });

  it('builds an exact snapshot and pre-window options', () => {
    expect(buildAppearanceSnapshot(DEFAULT_APPEARANCE)).toEqual(DEFAULT_APPEARANCE);
    const options = buildWindowAppearanceOptions(DEFAULT_APPEARANCE, true, { 'dusk-oled': '#112233' });
    expect(options.additionalArguments[0]).toMatch(new RegExp(`^${APPEARANCE_ARG_PREFIX}`));
    expect(options.backgroundColor).toBe('#112233');
  });

  it('uses stored colors or a base fallback for the resolved palette', () => {
    expect(resolveWindowBackgroundColor(DEFAULT_APPEARANCE, false, {})).toBe('#ffffff');
    expect(resolveWindowBackgroundColor(DEFAULT_APPEARANCE, true, {})).toBe('#0d1117');
    expect(resolveWindowBackgroundColor({ ...DEFAULT_APPEARANCE, appearanceMode: 'fixed', theme: 'folio' }, true, { folio: '#fafafa' })).toBe('#fafafa');
  });

  it('registers native forwarding once and forwards only System updates', () => {
    const send = vi.fn();
    // SAFETY: This fixture supplies the only BrowserWindow members exercised by the forwarding callback.
    const getWindow = vi.fn(() => ({
      isDestroyed: () => false,
      webContents: { send },
    }) as BrowserWindow);
    ensureNativeThemeForwarding(getWindow);
    ensureNativeThemeForwarding(getWindow);
    expect(nativeTheme.on).toHaveBeenCalledTimes(1);
    expect(nativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));
    // SAFETY: The preceding assertion proves the captured `updated` registration contains a function listener.
    const listener = vi.mocked(nativeTheme.on).mock.calls[0]?.[1] as (() => void) | undefined;
    expect(listener).toBeTypeOf('function');

    nativeTheme.themeSource = 'dark';
    nativeTheme.shouldUseDarkColors = true;
    listener?.();
    expect(nativeTheme.themeSource).toBe('dark');
    expect(send).not.toHaveBeenCalled();

    nativeTheme.themeSource = 'system';
    listener?.();
    expect(nativeTheme.themeSource).toBe('system');
    expect(send).toHaveBeenCalledWith('window:appearance-native-updated', { prefersDark: true });
  });
});
