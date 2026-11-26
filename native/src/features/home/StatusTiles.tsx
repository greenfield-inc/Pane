import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, type ThemeColors } from '@/theme';
import { Skeleton, Text } from '@/ui';

import { NewBadge } from '@/features/approvals/NewBadge';

import type { BoardTile } from './statusBoard';
import { Focusable } from '@/features/controller/Focusable';

const ROWS: ReadonlyArray<ReadonlyArray<{ id: BoardTile; label: string; color: keyof ThemeColors }>> = [[
  { id: 'all', label: 'All panes', color: 'allPanes' },
  { id: 'needs', label: 'Needs you', color: 'warning' },
], [
  { id: 'working', label: 'Working', color: 'accent' },
  { id: 'ready', label: 'Ready', color: 'success' },
]];

/**
 * Four counts in a 2×2 grid. The selected tile wears its status color and filters the list below.
 * Needs you carries "+N" in its corner for what arrived since you last looked.
 */
export function StatusTiles({ counts, fresh = 0, selected, onSelect }: {
  counts: Partial<Record<BoardTile, number>> | undefined;
  /** What waits on you that the phone hasn't shown you yet. */
  fresh?: number;
  selected: BoardTile;
  onSelect: (tile: BoardTile) => void;
}) {
  const theme = useTheme();
  return (
    <View testID="home-tiles" style={styles.grid} accessibilityRole="tablist">
      {ROWS.map(row => <View key={row[0].id} style={styles.row}>{row.map(tile => {
        const color = theme.colors[tile.color];
        const on = tile.id === selected;
        const count = counts?.[tile.id];
        const fresher = tile.id === 'needs' && count !== undefined ? fresh : 0;
        return (
          <Focusable key={tile.id} style={styles.tileBox} onActivate={() => onSelect(tile.id)}>
          <Pressable
            testID={`home-tile-${tile.id}`}
            accessibilityRole="tab"
            accessibilityLabel={[tile.label, count === undefined ? undefined : String(count), fresher > 0 ? `${fresher} new` : undefined].filter(Boolean).join(', ')}
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(tile.id)}
            style={({ pressed }) => [styles.tile, {
              borderRadius: theme.radius.card,
              borderColor: on ? color : 'transparent',
              backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised,
            }]}
          >
            {/* Until it's counted, a bone sits where the number goes, on a hidden digit that holds its line. */}
            <View>
              <Text style={[styles.count, { color: count === undefined ? 'transparent' : on ? color : theme.colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
                {count === undefined ? '0' : String(count)}
              </Text>
              {count === undefined ? <Skeleton width={28} height={22} style={styles.countBone} /> : null}
            </View>
            <View style={styles.label}>
              <View style={[styles.dot, { backgroundColor: color }]} />
              <Text variant="rowDetail" tone="secondary" numberOfLines={1} maxFontSizeMultiplier={1.4}>{tile.label}</Text>
            </View>
            {/* In the corner, so the count and label never move when it comes and goes. */}
            <NewBadge count={fresher} testID="home-tile-needs-new" style={styles.fresh} />
          </Pressable>
          </Focusable>
        );
      })}</View>)}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: 8, paddingHorizontal: 12 },
  // Two rows of two, so the tiles follow the window's width as a foldable opens and closes.
  row: { flexDirection: 'row', gap: 8 },
  tileBox: { flex: 1 },
  tile: { flex: 1, minHeight: 72, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1.5, justifyContent: 'center' },
  count: { fontSize: 26, lineHeight: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  countBone: { position: 'absolute', left: 0, top: 4 },
  label: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  fresh: { position: 'absolute', top: 8, right: 8 },
});
