import type { ToolPanel } from '@shared/types/panels';
import * as Haptics from 'expo-haptics';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

export interface PanelTabsProps {
  panels: readonly ToolPanel[];
  selectedId: string | null;
  onSelect: (panel: ToolPanel) => void;
  onAdd: () => void;
  /** A long press on a tab, or the VoiceOver and TalkBack action, offers to close it. */
  onClose: (panel: ToolPanel) => void;
}

/**
 * The web app's tool tabs: bordered tabs on a raised strip and a square + at
 * the end that adds one. Ctrl+C lives on the floating controller.
 */
export function PanelTabs({ panels, selectedId, onSelect, onAdd, onClose }: PanelTabsProps) {
  const theme = useTheme();
  const { colors } = theme;
  return (
    <View style={[styles.bar, { borderBottomColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.tabs}
        accessibilityRole="tablist"
        testID="terminal-panel-tabs"
      >
        {panels.map(panel => {
          const selected = panel.id === selectedId;
          const tint = selected ? colors.text : colors.textSecondary;
          return (
            <Pressable
              key={panel.id}
              testID={`panel-tab-${panel.id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={panel.title}
              accessibilityActions={[{ name: 'close', label: 'Close' }]}
              onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'close') onClose(panel); }}
              onPress={() => {
                if (selected) return;
                void Haptics.selectionAsync();
                onSelect(panel);
              }}
              onLongPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                onClose(panel);
              }}
              style={({ pressed }) => [
                styles.tab,
                {
                  borderTopLeftRadius: theme.radius.md,
                  borderTopRightRadius: theme.radius.md,
                  borderColor: colors.border,
                  backgroundColor: selected ? colors.background : pressed ? colors.surfacePressed : colors.surface,
                },
              ]}
            >
              <Icon ios="apple.terminal" android="terminal" size={16} color={tint} />
              <Text variant="callout" style={[styles.label, { color: tint }]} numberOfLines={1}>
                {panel.title}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        testID="panel-tab-add"
        accessibilityRole="button"
        accessibilityLabel="Add tool"
        hitSlop={6}
        onPress={onAdd}
        style={({ pressed }) => [
          styles.add,
          {
            borderRadius: theme.radius.md,
            borderColor: colors.border,
            backgroundColor: pressed ? colors.surfacePressed : colors.surface,
          },
        ]}
      >
        <Icon ios="plus" android="add" size={16} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 4,
    borderBottomWidth: 1,
  },
  scroll: { flex: 1 },
  tabs: { alignItems: 'flex-end', gap: 4 },
  // Open at the bottom, so the tab reads as attached to the terminal below it.
  tab: {
    height: 36,
    maxWidth: 192,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderBottomWidth: 0,
  },
  label: { flexShrink: 1 },
  add: { width: 30, height: 30, marginBottom: 3, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
