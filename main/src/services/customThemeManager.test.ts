import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkThemeCss } from '../../../shared/types/customTheme';
import type { AppConfig } from '../types/config';
import { CustomThemeManager, type AppearanceStore } from './customThemeManager';

function fakeConfig(initial: Partial<AppConfig>): AppearanceStore & { config: AppConfig } {
  const store = {
    config: { gitRepoPath: '', verbose: false, ...initial } satisfies AppConfig,
    getConfig: () => store.config,
    updateConfigWith: async (update: (current: AppConfig) => Partial<AppConfig>) => {
      store.config = { ...store.config, ...update(store.config) };
      return store.config;
    },
  };
  return store;
}

describe('CustomThemeManager', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pane-custom-theme-'));
    file = path.join(dir, 'custom-theme.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the theme, selects Custom in the system slot of its base family, and merges later colours', async () => {
    const config = fakeConfig({ appearanceMode: 'system', systemLightTheme: 'folio', systemDarkTheme: 'dusk-oled' });
    const manager = new CustomThemeManager(dir, config);
    await manager.set({ base: 'dusk', colors: { '--color-border-primary': '#202020' } }, 'dusk-oled');
    expect(config.config).toMatchObject({ systemLightTheme: 'folio', systemDarkTheme: 'custom' });

    await manager.set({ colors: { '--color-text-muted': 'rgb(1, 2, 3)' }, css: '[data-pane-part="tab"] { border-radius: 8px; }' }, 'dusk');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      base: 'dusk',
      colors: { '--color-border-primary': '#202020', '--color-text-muted': 'rgb(1, 2, 3)' },
      css: '[data-pane-part="tab"] { border-radius: 8px; }',
    });

    await manager.set({ colors: { '--color-border-primary': null } }, 'dusk');
    expect(manager.getState().theme?.colors).toEqual({ '--color-text-muted': 'rgb(1, 2, 3)' });
  });

  it('refuses a bad value, names the nearest token, and leaves the file byte-identical', async () => {
    const config = fakeConfig({ appearanceMode: 'fixed', theme: 'folio' });
    const manager = new CustomThemeManager(dir, config);
    await manager.set({ base: 'folio', colors: { '--color-border-primary': '#dddddd' } }, 'folio');
    const before = readFileSync(file, 'utf8');

    await expect(manager.set({ colors: { '--color-border-primary': 'banana' } }, 'folio')).rejects.toThrow(/banana.*hex.*rgb\(\).*rgba\(\).*Nothing was changed/);
    await expect(manager.set({ colors: { '--color-border-primay': '#000' } }, 'folio')).rejects.toThrow(/Did you mean --color-border-primary\?/);
    await expect(manager.set(JSON.parse('{"base":"nope"}'), 'folio')).rejects.toThrow(/dusk-oled/);
    await expect(manager.set({ css: '@import url(https://example.com/x.css);' }, 'folio')).rejects.toThrow(/@import/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('reset deletes the file and selects the base', async () => {
    const config = fakeConfig({ appearanceMode: 'fixed', theme: 'folio' });
    const manager = new CustomThemeManager(dir, config);
    await manager.set({ base: 'abyss', colors: {} }, 'folio');
    expect(config.config.theme).toBe('custom');

    expect(await manager.reset()).toEqual({ removed: true, base: 'abyss' });
    expect(existsSync(file)).toBe(false);
    expect(config.config.theme).toBe('abyss');
  });

  it('ignores an invalid hand edit with a reason, keeps showing its base, and selects the base when the file is deleted', async () => {
    const config = fakeConfig({ appearanceMode: 'fixed', theme: 'custom' });
    const manager = new CustomThemeManager(dir, config);
    writeFileSync(file, JSON.stringify({ base: 'ember', colors: { '--color-bg-primary': 'nope' } }));
    await manager.reload();
    expect(manager.getState()).toMatchObject({ theme: null, base: 'ember' });
    expect(manager.getState().error).toMatch(/--color-bg-primary is set to "nope"/);
    expect(readFileSync(file, 'utf8')).toContain('nope');

    writeFileSync(file, JSON.stringify({ base: 'ember', colors: { '--color-bg-primary': '#111111' } }));
    await manager.reload();
    expect(manager.getState()).toMatchObject({ base: 'ember', error: null, theme: { colors: { '--color-bg-primary': '#111111' } } });

    rmSync(file);
    await manager.reload();
    expect(config.config.theme).toBe('ember');
  });
});

describe('checkThemeCss (T3 Code\'s rules)', () => {
  it.each([
    ['@import url(https://example.com/x.css);', /@import/],
    ['a { background: url(https://example.com/a.png) }', /url\(https:\/\/example\.com\/a\.png\)/],
    ['a { background: url( "//example.com/a.png" ) }', /url\(/],
    ['a { background-image: image-set("a.png" 1x) }', /image-set/],
    ['@font-face { font-family: x; src: local(x), src(x) }', /src\(\)/],
    ['x'.repeat(20_001), /20,001 characters; the limit is 20,000/],
  ])('refuses %s', (css, reason) => {
    expect(checkThemeCss(css)).toMatch(reason);
  });

  it.each([
    'a { background: url("data:image/png;base64,iVBORw0KGgo=") }',
    "a { mask: url('data:image/svg+xml;utf8,<svg></svg>') }",
    'a { filter: url(#shadow) }',
    // Escapes are the renderer filter's job, as in T3 Code.
    'a { background: u\\72 l(https://example.com/a.png) }',
    '[data-pane-part="tab"] { border-radius: 8px !important; }',
  ])('accepts %s', (css) => {
    expect(checkThemeCss(css)).toBeNull();
  });
});
