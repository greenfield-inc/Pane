import { Linking, Modal, Pressable, StyleSheet, View } from 'react-native';

import { cheatSheet } from '@shared/controller/bindings';
import { BUTTON_LETTERS_OVERRIDES } from '@shared/controller/profiles';

import { useTheme, withAlpha } from '@/theme';
import { Text } from '@/ui';

import { useControllerState } from './controllerState';

export const CONTROLLERS_DOCS_URL = 'https://github.com/greenfield-inc/Pane/blob/main/docs/CONTROLLERS.md';

/**
 * The controller's buttons over the screen, in the pad's own letters. Hold −
 * to see it; it also opens once on the first press after install and from
 * Settings › Controller, and then any button or a tap closes it.
 */
export function CheatSheet() {
  const theme = useTheme();
  const shown = useControllerState(state => state.cheatSheet);
  const family = useControllerState(state => state.family);
  if (!shown) return null;
  const sheet = cheatSheet(family);
  const close = () => useControllerState.setState({ cheatSheet: null });
  return (
    <Modal transparent animationType="fade" visible onRequestClose={close} supportedOrientations={['portrait', 'landscape']}>
      <Pressable testID="controller-cheat-sheet" accessibilityLabel="Close controller buttons" style={[styles.backdrop, { backgroundColor: withAlpha(theme.colors.background, 0.72) }]} onPress={close}>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text variant="headline">Controller</Text>
          {sheet.note
            ? <Text variant="body" tone="secondary">{sheet.note}</Text>
            : sheet.rows.map(row => (
              <View key={row.label} style={styles.row}>
                <View style={styles.keys}>
                  {row.keys.map(key => (
                    <View key={key} style={[styles.key, { borderColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
                      <Text variant="footnote">{key}</Text>
                    </View>
                  ))}
                </View>
                <Text variant="subhead" style={styles.label}>{row.label}</Text>
              </View>
            ))}
          <Text variant="footnote" tone="secondary">
            {shown === 'held' ? 'Let go of − to close.' : 'Press any button to close.'}
            {' '}
            <Text variant="footnote" tone="accent" onPress={() => void Linking.openURL(CONTROLLERS_DOCS_URL)}>Controller help</Text>
          </Text>
        </View>
      </Pressable>
    </Modal>
  );
}

export const LETTER_LABELS: Record<(typeof BUTTON_LETTERS_OVERRIDES)[number], string> = {
  auto: 'Auto',
  xbox: 'Xbox',
  playstation: 'PlayStation',
  nintendo: 'Nintendo',
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 520, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 20, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  keys: { flexDirection: 'row', gap: 4, width: 132, flexWrap: 'wrap' },
  key: { minWidth: 28, height: 24, paddingHorizontal: 6, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1 },
});
