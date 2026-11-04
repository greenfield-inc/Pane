import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneralSettings } from './GeneralSettings';
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

// Clicking the row's button and asserting the dialog opens belongs to
// tests/feedback.spec.ts; this suite has no DOM environment to dispatch events in.
describe('GeneralSettings feedback entry', () => {
  it('renders the Send feedback row under a focusable setting id', () => {
    const markup = renderToStaticMarkup(
      <GeneralSettings persistence={createPersistence()} onUpdate={vi.fn()} onSendFeedback={vi.fn()} />,
    );

    // Settings deep links focus a row by this id, so the row must carry it.
    expect(markup).toContain(`id="${settingDomId('send-feedback')}"`);
    expect(markup).toContain('Send Feedback');
    expect(markup).toContain('greenfield-inc/Pane');
  });

  it('registers send-feedback under General so the catalog and the row agree', () => {
    const general = SETTINGS_CATEGORIES.find((category) => category.id === 'general');
    expect(general?.settingIds).toContain('send-feedback');
    expect(general?.aliases).toContain('feedback');
  });
});

describe('GeneralSettings Open HTML files row', () => {
  it('registers html-file-open-mode under General with search aliases', () => {
    const general = SETTINGS_CATEGORIES.find((category) => category.id === 'general');
    expect(general?.settingIds).toContain('html-file-open-mode');
    expect(general?.aliases).toEqual(expect.arrayContaining(['html', 'preview']));
  });

  it('renders the row with Preview in browser selected when the setting is absent', () => {
    const markup = renderToStaticMarkup(
      <GeneralSettings persistence={createPersistence()} onUpdate={vi.fn()} onSendFeedback={vi.fn()} />,
    );

    expect(markup).toContain(`id="${settingDomId('html-file-open-mode')}"`);
    expect(markup).toContain('Open HTML files');
    expect(markup).toContain('What a click on an .html file in Explorer opens.');
    expect(markup).toMatch(/aria-checked="true"[^>]*>Preview in browser</);
    expect(markup).toMatch(/aria-checked="false"[^>]*>Edit source</);
  });

  it('selects Edit source when the config says source', () => {
    const markup = renderToStaticMarkup(
      <GeneralSettings persistence={createPersistence({ htmlFileOpenMode: 'source' })} onUpdate={vi.fn()} onSendFeedback={vi.fn()} />,
    );

    expect(markup).toMatch(/aria-checked="true"[^>]*>Edit source</);
  });
});
