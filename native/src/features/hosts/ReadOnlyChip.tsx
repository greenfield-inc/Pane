import { StyleSheet, View } from 'react-native';

import { DEVICE_ACCESS_LABELS } from '@shared/types/accessLevel';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/** "Read only": this phone watches the computer and can't change anything there. `color` fits it on a filled pill. */
export function ReadOnlyChip({ color }: { color?: string }) {
  const { colors, radius } = useTheme();
  const ink = color ?? colors.textSecondary;
  return (
    <View testID="read-only-chip" style={[styles.chip, { borderRadius: radius.sm, borderColor: color ?? colors.border }]}>
      <Text variant="footnote" numberOfLines={1} maxFontSizeMultiplier={1.2} style={[styles.label, { color: ink }]}>{DEVICE_ACCESS_LABELS.read}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // One footprint everywhere, so a header never shifts with its text.
  chip: { width: 74, height: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600' },
});
