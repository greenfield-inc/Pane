import { Linking } from 'react-native';

import { BUTTON_LETTERS_OVERRIDES } from '@shared/controller/profiles';

import { CONTROLLERS_DOCS_URL, LETTER_LABELS } from '@/features/controller/CheatSheet';
import { useControllerState } from '@/features/controller/controllerState';
import { Focusable } from '@/features/controller/Focusable';
import { Icon, ListRow, ListSection, Screen } from '@/ui';
import { useTheme } from '@/theme';

/**
 * Settings › Controller, kept on this phone: which printed letters the pad
 * wears (Auto reads them from the pad; a clone that claims another brand
 * needs its own), and the cheat sheet on demand.
 */
export default function ControllerSettingsScreen() {
  const theme = useTheme();
  const letters = useControllerState(state => state.letters);
  const setLetters = useControllerState(state => state.setLetters);
  const openSheet = () => useControllerState.setState({ cheatSheet: 'open' });
  const openDocs = () => void Linking.openURL(CONTROLLERS_DOCS_URL);
  return (
    <Screen scroll grouped testID="controller-settings">
      <ListSection title="Button letters" footer="Auto reads the letters from the pad. Pick its brand when A and B come out swapped.">
        {BUTTON_LETTERS_OVERRIDES.map(option => (
          <Focusable key={option} onActivate={() => setLetters(option)} preferred={option === letters}>
            <ListRow
              testID={`controller-letters-${option}`}
              title={LETTER_LABELS[option]}
              trailing={option === letters ? <Icon ios="checkmark" android="check" size={16} color={theme.colors.accentText} /> : undefined}
              onPress={() => setLetters(option)}
            />
          </Focusable>
        ))}
      </ListSection>
      <ListSection>
        <Focusable onActivate={openSheet}>
          <ListRow testID="controller-show-cheat-sheet" title="Show cheat sheet" onPress={openSheet} />
        </Focusable>
        <Focusable onActivate={openDocs}>
          <ListRow testID="controller-help" title="Controller help" trailing="chevron" onPress={openDocs} />
        </Focusable>
      </ListSection>
    </Screen>
  );
}
