import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/**
 * "+2": what waits on you that the phone hasn't shown you yet (`freshCounts`), or "New" on a row
 * Needs you is showing for the first time. Nothing at zero.
 */
export function NewBadge({ count, label, style, testID }: { count?: number; label?: string; style?: StyleProp<ViewStyle>; testID?: string }) {
  const theme = useTheme();
  const text = label ?? (count && count > 0 ? `+${count > 99 ? '99' : count}` : null);
  if (!text) return null;
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={label ?? `${count} new`}
      style={[styles.pill, { backgroundColor: theme.colors.accent }, style]}
    >
      <Text variant="caption" numberOfLines={1} maxFontSizeMultiplier={1.2} style={[styles.text, { color: theme.colors.onAccent }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { minWidth: 22, height: 18, borderRadius: 9, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  text: { fontSize: 11, lineHeight: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
