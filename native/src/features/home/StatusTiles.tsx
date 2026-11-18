import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme, type ThemeColors } from '@/theme';
import { Text } from '@/ui';

import type { BoardTile } from './statusBoard';

const TILES: ReadonlyArray<{ id: BoardTile; label: string; color: keyof ThemeColors }> = [
  { id: 'all', label: 'All panes', color: 'allPanes' },
  { id: 'needs', label: 'Needs you', color: 'warning' },
  { id: 'working', label: 'Working', color: 'accent' },
  { id: 'ready', label: 'Ready', color: 'success' },
];

/** Four counts in a 2×2 grid. The selected tile wears its status color and filters the list below. */
export function StatusTiles({ counts, selected, onSelect }: {
  counts: Partial<Record<BoardTile, number>> | undefined;
  selected: BoardTile;
  onSelect: (tile: BoardTile) => void;
}) {
  const theme = useTheme();
  return (
    <View testID="home-tiles" style={styles.grid} accessibilityRole="tablist">
      {TILES.map(tile => {
        const color = theme.colors[tile.color];
        const on = tile.id === selected;
        const count = counts?.[tile.id];
        return (
          <Pressable
            key={tile.id}
            testID={`home-tile-${tile.id}`}
            accessibilityRole="tab"
            accessibilityLabel={count === undefined ? tile.label : `${tile.label}, ${count}`}
            accessibilityState={{ selected: on }}
            onPress={() => onSelect(tile.id)}
            style={({ pressed }) => [styles.tile, {
              borderRadius: theme.radius.card,
              borderColor: on ? color : 'transparent',
              backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised,
            }]}
          >
            <Text style={[styles.count, { color: on ? color : theme.colors.text }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
              {count === undefined ? '–' : String(count)}
            </Text>
            <View style={styles.label}>
              <View style={[styles.dot, { backgroundColor: color }]} />
              <Text variant="rowDetail" tone="secondary" numberOfLines={1} maxFontSizeMultiplier={1.4}>{tile.label}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12 },
  // Two per row: half the width, less half the gap.
  tile: { flexBasis: '48%', flexGrow: 1, minHeight: 72, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1.5, justifyContent: 'center' },
  count: { fontSize: 26, lineHeight: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
