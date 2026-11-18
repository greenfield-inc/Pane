import { DEFAULT_BROWSER_SETTINGS } from '../../../../../shared/types/browser';
import { SettingsSection } from '../../ui/SettingsSection';
import { Toggle } from '../../ui/Toggle';
import { SettingRow, SettingsPage } from '../SettingRow';
import type { SettingsPersistence } from '../useSettingsPersistence';

/** Settings > Browser: the switch for the agent browser tools (docs/BROWSER_AGENTS.md). */
export function BrowserSettings({ persistence }: { persistence: SettingsPersistence }) {
  const browser = { ...DEFAULT_BROWSER_SETTINGS, ...persistence.config?.browser };
  return (
    <SettingsPage title="Browser" description="Pane's browser tabs, and what agents may do in them.">
      <SettingsSection title="Agents">
        <SettingRow
          settingId="browser-agent-tools"
          label="Agent browser tools"
          description="Let agents in a Pane use that Pane's browser tabs. They act with your sign-ins, can run scripts on pages, and can upload files from their worktree."
          saveState={persistence.saveStates['browser-agent-tools']}
        >
          <Toggle checked={browser.agentTools} onChange={(agentTools) => { void persistence.saveConfig('browser-agent-tools', { browser: { ...browser, agentTools } }); }} />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
