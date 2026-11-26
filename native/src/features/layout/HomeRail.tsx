import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BoardTile } from '@/features/home/statusBoard';
import { MachineMark } from '@/features/machines/MachineMark';
import type { Machine } from '@/features/machines/machines';
import { useTheme, type ThemeColors } from '@/theme';
import { Icon, Text } from '@/ui';

import { NewBadge } from '@/features/approvals/NewBadge';

import { RAIL_WIDTH } from './windowRule';

// Rail labels stop growing here (UI scale and system text size together), so a count and its word stay inside 64 dp.
const MAX_TEXT_SCALE = 1.2;
const COUNTS: ReadonlyArray<{ tile: BoardTile; label: string; spoken: string; color: keyof ThemeColors }> = [
  { tile: 'all', label: 'Panes', spoken: 'All panes', color: 'allPanes' },
  { tile: 'needs', label: 'Needs', spoken: 'Needs you', color: 'warning' },
  { tile: 'working', label: 'Working', spoken: 'Working', color: 'accent' },
  { tile: 'ready', label: 'Ready', spoken: 'Ready', color: 'success' },
];

/**
 * Home collapsed beside an open screen: expand, the machine (or All), the four counts, then search,
 * + (when a machine here takes new work) and Settings. A count, the machine or search expands Home there. On a short window the upper
 * part scrolls; search, + and Settings stay in reach.
 */
export function HomeRail({ machine, counts, fresh = 0, onExpand, onSelectTile, onSearch, canCreate }: {
  /** The machine Home is on, or undefined on All. */
  machine: Pick<Machine, 'name' | 'os' | 'slot' | 'state'> | undefined;
  counts: Partial<Record<BoardTile, number>> | undefined;
  /** "+N" on Needs: what waits on you that the phone hasn't shown you yet. */
  fresh?: number;
  onExpand: () => void;
  onSelectTile: (tile: BoardTile) => void;
  onSearch: () => void;
  /** Some machine here takes new work (not one paired read-only). */
  canCreate: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const machineName = machine ? Array.from(machine.name).slice(0, 5).join('') : 'All';
  return (
    <View testID="home-rail" style={[styles.rail, { paddingTop: insets.top + 6, paddingBottom: Math.max(insets.bottom, 12) }]}>
      <ScrollView style={styles.fill} contentContainerStyle={styles.upper} showsVerticalScrollIndicator={false}>
        <RailButton testID="home-expand" label="Expand Home" onPress={onExpand}>
          <Icon ios="sidebar.left" android="left_panel_open" size={20} color={theme.colors.text} />
        </RailButton>
        <RailButton testID="home-rail-machine" label={machine ? `${machine.name}, open Home on this machine` : 'All machines, open Home'} onPress={onExpand} tall>
          {machine ? <MachineMark os={machine.os} slot={machine.slot} state={machine.state} /> : <Icon ios="square.3.layers.3d" android="layers" size={18} color={theme.colors.text} />}
          <Text variant="caption" numberOfLines={1} maxScale={MAX_TEXT_SCALE} style={styles.label}>{machineName}</Text>
        </RailButton>
        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
        {COUNTS.map(({ tile, label, spoken, color }) => {
          const count = counts?.[tile];
          const fresher = tile === 'needs' && count !== undefined ? fresh : 0;
          return (
            <RailButton key={tile} testID={`home-rail-${tile}`} label={[spoken, count === undefined ? undefined : String(count), fresher > 0 ? `${fresher} new` : undefined].filter(Boolean).join(', ')} onPress={() => onSelectTile(tile)} tall>
              <Text variant="headline" maxScale={MAX_TEXT_SCALE} style={[styles.count, { color: theme.colors[color] }]}>{count === undefined ? ' ' : String(count)}</Text>
              <Text variant="caption" tone="secondary" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxScale={MAX_TEXT_SCALE} style={styles.label}>{label}</Text>
              <NewBadge count={fresher} testID="home-rail-needs-new" style={styles.fresh} />
            </RailButton>
          );
        })}
      </ScrollView>
      <View style={styles.lower}>
        <RailButton testID="home-rail-search" label="Search panes" onPress={onSearch}>
          <Icon ios="magnifyingglass" android="search" size={20} color={theme.colors.text} />
        </RailButton>
        {canCreate ? (
        <Pressable
          testID="home-rail-new"
          accessibilityRole="button"
          accessibilityLabel="New"
          accessibilityHint="Starts a Session or a Pane"
          onPress={() => router.push('/new')}
          style={({ pressed }) => [styles.new, { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 }]}
        >
          <Icon ios="plus" android="add" size={22} color={theme.colors.onAccent} />
        </Pressable>
        ) : null}
        <RailButton testID="home-rail-settings" label="Settings" onPress={() => router.push('/settings')}>
          <Icon ios="gearshape" android="settings" size={20} color={theme.colors.text} />
        </RailButton>
      </View>
    </View>
  );
}

function RailButton({ testID, label, onPress, tall = false, children }: { testID: string; label: string; onPress: () => void; tall?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, tall && styles.tall, { borderRadius: theme.radius.md, backgroundColor: pressed ? theme.colors.surfacePressed : tall ? theme.colors.surfaceRaised : 'transparent' }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rail: { flex: 1, width: RAIL_WIDTH, alignItems: 'center' },
  fill: { flex: 1, alignSelf: 'stretch' },
  upper: { alignItems: 'center', gap: 8 },
  lower: { alignItems: 'center', gap: 12, paddingTop: 8 },
  // Every target is at least 48 dp.
  button: { width: 56, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tall: { minHeight: 60, paddingVertical: 6 },
  count: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { fontWeight: '600' },
  fresh: { position: 'absolute', top: -4, right: -4 },
  divider: { width: 32, height: StyleSheet.hairlineWidth, marginVertical: 2 },
  new: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
