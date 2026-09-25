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
}

export function PanelTabs({ panels, selectedId, onSelect, onAdd }: PanelTabsProps) {
  const theme = useTheme();
  return (
    <View style={[styles.bar, { borderBottomColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabs}
        accessibilityRole="tablist"
        testID="terminal-panel-tabs"
      >
        {panels.map(panel => {
          const selected = panel.id === selectedId;
          return (
            <Pressable
              key={panel.id}
              testID={`panel-tab-${panel.id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={panel.title}
              onPress={() => {
                if (selected) return;
                void Haptics.selectionAsync();
                onSelect(panel);
              }}
              style={({ pressed }) => [
                styles.tab,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: selected ? theme.colors.surfacePressed : pressed ? theme.colors.surfaceRaised : 'transparent',
                },
              ]}
            >
              <Text variant="subhead" tone={selected ? 'primary' : 'muted'} style={selected && styles.selected} numberOfLines={1}>
                {panel.title}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        testID="panel-tab-add"
        accessibilityRole="button"
        accessibilityLabel="New terminal tab"
        hitSlop={8}
        onPress={onAdd}
        style={({ pressed }) => [styles.add, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Icon ios="plus" android="add" size={18} color={theme.colors.accentText} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  tab: { paddingHorizontal: 12, height: 30, justifyContent: 'center', maxWidth: 180 },
  selected: { fontWeight: '600' },
  add: { width: 44, height: 42, alignItems: 'center', justifyContent: 'center' },
});
