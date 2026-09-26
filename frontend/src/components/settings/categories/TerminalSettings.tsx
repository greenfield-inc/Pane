import { AT_TERMINAL_LINE_COUNT_PRESETS } from '../../../types/settings';
import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { IconButton } from '../../ui/Button';
import { Input } from '../../ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/Select';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { SegmentedControl } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { PreferredShell, PreferredTerminalPowerMode } from '../../../types/config';

interface AvailableShell {
  id: PreferredShell;
  name: string;
  path: string;
}

interface TerminalSettingsProps {
  persistence: SettingsPersistence;
  platform: string;
  availableShells: AvailableShell[];
  systemMonoFonts: string[];
}

export function TerminalSettings({ persistence, platform, availableShells, systemMonoFonts }: TerminalSettingsProps) {
  const config = persistence.config!;
  const savePreferredShell = (value: string) => {
    // SAFETY: Select options use only PreferredShell identifiers supplied by the backend.
    return persistence.saveConfig('terminal-shell', { preferredShell: value as PreferredShell });
  };
  const [customFont, setCustomFont] = useState(config.terminalFontFamily ?? 'Geist Mono');
  useEffect(() => setCustomFont(config.terminalFontFamily ?? 'Geist Mono'), [config.terminalFontFamily]);
  const fontSize = config.terminalFontSize ?? 14;

  return (
    <SettingsPage title="Terminal" description="Defaults for terminal panels across all projects.">
      <SettingsSection title="Display">
        <SettingRow
          settingId="terminal-font-family"
          label="Font family"
          description="Choose an enumerated monospace font or enter a custom installed font name. Nerd Font symbols remain available."
          saveState={persistence.saveStates['terminal-font-family']}
          align="start"
        >
          <div className="w-full space-y-2 sm:w-72">
            {systemMonoFonts.length > 0 && (
              <Select
                value={config.terminalFontFamily ?? 'Geist Mono'}
                onValueChange={(value) => void persistence.saveConfig('terminal-font-family', { terminalFontFamily: value })}
              >
                <SelectTrigger aria-label="Terminal font family"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {systemMonoFonts.map((font) => <SelectItem key={font} value={font}>{font}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Input
              aria-label="Custom terminal font family"
              value={customFont}
              onChange={(event) => setCustomFont(event.target.value)}
              onBlur={() => {
                const next = customFont.trim();
                if (next && next !== config.terminalFontFamily) {
                  void persistence.saveConfig('terminal-font-family', { terminalFontFamily: next });
                }
              }}
              placeholder="Geist Mono"
              fullWidth
            />
          </div>
        </SettingRow>
        <SettingRow
          settingId="terminal-font-size"
          label="Font size"
          description="Use a terminal font size from 10px to 24px."
          saveState={persistence.saveStates['terminal-font-size']}
        >
          <div className="flex items-center gap-2">
            <IconButton
              type="button"
              aria-label="Decrease terminal font size"
              icon={<Minus className="h-4 w-4" />}
              variant="secondary"
              size="sm"
              disabled={fontSize <= 10}
              onClick={() => void persistence.saveConfig('terminal-font-size', { terminalFontSize: fontSize - 1 })}
            />
            <span className="w-12 text-center text-sm font-medium text-text-primary">{fontSize}px</span>
            <IconButton
              type="button"
              aria-label="Increase terminal font size"
              icon={<Plus className="h-4 w-4" />}
              variant="secondary"
              size="sm"
              disabled={fontSize >= 24}
              onClick={() => void persistence.saveConfig('terminal-font-size', { terminalFontSize: fontSize + 1 })}
            />
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Performance">
        <SettingRow
          settingId="terminal-power-mode"
          label="Terminal power mode"
          description="Performance keeps mounted terminals live. Battery Saver suspends inactive rendering and prefers low-power GPU behavior where available. Restart Pane after changing this setting."
          saveState={persistence.saveStates['terminal-power-mode']}
        >
          <SegmentedControl<PreferredTerminalPowerMode>
            label="Terminal power mode"
            value={config.terminalPowerMode ?? 'performance'}
            options={[{ id: 'performance', label: 'Performance' }, { id: 'batterySaver', label: 'Battery Saver' }]}
            onChange={(value) => void persistence.saveConfig('terminal-power-mode', { terminalPowerMode: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Terminal references" description="Defaults used when @ references scrollback from another terminal in the same pane.">
        <SettingRow
          settingId="terminal-reference-paste-mode"
          label="Paste mode"
          description="Paste clean scrollback text directly or write it to a file and insert a reference."
          saveState={persistence.saveStates['terminal-reference-paste-mode']}
        >
          <SegmentedControl
            label="Default terminal reference paste mode"
            value={persistence.preferences.atTerminalPasteMode}
            options={[{ id: 'raw', label: 'Raw paste' }, { id: 'embed', label: 'Embed file' }]}
            onChange={(value) => void persistence.savePreference('atTerminalPasteMode', value)}
          />
        </SettingRow>
        <SettingRow
          settingId="terminal-reference-line-count"
          label="Line count"
          description="Default number of scrollback lines to include."
          saveState={persistence.saveStates['terminal-reference-line-count']}
        >
          <SegmentedControl
            label="Default terminal reference line count"
            value={persistence.preferences.atTerminalLineCount}
            columns={4}
            options={AT_TERMINAL_LINE_COUNT_PRESETS.map((value) => ({ id: value, label: value === -1 ? 'All' : String(value) }))}
            onChange={(value) => void persistence.savePreference('atTerminalLineCount', value)}
          />
        </SettingRow>
      </SettingsSection>

      {platform === 'win32' && (
        <SettingsSection title="Windows shell">
          <SettingRow
            settingId="terminal-shell"
            label="Default shell"
            description="Choose the shell used by new terminal panels on Windows."
            saveState={persistence.saveStates['terminal-shell']}
          >
            <div className="w-full min-w-[220px] sm:w-72">
              <Select
                value={config.preferredShell ?? 'auto'}
                onValueChange={(value) => void savePreferredShell(value)}
              >
                <SelectTrigger aria-label="Default Windows terminal shell"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect (Git Bash preferred)</SelectItem>
                  {availableShells.map((shell) => <SelectItem key={shell.id} value={shell.id}>{shell.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </SettingRow>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
