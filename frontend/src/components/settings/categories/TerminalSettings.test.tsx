import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalSettings } from './TerminalSettings';
import { SETTINGS_CATEGORIES, settingDomId } from '../catalog';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { DEFAULT_SETTINGS_PREFERENCES } from '../../../types/settings';
import type { AppConfig } from '../../../types/config';

function createPersistence(config: AppConfig = {}): SettingsPersistence {
  return {
    config,
    isLoading: false,
    configError: null,
    fetchConfig: () => Promise.resolve(config),
    saveConfig: () => Promise.resolve(true),
    runSave: () => Promise.resolve(true),
    saveStates: {},
    reportSaveError: () => undefined,
    preferences: DEFAULT_SETTINGS_PREFERENCES,
    preferencesLoading: false,
    savePreference: () => Promise.resolve(true),
  };
}

const REFERENCE_GROUPS = ['Default terminal reference paste mode', 'Default terminal reference line count'];

function radios(markup: string, groupLabel: string) {
  const group = markup.match(new RegExp(`role="radiogroup" aria-label="${groupLabel}"[^>]*>(.*?)</div>`))?.[1] ?? '';
  const buttons = group.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
  return { count: buttons.length, disabled: buttons.filter((button) => button.includes('disabled=""')).length };
}

describe('TerminalSettings terminal references switch', () => {
  it('registers terminal-references-enabled under Terminal', () => {
    const terminal = SETTINGS_CATEGORIES.find((category) => category.id === 'terminal');
    expect(terminal?.settingIds).toContain('terminal-references-enabled');
  });

  it('is on when absent, with paste mode and line count available', () => {
    const markup = renderToStaticMarkup(<TerminalSettings persistence={createPersistence()} systemMonoFonts={[]} />);

    expect(markup).toContain(`id="${settingDomId('terminal-references-enabled')}"`);
    expect(markup).toMatch(/role="switch"[^>]*aria-checked="true"/);
    for (const label of REFERENCE_GROUPS) {
      expect(radios(markup, label)).toMatchObject({ disabled: 0 });
      expect(radios(markup, label).count).toBeGreaterThan(0);
    }
  });

  it('disables paste mode and line count when turned off', () => {
    const markup = renderToStaticMarkup(
      <TerminalSettings persistence={createPersistence({ terminalReferencesEnabled: false })} systemMonoFonts={[]} />,
    );

    expect(markup).toMatch(/role="switch"[^>]*aria-checked="false"/);
    for (const label of REFERENCE_GROUPS) {
      const { count, disabled } = radios(markup, label);
      expect(count).toBeGreaterThan(0);
      expect(disabled).toBe(count);
    }
    const powerMode = radios(markup, 'Terminal power mode');
    expect(powerMode.count).toBeGreaterThan(0);
    expect(powerMode.disabled).toBe(0);
  });
});
