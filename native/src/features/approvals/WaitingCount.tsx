import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/**
 * A Session row's amber count of the approvals waiting from it (D-38). The box keeps its size
 * at zero, when nothing shows, so the row doesn't reflow as approvals come and go.
 */
export function WaitingCount({ count, testID }: { count: number; testID?: string }) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={styles.box}
      accessible={count > 0}
      accessibilityLabel={count > 0 ? `${count} waiting` : undefined}
    >
      {count > 0 ? (
        <Text variant="caption" numberOfLines={1} style={[styles.count, { color: theme.colors.warning }]}>
          {count > 99 ? '99+' : String(count)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 28, height: 18, alignItems: 'flex-end', justifyContent: 'center' },
  count: { fontWeight: '700', fontVariant: ['tabular-nums'] },
});
