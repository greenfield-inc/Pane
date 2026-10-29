import { Alert, Pressable, StyleSheet } from 'react-native';

import { useHostsStore } from '@/auth/hostsStore';
import { useTheme } from '@/theme';
import { withAlpha } from '@/theme/withAlpha';
import { Text } from '@/ui';

/** "Demo" in the home header while the sample host is active; it opens Exit demo. */
export function DemoBadge() {
  const theme = useTheme();
  const demo = useHostsStore(state => state.demo);
  const exitDemo = useHostsStore(state => state.exitDemo);
  // Store screenshots come from a dev build started with EXPO_PUBLIC_PANE_CAPTURE=1; release builds always show it.
  if (!demo || (__DEV__ && process.env.EXPO_PUBLIC_PANE_CAPTURE === '1')) return null;

  const confirmExit = () => {
    Alert.alert('You’re in the demo', 'These computers, Panes and agents are samples on this phone. Nothing connects.', [
      { text: 'Keep Looking', style: 'cancel' },
      { text: 'Exit Demo', style: 'destructive', onPress: exitDemo },
    ]);
  };

  return (
    <Pressable
      testID="demo-badge"
      accessibilityRole="button"
      accessibilityLabel="Demo. Opens Exit demo."
      onPress={confirmExit}
      hitSlop={8}
      style={[styles.badge, { borderColor: theme.colors.accent, backgroundColor: withAlpha(theme.colors.accent, 0.12), borderRadius: theme.radius.sm }]}
    >
      <Text variant="footnote" tone="accent" style={styles.label}>Demo</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // A fixed footprint, so the header never shifts when the demo starts or ends.
  badge: { width: 56, height: 24, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600' },
});
