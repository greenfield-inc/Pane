import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortProbeSettings } from './PortProbeSettings';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { DEFAULT_SETTINGS_PREFERENCES } from '../../../types/settings';
import type { AppConfig } from '../../../types/config';

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
  return renderToStaticMarkup(<PortProbeSettings persistence={persistence} />);
}

describe('PortProbeSettings', () => {
  it('starts with port checks on and no excluded ports on a fresh profile', () => {
    const markup = render({});
    expect(markup).toMatch(/aria-checked="true"[^>]*aria-label="Check which ports serve web pages"|aria-label="Check which ports serve web pages"[^>]*aria-checked="true"/);
    expect(markup).toContain('placeholder="5173, 9000-9100"');
    expect(markup).toContain('value=""');
    expect(markup).not.toContain('role="alert"');
  });

  it('shows the saved list, disabled while port checks are off', () => {
    const markup = render({ portProbesEnabled: false, portProbeExcludedPorts: '5173, 9000-9100' });
    expect(markup).toMatch(/aria-checked="false"[^>]*aria-label="Check which ports serve web pages"|aria-label="Check which ports serve web pages"[^>]*aria-checked="false"/);
    expect(markup).toMatch(/value="5173, 9000-9100"[^>]*disabled=""|disabled=""[^>]*value="5173, 9000-9100"/);
  });

  it('says what is wrong with a hand-edited list it cannot read', () => {
    const markup = render({ portProbeExcludedPorts: '9100-9000' });
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('the range ends before it starts; write 9000-9100');
  });
});
