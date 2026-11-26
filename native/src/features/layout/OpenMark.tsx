import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme, withAlpha } from '@/theme';

/** A row of the docked Home for what is open beside it: tinted, with the accent along its leading edge. */
export function OpenMark({ open, children }: { open: boolean; children: ReactNode }) {
  const theme = useTheme();
  if (!open) return children;
  return (
    <View testID="home-row-open">
      {children}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[StyleSheet.absoluteFill, styles.mark, { backgroundColor: withAlpha(theme.colors.accent, 0.14), borderLeftColor: theme.colors.accent }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { borderLeftWidth: 3 },
});
