import { StyleSheet, View, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/** A shortcut's desktop hotkey letter, drawn as a small key cap. */
export function KeyBadge({ letter, style }: { letter: string; style?: ViewStyle }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.badge, { borderColor: colors.border }, style]}>
      <Text variant="footnote" tone="muted" style={styles.text}>{letter.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  text: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
});
