import { describe, expect, it } from 'vitest';
import { matchSettingsCategories, SETTINGS_CATEGORIES } from './catalog';

describe('matchSettingsCategories', () => {
  it('finds Machine health by disk, storage, memory or leak', () => {
    for (const query of ['disk', 'storage', 'memory', 'leak']) {
      expect(matchSettingsCategories(SETTINGS_CATEGORIES, query).map(category => category.label)).toContain('Machine health');
    }
  });

  it('keeps every category for an empty query and none for nonsense', () => {
    expect(matchSettingsCategories(SETTINGS_CATEGORIES, '  ')).toHaveLength(SETTINGS_CATEGORIES.length);
    expect(matchSettingsCategories(SETTINGS_CATEGORIES, 'zzqx')).toEqual([]);
  });
});
