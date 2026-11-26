import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import { NewBadge } from './NewBadge';

/**
 * A Session row's amber count of what waits on you in it (`sessionWaiting`): its approvals (D-38), questions its Panes asked outside any Session, and its Panes waiting in their terminal. The box keeps its size
 * at zero, when nothing shows, so the row doesn't reflow as approvals come and go. `fresh` puts "+N"
 * before it for those the phone hasn't shown you yet.
 */
export function WaitingCount({ count, fresh = 0, testID }: { count: number; fresh?: number; testID?: string }) {
  const theme = useTheme();
  const amber = (
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
  if (fresh === 0) return amber;
  return (
    <View style={styles.withNew}>
      <NewBadge count={fresh} testID={testID ? `${testID}-new` : undefined} />
      {amber}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 28, height: 18, alignItems: 'flex-end', justifyContent: 'center' },
  withNew: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  count: { fontWeight: '700', fontVariant: ['tabular-nums'] },
});
