import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdvancedSettings } from './AdvancedSettings';
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
  return text(renderToStaticMarkup(<AdvancedSettings persistence={persistence} platform="darwin" onDirtyChange={() => undefined} />));
}

describe('the Profiles switch', () => {
  // Review F-8: login Bash and Git Bash cache the shim's path, so the next command alone may not switch.
  it('tells you an open login Bash or Git Bash terminal needs hash -r or a new terminal', () => {
    const page = render({ sessionProfilesEnabled: false });
    expect(page).toContain('in a login Bash or Git Bash terminal that already ran agent-farm, run hash -r or open a new terminal');
  });
});
