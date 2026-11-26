import { pausedMarkOf, type ToolPanel, type ToolPanelType } from '@shared/types/panels';
import * as Haptics from 'expo-haptics';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { PausedBadge } from '../panes/StatusBadge';
import { tabView } from './panels';

/** Each tab type's icon and the word VoiceOver reads after its title. */
export const TAB_TYPES: Record<ToolPanelType, { ios: SFSymbol; android: AndroidSymbol; label: string }> = {
  terminal: { ios: 'apple.terminal', android: 'terminal', label: 'terminal' },
  chat: { ios: 'bubble.left', android: 'chat_bubble', label: 'chat' },
  browser: { ios: 'globe', android: 'language', label: 'page' },
  explorer: { ios: 'folder', android: 'folder', label: 'files' },
  diff: { ios: 'plus.forwardslash.minus', android: 'difference', label: 'diff' },
  editor: { ios: 'doc.text', android: 'description', label: 'file' },
  logs: { ios: 'text.alignleft', android: 'notes', label: 'script output' },
  notes: { ios: 'note.text', android: 'sticky_note_2', label: 'notes' },
  dashboard: { ios: 'square.grid.2x2', android: 'dashboard', label: 'dashboard' },
  'setup-tasks': { ios: 'checklist', android: 'checklist', label: 'setup tasks' },
  device: { ios: 'iphone', android: 'smartphone', label: 'device' },
};
const CHAT = { ios: 'bubble.left', android: 'chat_bubble', label: 'chat' } as const;

/** A long press's menu for tab `title`: View live (a page tab an agent used), Close or Cancel. */
export function offerClose(title: string, close: () => void, viewLive?: () => void) {
  if (Platform.OS === 'ios') {
    const options = viewLive ? ['View live', 'Close', 'Cancel'] : ['Close', 'Cancel'];
    const closeIndex = viewLive ? 1 : 0;
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options, destructiveButtonIndex: closeIndex, cancelButtonIndex: closeIndex + 1 },
      index => {
        if (index === closeIndex) close();
        else if (viewLive && index === 0) viewLive();
      },
    );
  } else {
    Alert.alert(title, undefined, [
      { text: 'Cancel', style: 'cancel' },
      ...(viewLive ? [{ text: 'View live', onPress: viewLive }] : []),
      { text: 'Close', style: 'destructive', onPress: close },
    ]);
  }
}

/** A tab the screen draws itself, ahead of the Pane's tabs (an approval and what it links). */
export interface LeadingTab {
  id: string;
  title: string;
  icon: { ios: SFSymbol; android: AndroidSymbol };
  /** The word VoiceOver reads after its title, when the title doesn't say it. */
  label?: string;
  /** Closes it, after the long press's menu. Absent for a tab that can't be closed. */
  onClose?: () => void;
}

export interface PanelTabsProps {
  panels: readonly ToolPanel[];
  selectedId: string | null;
  /** Absent with no Pane tabs to pick. */
  onSelect?: (panel: ToolPanel) => void;
  /** No + without it. */
  onAdd?: () => void;
  /** A long press on a tab, or the VoiceOver and TalkBack action, offers to close it. */
  onClose?: (panel: ToolPanel) => void;
  /** A Session's agent chat, drawn with a chat icon. */
  chatId?: string;
  leading?: readonly LeadingTab[];
  onSelectLeading?: (id: string) => void;
}

/**
 * The web app's tool tabs: bordered tabs on a raised strip and a square + at
 * the end that adds one. Each tab shows its type's icon; a tab that opens only
 * on the computer is dimmed, and a paused tab is grayed out behind a pause glyph. Ctrl+C lives on the floating controller.
 * A screen's own `leading` tabs come first, in the same style.
 */
export function PanelTabs({ panels, selectedId, onSelect, onAdd, onClose, chatId, leading = [], onSelectLeading }: PanelTabsProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  // Where each tab sits in the strip, and the strip's visible window, so the open tab can be scrolled into view.
  const strip = useRef<ScrollView>(null);
  const tabFrames = useRef(new Map<string, { x: number; width: number }>());
  const view = useRef({ offset: 0, width: 0 });
  // Noted at once: a fold lays the strip out several times before its scroll event arrives.
  const scrollTo = (x: number) => {
    view.current.offset = x;
    strip.current?.scrollTo({ x, animated: true });
  };
  const revealSelected = () => {
    const frame = selectedId ? tabFrames.current.get(selectedId) : undefined;
    const { offset, width } = view.current;
    if (!frame || width === 0) return;
    // A tab wider than the window shows its start.
    if (frame.x < offset) scrollTo(Math.max(0, frame.x - 8));
    else if (frame.x + frame.width > offset + width) scrollTo(Math.max(0, Math.min(frame.x - 8, frame.x + frame.width - width + 8)));
  };
  // A tab opened from a link, a notification or the computer can sit outside the strip's window.
  useEffect(revealSelected, [selectedId]);
  const onTabLayout = (id: string, frame: { x: number; width: number }) => {
    tabFrames.current.set(id, frame);
    if (id === selectedId) revealSelected();
  };
  return (
    <View style={[styles.bar, { borderBottomColor: colors.border, backgroundColor: colors.surfaceRaised }]}>
      <ScrollView
        ref={strip}
        onLayout={event => {
          view.current.width = event.nativeEvent.layout.width;
          // A narrower window (a fold, a turn) can push the open tab out of view.
          revealSelected();
        }}
        onScroll={event => { view.current.offset = event.nativeEvent.contentOffset.x; }}
        scrollEventThrottle={64}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.tabs}
        accessibilityRole="tablist"
        testID="terminal-panel-tabs"
      >
        {leading.map(({ onClose: close, ...tab }) => (
          <StripTab
            key={tab.id}
            id={tab.id}
            title={tab.title}
            icon={tab.icon}
            accessibilityLabel={tab.label ? `${tab.title}, ${tab.label}` : tab.title}
            selected={tab.id === selectedId}
            onLayout={onTabLayout}
            onSelect={() => onSelectLeading?.(tab.id)}
            onClose={close ? () => offerClose(tab.title, close) : undefined}
          />
        ))}
        {panels.map(panel => {
          const paused = Boolean(pausedMarkOf(panel));
          const dimmed = tabView(panel) === 'placeholder' || paused;
          const type = panel.id === chatId ? CHAT : TAB_TYPES[panel.type];
          return (
            <StripTab
              key={panel.id}
              id={panel.id}
              title={panel.title}
              icon={type}
              accessibilityLabel={`${panel.title}, ${type.label}${paused ? ', paused' : ''}`}
              accessibilityHint={tabView(panel) === 'placeholder' ? `Opens on ${profile.label}` : undefined}
              selected={panel.id === selectedId}
              dimmed={dimmed}
              paused={paused}
              onLayout={onTabLayout}
              onSelect={() => onSelect?.(panel)}
              onClose={onClose ? () => onClose(panel) : undefined}
            />
          );
        })}
      </ScrollView>
      {onAdd ? <Pressable
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
      </Pressable> : null}
    </View>
  );
}

/** One bordered tab: its icon and title; a long press, or the VoiceOver and TalkBack action, offers Close when it can close. */
function StripTab({ id, title, icon, accessibilityLabel, accessibilityHint, selected, dimmed = false, paused = false, onLayout, onSelect, onClose }: {
  id: string;
  title: string;
  icon: { ios: SFSymbol; android: AndroidSymbol };
  accessibilityLabel: string;
  accessibilityHint?: string;
  selected: boolean;
  dimmed?: boolean;
  paused?: boolean;
  onLayout: (id: string, frame: { x: number; width: number }) => void;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const theme = useTheme();
  const { colors } = theme;
  const tint = selected ? colors.text : dimmed ? colors.textMuted : colors.textSecondary;
  return (
    <Pressable
      testID={`panel-tab-${id}`}
      onLayout={event => {
        const { x, width } = event.nativeEvent.layout;
        onLayout(id, { x, width });
      }}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={onClose ? [{ name: 'close', label: 'Close' }] : undefined}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'close') onClose?.(); }}
      onPress={() => {
        if (selected) return;
        void Haptics.selectionAsync();
        onSelect();
      }}
      onLongPress={onClose ? () => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onClose();
      } : undefined}
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
      {paused ? <PausedBadge /> : null}
      <Icon ios={icon.ios} android={icon.android} size={16} color={tint} />
      <Text variant="callout" style={[styles.label, { color: tint }, dimmed && !selected && styles.dimmed]} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
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
