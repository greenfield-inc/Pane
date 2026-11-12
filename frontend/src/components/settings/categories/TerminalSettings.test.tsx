import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TerminalSettings } from './TerminalSettings';
import { SETTINGS_CATEGORIES, settingDomId } from '../catalog';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { DEFAULT_SETTINGS_PREFERENCES } from '../../../types/settings';
import type { AppConfig } from '../../../types/config';
import { createDefaultRemoteDaemonConfig } from '../../../../../shared/types/remoteDaemon';

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

function render(config: AppConfig = {}): string {
  return renderToStaticMarkup(<TerminalSettings persistence={createPersistence(config)} systemMonoFonts={[]} />);
}

function copyOnSelectSwitch(markup: string): string {
  const match = /<button[^>]*role="switch"[^>]*aria-label="Copy on select"[^>]*>/.exec(markup);
  if (!match) {
    throw new Error('Copy on select switch not rendered');
  }
  return match[0];
}

describe('TerminalSettings Copy on select', () => {
  it('registers terminal-copy-on-select under Terminal, found by searching for copy', () => {
    const terminal = SETTINGS_CATEGORIES.find((category) => category.id === 'terminal');
    expect(terminal?.settingIds).toContain('terminal-copy-on-select');
    expect(terminal?.aliases).toEqual(expect.arrayContaining(['copy', 'selection', 'clipboard']));
  });

  it('is off when absent', () => {
    const markup = render();

    expect(markup).toContain(`id="${settingDomId('terminal-copy-on-select')}"`);
    expect(copyOnSelectSwitch(markup)).toContain('aria-checked="false"');
  });

  it('shows the saved choice', () => {
    expect(copyOnSelectSwitch(render({ terminalCopyOnSelect: true }))).toContain('aria-checked="true"');
  });

  it('is on and locked while connected to a remote Pane', () => {
    const remoteDaemon = createDefaultRemoteDaemonConfig();
    const markup = render({ remoteDaemon: { ...remoteDaemon, client: { ...remoteDaemon.client, mode: 'remote' } } });
    const toggle = copyOnSelectSwitch(markup);

    expect(toggle).toContain('aria-checked="true"');
    expect(toggle).toContain('disabled=""');
    expect(markup).toContain('Always on while connected to a remote Pane');
  });
});
