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
  // Profiles off (T-63): AI & Agents is as on main, with no telemetry switch.
  it('is absent while Profiles is off, even on a Pane the removed Profiles engine turned on', () => {
    // SAFETY: AppConfig no longer declares the removed engine's key; this is the config.json such a Pane still has.
    const legacy: AppConfig = JSON.parse('{"profilesEnabled":true}');
    for (const config of [{}, { sessionProfilesEnabled: false, agentFarmTelemetry: true }, legacy]) {
      const page = render(config);
      expect(page).toContain('Install Pane skill for agents');
      expect(page).not.toContain('Agent Farm telemetry');
    }
  });

  it('is off by default and says an AGENT_FARM_TELEMETRY variable overrides it, and how to stop that (review F-4)', () => {
    const page = render({ sessionProfilesEnabled: true });
    expect(page).toContain('Save Agent Farm telemetry on this computer');
    expect(page).toContain('Off by default');
    expect(page).toMatch(/AGENT_FARM_TELEMETRY.*overrides this switch/);
    expect(page).toMatch(/remove it .*to let this switch decide/);
  });
});
