import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/** The thin bar under a read-only tab: what it shows on the left, where it changes on the right. */
export function TabFooter({ left, right }: { left: string; right: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>{left}</Text>
      <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>{right}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1 },
});
