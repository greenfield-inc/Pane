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

const DISABLED_CHOICE = /<button[^>]*role="radio"[^>]*disabled=""/g;

describe('TerminalSettings terminal references switch', () => {
  it('registers terminal-references-enabled under Terminal, found by searching for @', () => {
    const terminal = SETTINGS_CATEGORIES.find((category) => category.id === 'terminal');
    expect(terminal?.settingIds).toContain('terminal-references-enabled');
    expect(terminal?.aliases).toEqual(expect.arrayContaining(['@', 'mention', 'shortcut']));
  });

  it('is on when absent, with paste mode and line count available', () => {
    const markup = renderToStaticMarkup(<TerminalSettings persistence={createPersistence()} systemMonoFonts={[]} />);

    expect(markup).toContain(`id="${settingDomId('terminal-references-enabled')}"`);
    expect(markup).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(markup.match(DISABLED_CHOICE)).toBeNull();
  });

  it('disables paste mode and line count when turned off', () => {
    const markup = renderToStaticMarkup(
      <TerminalSettings persistence={createPersistence({ terminalReferencesEnabled: false })} systemMonoFonts={[]} />,
    );

    expect(markup).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(markup.match(DISABLED_CHOICE)).toHaveLength(6);
  });
});
