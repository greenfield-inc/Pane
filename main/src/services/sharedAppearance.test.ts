import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_ARG_PREFIX,
  DEFAULT_APPEARANCE,
  decodeAppearanceSnapshotArg,
  encodeAppearanceSnapshotArg,
  normalizeAppearance,
  resolveAppearanceTheme,
} from '../../../shared/types/appearance';

describe('shared appearance model', () => {
  it('defaults a new install to System with Folio and Dusk (OLED), and migrates legacy light and dark themes', () => {
    expect(DEFAULT_APPEARANCE).toEqual({ appearanceMode: 'system', theme: 'folio', systemLightTheme: 'folio', systemDarkTheme: 'dusk-oled' });
    expect(normalizeAppearance({}).appearance).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ theme: 'forge' }).appearance).toEqual({
      appearanceMode: 'fixed', theme: 'forge', systemLightTheme: 'folio', systemDarkTheme: 'forge',
    });
    expect(normalizeAppearance({ theme: 'newsprint' }).appearance).toEqual({
      appearanceMode: 'fixed', theme: 'newsprint', systemLightTheme: 'newsprint', systemDarkTheme: 'dusk-oled',
    });
  });

  it('keeps a saved choice, including one that matches the old defaults', () => {
    const saved = { appearanceMode: 'system', theme: 'light-rounded', systemLightTheme: 'light-rounded', systemDarkTheme: 'dark' } as const;
    expect(normalizeAppearance(saved)).toEqual({ appearance: saved, diagnostics: [], migrated: false });
  });

  it('accepts any theme in either System slot', () => {
    const crossed = normalizeAppearance({ appearanceMode: 'system', theme: 'folio', systemLightTheme: 'abyss', systemDarkTheme: 'haar' });
    expect(crossed.appearance).toMatchObject({ systemLightTheme: 'abyss', systemDarkTheme: 'haar' });
    expect(crossed.diagnostics).toEqual([]);
  });

  it('repairs invalid fields independently and records diagnostics', () => {
    const light = normalizeAppearance({ appearanceMode: 'system', systemLightTheme: 'unknown', systemDarkTheme: 'forge' });
    expect(light.appearance.systemLightTheme).toBe('folio');
    expect(light.appearance.systemDarkTheme).toBe('forge');
    expect(light.diagnostics).toContain('invalid systemLightTheme; restored folio');

    const dark = normalizeAppearance({ appearanceMode: 'fixed', theme: 'unknown', systemLightTheme: 'folio', systemDarkTheme: 7 });
    expect(dark.appearance).toEqual({ appearanceMode: 'fixed', theme: 'folio', systemLightTheme: 'folio', systemDarkTheme: 'dusk-oled' });
    expect(dark.diagnostics).toEqual(['invalid theme; restored folio', 'invalid systemDarkTheme; restored dusk-oled']);
  });

  it('resolves fixed and both system slots', () => {
    const appearance = { ...DEFAULT_APPEARANCE, systemLightTheme: 'folio' as const, systemDarkTheme: 'forge' as const };
    expect(resolveAppearanceTheme(appearance, false)).toBe('folio');
    expect(resolveAppearanceTheme(appearance, true)).toBe('forge');
    expect(resolveAppearanceTheme({ ...appearance, appearanceMode: 'fixed', theme: 'abyss' }, false)).toBe('abyss');
  });

  it('round-trips a snapshot and rejects missing or corrupt arguments', () => {
    const encoded = encodeAppearanceSnapshotArg(DEFAULT_APPEARANCE);
    expect(decodeAppearanceSnapshotArg([`${APPEARANCE_ARG_PREFIX}${encoded}`])).toEqual(DEFAULT_APPEARANCE);
    expect(decodeAppearanceSnapshotArg([])).toBeUndefined();
    expect(decodeAppearanceSnapshotArg([`${APPEARANCE_ARG_PREFIX}garbage`])).toBeUndefined();
  });
});
