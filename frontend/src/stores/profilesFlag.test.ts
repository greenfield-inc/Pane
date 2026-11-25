import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../types/config';
import { SETTINGS_CATEGORIES, matchSettingsCategories } from '../components/settings/catalog';
import { isProfilesEnabled } from './configStore';

/** Profiles behind one switch, off by default (T-63). */

describe('the Profiles switch', () => {
  it('is off unless the settings turn it on', () => {
    expect(isProfilesEnabled(null)).toBe(false);
    expect(isProfilesEnabled({})).toBe(false);
    expect(isProfilesEnabled({ sessionProfilesEnabled: false })).toBe(false);
    expect(isProfilesEnabled({ sessionProfilesEnabled: true })).toBe(true);
  });

  it('stays off on a Pane where the removed Profiles engine was turned on (#1687 kept its key saved)', () => {
    const legacy: AppConfig = JSON.parse('{"profilesEnabled":true,"profiles":{"enabled":["greenfield"]}}');
    expect(isProfilesEnabled(legacy)).toBe(false);
  });

  it('lives under Settings › Advanced, found by its name', () => {
    expect(SETTINGS_CATEGORIES.find(category => category.id === 'advanced')?.settingIds).toContain('profiles');
    expect(matchSettingsCategories(SETTINGS_CATEGORIES, 'profiles').map(category => category.id)).toContain('advanced');
    expect(matchSettingsCategories(SETTINGS_CATEGORIES, 'agent farm').map(category => category.id)).toContain('advanced');
  });
});
