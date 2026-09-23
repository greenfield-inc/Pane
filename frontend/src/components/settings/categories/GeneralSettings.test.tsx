import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneralSettings } from './GeneralSettings';
import { SETTINGS_CATEGORIES, settingDomId } from '../catalog';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { DEFAULT_SETTINGS_PREFERENCES } from '../../../types/settings';

function createPersistence(): SettingsPersistence {
  return {
    config: {},
    isLoading: false,
    configError: null,
    fetchConfig: () => Promise.resolve({}),
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
