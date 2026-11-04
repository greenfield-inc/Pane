import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import type { SidebarItem } from './paneList';
import { IconButton } from './PaneKit';
import { SwipeRow, swipeRowAccessibility } from './SwipeRow';

/** The drawer's collapsible section header: chevron, sentence-case label and, for Archived, a count. */
export function SidebarSectionHeader({ item, first, onToggle }: {
  item: Extract<SidebarItem, { type: 'section' }>;
  first: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={`sidebar-section-${item.section}`}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      accessibilityState={{ expanded: item.expanded }}
      onPress={onToggle}
      style={({ pressed }) => [styles.section, !first && styles.sectionGap, { borderRadius: theme.radius.md }, pressed && { backgroundColor: theme.colors.surfacePressed }]}
    >
      <Icon ios={item.expanded ? 'chevron.down' : 'chevron.right'} android={item.expanded ? 'expand_more' : 'chevron_right'} size={12} />
      <Text variant="caption" tone="muted" numberOfLines={1} style={styles.sectionTitle}>
        {item.title}
        {item.count ? <Text variant="caption" tone="muted" style={styles.sectionCount}>{`  ${item.count}`}</Text> : null}
      </Text>
    </Pressable>
  );
}

/**
 * A Session row: a chevron showing its panes (or a chat icon when it has none),
 * then the name and pane count. Swipe right pins, swipe left archives.
 */
export function SessionRow({ item, onOpen, onToggleNested, onTogglePinned, onArchive }: {
  item: Extract<SidebarItem, { type: 'session' }>;
  onOpen: () => void;
  onToggleNested: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  const { session, label, paneCount, nestedKey, nestedExpanded } = item;
  const actions = { pinned: Boolean(session.isPinned), onTogglePinned, onArchive };
  return (
    <SwipeRow testIDPrefix="session" id={nestedKey} {...actions}>
      <View style={[styles.row, { backgroundColor: pressed ? theme.colors.selected : theme.colors.background }]}>
        {paneCount > 0 ? (
          <IconButton
            testID={`session-nested-${nestedKey}`}
            label={`${nestedExpanded ? 'Hide' : 'Show'} panes in ${label}`}
            onPress={onToggleNested}
          >
            <Icon ios={nestedExpanded ? 'chevron.down' : 'chevron.right'} android={nestedExpanded ? 'expand_more' : 'chevron_right'} size={14} />
          </IconButton>
        ) : (
          <View style={styles.leadingIcon}>
            <Icon ios="bubble.left" android="chat_bubble" size={14} />
          </View>
        )}
        <Pressable
          testID={`session-row-${nestedKey}`}
          accessibilityRole="button"
          accessibilityLabel={`Open Session ${label}`}
          {...swipeRowAccessibility(actions)}
          onPress={onOpen}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          style={styles.open}
        >
          <Text variant="callout" numberOfLines={1} style={[styles.name, { color: pressed ? theme.colors.text : theme.colors.textSecondary }]}>{label}</Text>
          {paneCount > 0 ? <Text variant="caption" tone="muted" style={styles.count}>{paneCount}</Text> : null}
        </Pressable>
      </View>
    </SwipeRow>
  );
}

/** An archived Session or pane with Restore; archived panes can also be deleted for good. */
export function ArchivedRow({ item, onRestore, onDelete }: {
  item: Extract<SidebarItem, { type: 'archived' }>;
  onRestore: () => void;
  onDelete?: () => void;
}) {
  return (
    <View style={styles.archived}>
      <Icon ios={item.kind === 'session' ? 'bubble.left' : 'archivebox'} android={item.kind === 'session' ? 'chat_bubble' : 'archive'} size={14} />
      <Text variant="callout" tone="muted" numberOfLines={1} style={styles.name}>
        {item.label}
        {item.detail ? <Text variant="footnote" tone="muted">{`  ${item.detail}`}</Text> : null}
      </Text>
      <View style={styles.actions}>
        <IconButton
          testID={`archived-restore-${item.id}`}
          label={item.kind === 'session' ? `Restore Session ${item.label}` : `Restore ${item.label}`}
          onPress={onRestore}
        >
          <Icon ios="arrow.uturn.backward" android="unarchive" size={16} />
        </IconButton>
        {onDelete ? (
          <IconButton testID={`archived-delete-${item.id}`} label={`Delete ${item.label}`} onPress={onDelete}>
            <Icon ios="trash" android="delete" size={16} />
          </IconButton>
        ) : null}
      </View>
    </View>
  );
}

/** The `px-2 py-1 text-xs` hint under a section header. */
export function SidebarNote({ text, testID }: { text: string; testID?: string }) {
  return <Text testID={testID} variant="footnote" tone="muted" style={styles.note}>{text}</Text>;
}

const styles = StyleSheet.create({
  // px-2 py-1.5 text-xs; sections sit space-y-3 apart.
  section: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, minHeight: 32, marginBottom: 4 },
  sectionGap: { marginTop: 12 },
  sectionTitle: { flex: 1, fontSize: 13, lineHeight: 18, letterSpacing: 0.1 },
  sectionCount: { fontWeight: '500' },
  // Matches PaneRow's footprint: py-3 around an h-8 button.
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 56, paddingLeft: 4, paddingRight: 12 },
  leadingIcon: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  open: { flex: 1, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1 },
  count: { fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  archived: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingLeft: 12, paddingRight: 12, marginBottom: 4 },
  note: { paddingHorizontal: 8, paddingVertical: 4 },
});
