/** Settings › Shortcuts › Game controller: the button letters override and the cheat sheet. */
import type { ButtonLettersOverride } from '../../../shared/controller/profiles';
import { SettingsSection } from '../components/ui/SettingsSection';
import { SettingRow } from '../components/settings/SettingRow';
import { SegmentedControl } from '../components/settings/SettingsControls';
import { CONTROLLER_DOCS_URL } from './ControllerCheatSheet';
import { setButtonLetters, useControllerStore } from './controllerStore';

const LETTER_OPTIONS = [
  { id: 'auto', label: 'Auto', description: 'Read from the pad' },
  { id: 'xbox', label: 'Xbox', description: 'A at the bottom' },
  { id: 'playstation', label: 'PlayStation', description: '✕ at the bottom' },
  { id: 'nintendo', label: 'Nintendo', description: 'A on the right' },
] as const satisfies ReadonlyArray<{ id: ButtonLettersOverride; label: string; description: string }>;

export function ControllerSettingsSection() {
  const letters = useControllerStore(state => state.buttonLetters);
  const deviceName = useControllerStore(state => state.device?.name);
  return (
    <SettingsSection
      title="Game controller"
      description="Drive Pane with an Xbox, PlayStation or Switch-style pad while its window is in front."
    >
      <SettingRow
        settingId="controller"
        label="Button letters"
        description={`A picks and B goes back, wherever the pad prints them. Pick a family if the pad pretends to be another brand.${deviceName ? ` Connected: ${deviceName}.` : ''}`}
      >
        <SegmentedControl label="Button letters" columns={4} value={letters} options={LETTER_OPTIONS} onChange={setButtonLetters} />
      </SettingRow>
      <div className="flex gap-4">
        <button
          type="button"
          className="text-sm font-medium text-interactive underline underline-offset-4 hover:text-interactive-hover"
          onClick={() => useControllerStore.setState({ cheatSheet: 'open' })}
        >
          Show controller buttons
        </button>
        <a className="text-sm font-medium text-interactive underline underline-offset-4 hover:text-interactive-hover" href={CONTROLLER_DOCS_URL} target="_blank" rel="noreferrer">
          Controller guide
        </a>
      </div>
    </SettingsSection>
  );
}
