import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Skeleton } from '@/ui';

/** Shortcuts settings before the computer answers: a section label and three of ShortcutList's 64 pt rows. */
export function ShortcutListSkeleton() {
  const theme = useTheme();
  return (
    <View testID="shortcuts-settings-skeleton" accessible accessibilityLabel="Loading shortcuts">
      <View style={styles.label}><Skeleton width={72} height={13} style={styles.labelBone} /></View>
      <View style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: theme.colors.card, borderColor: theme.colors.cardBorder }]}>
        {[0.35, 0.5, 0.3].map((width, index) => (
          <View key={width} style={styles.row}>
            {index > 0 ? <View style={[styles.separator, { backgroundColor: theme.colors.border }]} /> : null}
            <View style={styles.handle}><Skeleton width={16} height={10} /></View>
            <View style={styles.body}>
              <Skeleton width={`${width * 100}%`} height={16} />
              <Skeleton width="70%" height={12} />
            </View>
            <Skeleton width={51} height={31} radius={theme.radius.pill} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // ListSection's label.
  label: { paddingHorizontal: 4, paddingBottom: 6 },
  labelBone: { marginVertical: 2.5 },
  // ShortcutList's card and rows.
  card: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 64, paddingRight: 16 },
  handle: { width: 40, alignItems: 'center' },
  body: { flex: 1, gap: 8 },
  separator: { position: 'absolute', top: 0, left: 50, right: 0, height: StyleSheet.hairlineWidth },
});
