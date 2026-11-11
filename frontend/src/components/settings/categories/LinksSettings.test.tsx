import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LinksSettings } from './LinksSettings';
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

describe('LinksSettings', () => {
  it('registers custom-links under its own Links category, found by searching for issue trackers', () => {
    const links = SETTINGS_CATEGORIES.find((category) => category.id === 'links');
    expect(links?.label).toBe('Links');
    expect(links?.settingIds).toEqual(['custom-links']);
    expect(links?.aliases).toEqual(expect.arrayContaining(['jira', 'issue', 'regex']));
  });

  it('renders the saved links under a focusable setting id', () => {
    const markup = renderToStaticMarkup(
      <LinksSettings
        persistence={createPersistence({ customLinks: [{
          enabled: true, id: 'jira', label: 'Jira', pattern: 'PROJ-\\d+',
          urlTemplate: 'https://example.atlassian.net/browse/$0',
        }] })}
        onDirtyChange={vi.fn()}
      />,
    );

    expect(markup).toContain(`id="${settingDomId('custom-links')}"`);
    expect(markup).toContain('value="Jira"');
    expect(markup).toContain('value="PROJ-\\d+"');
    expect(markup).toContain('value="https://example.atlassian.net/browse/$0"');
    expect(markup).toContain('Try it');
  });

  it('shows why a saved link does not work', () => {
    const markup = renderToStaticMarkup(
      <LinksSettings
        persistence={createPersistence({ customLinks: [{
          enabled: true, id: 'broken', label: '', pattern: '(', urlTemplate: 'ftp://example.com',
        }] })}
        onDirtyChange={vi.fn()}
      />,
    );

    expect(markup).toContain('Name is required');
    expect(markup).toContain('Not a regular expression');
    expect(markup).toContain('Link must be a web address starting with http:// or https://');
  });

  it('starts with no links and only an Add Link button', () => {
    const markup = renderToStaticMarkup(<LinksSettings persistence={createPersistence()} onDirtyChange={vi.fn()} />);

    expect(markup).toContain('Add Link');
    expect(markup).not.toContain('Try it');
  });
});
