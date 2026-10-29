import { Minus, Plus } from 'lucide-react';
import { IconButton } from '../../ui/Button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../../ui/Select';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle, SegmentedControl } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import { useTheme } from '../../../contexts/ThemeContext';
import { isTheme, type AppearanceMode, type Theme } from '../../../../../shared/types/appearance';
import { THEME_OPTION_GROUPS } from '../../../utils/themeOptions';

export function AppearanceSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const scale = config.uiScale ?? 1;
  const { appearance, activeSystemSlot, setAppearance } = useTheme();

  const saveScale = (value: number) => persistence.saveConfig('ui-scale', { uiScale: value });
  const saveAppearance = (settingId: 'appearance-mode' | 'theme' | 'system-light-theme' | 'system-dark-theme', patch: Parameters<typeof setAppearance>[0]) => {
    return persistence.runSave(settingId, () => setAppearance(patch));
  };

  const paletteSelect = (label: string, value: Theme, onChange: (theme: Theme) => void) => (
    <div className="w-full min-w-[220px] sm:w-60">
      <Select value={value} onValueChange={(next) => { if (isTheme(next)) onChange(next); }}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {THEME_OPTION_GROUPS.map((group) => (
            <SelectGroup key={group.family}>
              <SelectLabel>{group.family}</SelectLabel>
              {group.options.map((theme) => (
                <SelectItem key={theme.id} value={theme.id} description={theme.description}>{theme.label}</SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <SettingsPage title="Appearance" description="Application-wide interface and sidebar presentation.">
      <SettingsSection title="Interface">
        <SettingRow settingId="appearance-mode" label="Appearance" description="Follow the system or pin one palette." saveState={persistence.saveStates['appearance-mode']}>
          <SegmentedControl
            label="Appearance mode"
            value={appearance.appearanceMode}
            options={[{ id: 'system', label: 'System' }, { id: 'fixed', label: 'Fixed' }] as const}
            onChange={(value: AppearanceMode) => { void saveAppearance('appearance-mode', { appearanceMode: value }); }}
          />
        </SettingRow>
        {appearance.appearanceMode === 'system' ? (
          <>
            <SettingRow
              settingId="system-light-theme"
              label="Light palette"
              description={activeSystemSlot === 'light' ? 'Active now' : 'Saved for when the system switches'}
              saveState={persistence.saveStates['system-light-theme']}
            >
              {paletteSelect('Light palette', appearance.systemLightTheme, (theme) => {
                void saveAppearance('system-light-theme', { systemLightTheme: theme });
              })}
            </SettingRow>
            <SettingRow
              settingId="system-dark-theme"
              label="Dark palette"
              description={activeSystemSlot === 'dark' ? 'Active now' : 'Saved for when the system switches'}
              saveState={persistence.saveStates['system-dark-theme']}
            >
              {paletteSelect('Dark palette', appearance.systemDarkTheme, (theme) => {
                void saveAppearance('system-dark-theme', { systemDarkTheme: theme });
              })}
            </SettingRow>
          </>
        ) : (
          <SettingRow settingId="theme" label="Theme" description="Choose Pane's color and surface treatment." saveState={persistence.saveStates.theme}>
            {paletteSelect('Theme', appearance.theme, (theme) => { void saveAppearance('theme', { theme }); })}
          </SettingRow>
        )}
        <SettingRow
          settingId="high-contrast"
          label="High contrast"
          description="Raise text and terminal contrast to AAA. Helps with CLI output that renders too dim."
          saveState={persistence.saveStates['high-contrast']}
        >
          <ImmediateToggle
            label="High contrast"
            value={config.highContrast === true}
            onSave={(value) => persistence.saveConfig('high-contrast', { highContrast: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="ui-scale"
          label="UI scale"
          description="Adjust all application UI between 0.8x and 1.5x."
          saveState={persistence.saveStates['ui-scale']}
        >
          <div className="flex items-center gap-2">
            <IconButton
              type="button"
              aria-label="Decrease UI scale"
              icon={<Minus className="h-4 w-4" />}
              variant="secondary"
              size="sm"
              disabled={scale <= 0.8}
              onClick={() => void saveScale(Math.max(0.8, Math.round((scale - 0.1) * 10) / 10))}
            />
            <span className="w-12 text-center text-sm font-medium text-text-primary">{scale.toFixed(1)}x</span>
            <IconButton
              type="button"
              aria-label="Increase UI scale"
              icon={<Plus className="h-4 w-4" />}
              variant="secondary"
              size="sm"
              disabled={scale >= 1.5}
              onClick={() => void saveScale(Math.min(1.5, Math.round((scale + 0.1) * 10) / 10))}
            />
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Sidebar">
        <SettingRow
          settingId="sidebar-pane-rows"
          label="Pane row layout"
          description="Choose how pane metadata appears in the left sidebar."
          saveState={persistence.saveStates['sidebar-pane-rows']}
        >
          <SegmentedControl
            label="Sidebar pane row layout"
            value={persistence.preferences.sidebarPaneRowLayout}
            options={[{ id: 'single', label: 'Single row' }, { id: 'two-row', label: 'Two rows' }]}
            onChange={(value) => void persistence.savePreference('sidebarPaneRowLayout', value)}
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
