import { useEffect, useState } from 'react';
import { Button } from '../../ui/Button';
import { Textarea } from '../../ui/Input';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';

interface AdvancedSettingsProps {
  persistence: SettingsPersistence;
  platform: string;
  onDirtyChange: (dirty: boolean) => void;
}

export function AdvancedSettings({ persistence, platform, onDirtyChange }: AdvancedSettingsProps) {
  const config = persistence.config!;
  const persistedPaths = config.additionalPaths ?? [];
  const persistedPathsKey = JSON.stringify(persistedPaths);
  const [pathsText, setPathsText] = useState(persistedPaths.join('\n'));
  const dirty = pathsText !== persistedPaths.join('\n');

  // SAFETY: App-owned storage writes this value through the matching typed serializer.
  useEffect(() => setPathsText((JSON.parse(persistedPathsKey) as string[]).join('\n')), [persistedPathsKey]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const applyPaths = async () => {
    const paths = [...new Set(pathsText.split('\n').map((path) => path.trim()).filter(Boolean))];
    const saved = await persistence.saveConfig('additional-paths', { additionalPaths: paths });
    if (saved) onDirtyChange(false);
  };

  return (
    <SettingsPage title="Advanced" description="Application diagnostics, terminal backend isolation, and process environment.">
      <SettingsSection title="Experimental">
        <SettingRow settingId="session-progress" label="Session progress view (Experimental)"
          description="Show an agent-maintained HTML progress page beside each Session. Turning this off stops the view and removes the maintenance instruction. Running agents may need their next context reload."
          saveState={persistence.saveStates['session-progress']}>
          <ImmediateToggle label="Session progress view (Experimental)" value={config.experimentalSessionProgress !== false}
            onSave={value => persistence.saveConfig('session-progress', { experimentalSessionProgress: value })} />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Diagnostics">
        <SettingRow
          settingId="verbose-logging"
          label="Verbose logging"
          description="Write detailed pane creation and agent execution logs for troubleshooting."
          saveState={persistence.saveStates['verbose-logging']}
        >
          <ImmediateToggle
            label="Verbose logging"
            value={config.verbose === true}
            onSave={(value) => persistence.saveConfig('verbose-logging', { verbose: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="developer-mode"
          label="Developer mode"
          description="Show raw agent JSON messages in an additional pane tab."
          saveState={persistence.saveStates['developer-mode']}
        >
          <ImmediateToggle
            label="Developer mode"
            value={config.devMode === true}
            onSave={(value) => persistence.saveConfig('developer-mode', { devMode: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Terminal backend">
        <SettingRow
          settingId="pty-host"
          label="Use isolated PTY host"
          description="Run terminal processes in a separate utility process for crash isolation. This is experimental and especially useful for Claude Code on macOS. Restart Pane after changing it."
          saveState={persistence.saveStates['pty-host']}
        >
          <ImmediateToggle
            label="Use isolated PTY host"
            value={config.usePtyHost === true}
            onSave={(value) => persistence.saveConfig('pty-host', { usePtyHost: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Environment">
        <SettingRow
          settingId="additional-paths"
          label="Additional PATH directories"
          description="Add one directory per line to the PATH used by all Pane tools. Restart Pane for all processes to pick up changes."
          saveState={persistence.saveStates['additional-paths']}
          align="start"
        >
          <div className="w-full space-y-2 sm:w-[430px]">
            <Textarea
              aria-label="Additional PATH directories"
              value={pathsText}
              onChange={(event) => setPathsText(event.target.value)}
              rows={5}
              placeholder={platform === 'win32' ? 'C:\\tools\\bin\n%USERPROFILE%\\bin' : '/opt/homebrew/bin\n~/.local/bin'}
              fullWidth
            />
            <div className="flex justify-end">
              <Button type="button" size="sm" disabled={!dirty} onClick={applyPaths}>Apply</Button>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
