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

function toggle(markup: string, label: string): string {
  const match = new RegExp(`<button[^>]*role="switch"[^>]*aria-label="${label}"[^>]*>`).exec(markup);
  if (!match) {
    throw new Error(`${label} switch not rendered`);
  }
  return match[0];
}

const copyOnSelectSwitch = (markup: string) => toggle(markup, 'Copy on select');
const referencesSwitch = (markup: string) => toggle(markup, 'Reference terminals with @');

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

const REFERENCE_GROUPS = ['Default terminal reference paste mode', 'Default terminal reference line count'];

function radios(markup: string, groupLabel: string) {
  const group = markup.match(new RegExp(`role="radiogroup" aria-label="${groupLabel}"[^>]*>(.*?)</div>`))?.[1] ?? '';
  const buttons = group.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
  return { count: buttons.length, disabled: buttons.filter((button) => button.includes('disabled=""')).length };
}

describe('TerminalSettings terminal references switch', () => {
  it('registers terminal-references-enabled under Terminal', () => {
    const terminal = SETTINGS_CATEGORIES.find((category) => category.id === 'terminal');
    expect(terminal?.settingIds).toContain('terminal-references-enabled');
  });

  it('is on when absent, with paste mode and line count available', () => {
    const markup = renderToStaticMarkup(<TerminalSettings persistence={createPersistence()} systemMonoFonts={[]} />);

    expect(markup).toContain(`id="${settingDomId('terminal-references-enabled')}"`);
    expect(referencesSwitch(markup)).toContain('aria-checked="true"');
    for (const label of REFERENCE_GROUPS) {
      expect(radios(markup, label)).toMatchObject({ disabled: 0 });
      expect(radios(markup, label).count).toBeGreaterThan(0);
    }
  });

  it('disables paste mode and line count when turned off', () => {
    const markup = renderToStaticMarkup(
      <TerminalSettings persistence={createPersistence({ terminalReferencesEnabled: false })} systemMonoFonts={[]} />,
    );

    expect(referencesSwitch(markup)).toContain('aria-checked="false"');
    for (const label of REFERENCE_GROUPS) {
      const { count, disabled } = radios(markup, label);
      expect(count).toBeGreaterThan(0);
      expect(disabled).toBe(count);
    }
    const powerMode = radios(markup, 'Terminal power mode');
    expect(powerMode.count).toBeGreaterThan(0);
    expect(powerMode.disabled).toBe(0);
  });
});
