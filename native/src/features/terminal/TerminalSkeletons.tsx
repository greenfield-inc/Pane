import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, withAlpha } from '@/theme';
import { Skeleton } from '@/ui';

const LINE_WIDTHS = ['62%', '38%', '84%', '50%', '72%', '28%'] as const;

/**
 * Lines of output not drawn yet, in the terminal's own colors, for SkeletonSwap. `lineHeight` is
 * the text's row pitch; `style` sets the inset (the live terminal's 8 pt by default).
 */
export function TerminalSkeleton({ testID, label, lineHeight = 16, style }: {
  testID: string;
  label: string;
  lineHeight?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { terminal } = useTheme();
  const height = Math.round(lineHeight * 0.6);
  return (
    <View testID={testID} accessible accessibilityLabel={label} style={[styles.screen, { backgroundColor: terminal.background }, style]}>
      {LINE_WIDTHS.map(width => (
        <Skeleton
          key={width}
          width={width}
          height={height}
          style={{ marginVertical: (lineHeight - height) / 2, backgroundColor: withAlpha(terminal.foreground, 0.12) }}
        />
      ))}
    </View>
  );
}

/** The tab strip (PanelTabs) before any tab is known: two tabs and the + in its footprint. */
export function PanelTabsSkeleton() {
  const theme = useTheme();
  const { colors } = theme;
  const tab = { borderTopLeftRadius: theme.radius.md, borderTopRightRadius: theme.radius.md, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 };
  return (
    <View
      testID="panel-tabs-skeleton"
      accessible
      accessibilityLabel="Loading tabs"
      style={[styles.bar, { borderBottomColor: colors.border, backgroundColor: colors.surfaceRaised }]}
    >
      <View style={styles.tabs}>
        <Skeleton width={112} height={36} style={tab} />
        <Skeleton width={96} height={36} style={tab} />
      </View>
      <Skeleton width={30} height={30} radius={theme.radius.md} style={styles.add} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 8 },
  // PanelTabs' bar, tabs and + button.
  bar: { minHeight: 40, flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 8, paddingTop: 4, borderBottomWidth: 1 },
  tabs: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  add: { marginBottom: 3 },
});
