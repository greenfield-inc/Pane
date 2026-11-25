import { StyleSheet, View } from 'react-native';

import { PaneLogo } from '@/features/machines/PaneLogo';
import { useTheme } from '@/theme';
import { EmptyState } from '@/ui';

/** The stack's root beside the docked Home, before anything is open. */
export function NothingOpen() {
  const theme = useTheme();
  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.surface }]}>
      <EmptyState
        testID="nothing-open"
        icon={<View style={styles.logo}><PaneLogo size={36} /></View>}
        title="Nothing open"
        message="Tap a Pane or a question on the left, or + for something new."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  logo: { opacity: 0.6 },
});
