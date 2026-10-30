import { StyleSheet, View } from 'react-native';

import { monoFontFamily, useTheme, withAlpha } from '@/theme';
import { Text } from '@/ui';

import type { Machine } from './machines';
import { MachineMark } from './MachineMark';

const LETTERS = 5;

/**
 * A row's machine: its mark and the first five letters of its name on its colour, in one fixed
 * width so a list's badges line up. Screen readers get the full name from the row's own label.
 */
export function MachineBadge({ machine }: { machine: Pick<Machine, 'name' | 'os' | 'slot' | 'state'> }) {
  const theme = useTheme();
  const tint = theme.machine[machine.slot % theme.machine.length];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.badge, { borderRadius: theme.radius.sm, backgroundColor: withAlpha(tint, 0.15) }]}
    >
      <MachineMark os={machine.os} slot={machine.slot} state={machine.state} size={12} />
      <Text variant="footnote" numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.name, { color: tint }]}>
        {Array.from(machine.name).slice(0, LETTERS).join('')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { width: 66, height: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  name: { fontFamily: monoFontFamily, fontWeight: '600' },
});
