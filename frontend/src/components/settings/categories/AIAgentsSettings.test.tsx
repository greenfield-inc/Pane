import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AIAgentsSettings } from './AIAgentsSettings';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { AppConfig } from '../../../types/config';
import { DEFAULT_SETTINGS_PREFERENCES } from '../../../types/settings';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ');

function render(config: AppConfig): string {
  const persistence: SettingsPersistence = {
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
  return text(renderToStaticMarkup(<AIAgentsSettings persistence={persistence} onDirtyChange={() => undefined} />));
}

describe('Save Agent Farm telemetry on this computer', () => {
  it('is off by default and says an AGENT_FARM_TELEMETRY variable overrides it, and how to stop that (review F-4)', () => {
    const page = render({});
    expect(page).toContain('Save Agent Farm telemetry on this computer');
    expect(page).toContain('Off by default');
    expect(page).toMatch(/AGENT_FARM_TELEMETRY.*overrides this switch/);
    expect(page).toMatch(/remove it .*to let this switch decide/);
  });
});
