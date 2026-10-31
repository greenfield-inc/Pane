import type { ToolPanel, ToolPanelType } from '@shared/types/panels';
import * as Haptics from 'expo-haptics';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { tabView } from './panels';

/** Each tab type's icon and the word VoiceOver reads after its title. */
export const TAB_TYPES: Record<ToolPanelType, { ios: SFSymbol; android: AndroidSymbol; label: string }> = {
  terminal: { ios: 'apple.terminal', android: 'terminal', label: 'terminal' },
  browser: { ios: 'globe', android: 'language', label: 'page' },
  explorer: { ios: 'folder', android: 'folder', label: 'files' },
  diff: { ios: 'plus.forwardslash.minus', android: 'difference', label: 'diff' },
  editor: { ios: 'doc.text', android: 'description', label: 'file' },
  logs: { ios: 'text.alignleft', android: 'notes', label: 'script output' },
  notes: { ios: 'note.text', android: 'sticky_note_2', label: 'notes' },
  dashboard: { ios: 'square.grid.2x2', android: 'dashboard', label: 'dashboard' },
  'setup-tasks': { ios: 'checklist', android: 'checklist', label: 'setup tasks' },
};
const CHAT = { ios: 'bubble.left', android: 'chat_bubble', label: 'chat' } as const;

export interface PanelTabsProps {
  panels: readonly ToolPanel[];
  selectedId: string | null;
  onSelect: (panel: ToolPanel) => void;
  onAdd: () => void;
  /** A long press on a tab, or the VoiceOver and TalkBack action, offers to close it. */
  onClose: (panel: ToolPanel) => void;
  /** A Session's agent chat, drawn with a chat icon. */
  chatId?: string;
}

/**
 * The web app's tool tabs: bordered tabs on a raised strip and a square + at
 * the end that adds one. Each tab shows its type's icon; a tab that opens only
 * on the computer is dimmed. Ctrl+C lives on the floating controller.
 */
export function PanelTabs({ panels, selectedId, onSelect, onAdd, onClose, chatId }: PanelTabsProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
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
          const dimmed = tabView(panel) === 'placeholder';
          const tint = selected ? colors.text : dimmed ? colors.textMuted : colors.textSecondary;
          const type = panel.id === chatId ? CHAT : TAB_TYPES[panel.type];
          return (
            <Pressable
              key={panel.id}
              testID={`panel-tab-${panel.id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={`${panel.title}, ${type.label}`}
              accessibilityHint={dimmed ? `Opens on ${profile.label}` : undefined}
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
              <Icon ios={type.ios} android={type.android} size={16} color={tint} />
              <Text variant="callout" style={[styles.label, { color: tint }, dimmed && !selected && styles.dimmed]} numberOfLines={1}>
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
  dimmed: { fontWeight: '400' },
  add: { width: 30, height: 30, marginBottom: 3, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
