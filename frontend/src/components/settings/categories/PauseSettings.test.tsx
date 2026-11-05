import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PauseSettings } from './PauseSettings';
import { parseAutoPauseHours } from '../../../../../shared/types/autoPause';
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
  return renderToStaticMarkup(<PauseSettings persistence={persistence} />);
}

describe('auto-pause threshold field', () => {
  it('accepts whole hours from 1 to 720', () => {
    expect(parseAutoPauseHours('1')).toBe(1);
    expect(parseAutoPauseHours(' 48 ')).toBe(48);
    expect(parseAutoPauseHours('720')).toBe(720);
  });

  it('refuses 0, 721, fractions and empty text', () => {
    expect(parseAutoPauseHours('0')).toBeNull();
    expect(parseAutoPauseHours('721')).toBeNull();
    expect(parseAutoPauseHours('1.5')).toBeNull();
    expect(parseAutoPauseHours('-3')).toBeNull();
    expect(parseAutoPauseHours('')).toBeNull();
  });
});

describe('PauseSettings', () => {
  it('starts with resume-on-open off and auto-pause on at 48 hours on a fresh profile', () => {
    const markup = render({});
    expect(markup).toMatch(/aria-checked="false"[^>]*aria-label="Resume a paused Pane when you open it"|aria-label="Resume a paused Pane when you open it"[^>]*aria-checked="false"/);
    expect(markup).toMatch(/aria-checked="true"[^>]*aria-label="Pause idle Panes"|aria-label="Pause idle Panes"[^>]*aria-checked="true"/);
    expect(markup).toContain('value="48"');
  });

  it('disables the threshold field while auto-pause is off and keeps its value', () => {
    const markup = render({ autoPauseEnabled: false, autoPauseAfterHours: 12 });
    expect(markup).toMatch(/<input[^>]*value="12"[^>]*disabled=""|<input[^>]*disabled=""[^>]*value="12"/);
  });
});
