import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

export interface ShortcutsPanelProps {
  /** The host's snippets, from `remote:pwa-affordances`. */
  shortcuts: readonly RemotePwaTerminalShortcut[];
  loading: boolean;
  /** Inserts the snippet's text into the draft. */
  onPick: (text: string) => void;
  onClose: () => void;
}

/** The web app's "Terminal Shortcuts" popover, floating above the input. */
export function ShortcutsPanel({ shortcuts, loading, onPick, onClose }: ShortcutsPanelProps) {
  const theme = useTheme();
  const { colors } = theme;
  const enabled = shortcuts.filter(shortcut => shortcut.enabled !== false && shortcut.text.trim());

  return (
    <View
      testID="terminal-shortcuts-panel"
      style={[styles.panel, { borderRadius: theme.radius.lg, borderColor: colors.border, backgroundColor: colors.surface }]}
    >
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text variant="subhead" style={styles.title} accessibilityRole="header">Terminal Shortcuts</Text>
        <Pressable
          testID="terminal-shortcuts-close"
          accessibilityRole="button"
          accessibilityLabel="Close shortcuts"
          hitSlop={10}
          onPress={onClose}
          style={({ pressed }) => [styles.close, { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
        >
          <Icon ios="xmark" android="close" size={16} color={colors.textMuted} />
        </Pressable>
      </View>
      {loading ? (
        <Text variant="subhead" tone="muted" style={styles.message}>Loading host shortcuts...</Text>
      ) : enabled.length > 0 ? (
        <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="always">
          {enabled.map(shortcut => (
            <Pressable
              key={shortcut.id}
              testID={`terminal-shortcut-${shortcut.id}`}
              accessibilityRole="button"
              onPress={() => onPick(shortcut.text)}
              style={({ pressed }) => [styles.item, { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
            >
              <View style={[styles.badge, { borderColor: colors.border }]}>
                <Text variant="footnote" tone="muted" style={styles.badgeText}>{shortcut.key.toUpperCase()}</Text>
              </View>
              <View style={styles.body}>
                <Text variant="callout">{shortcut.label || `Shortcut ${shortcut.key.toUpperCase()}`}</Text>
                <Text variant="footnote" tone="muted" numberOfLines={2}>{shortcut.text}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <Text variant="subhead" tone="muted" style={styles.message}>No enabled terminal shortcuts on this host.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { position: 'absolute', left: 8, right: 8, bottom: 8, maxHeight: 256, overflow: 'hidden', borderWidth: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  title: { fontWeight: '600' },
  close: { padding: 4 },
  message: { paddingHorizontal: 12, paddingVertical: 16 },
  list: { padding: 6 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 10, paddingVertical: 8 },
  badge: { marginTop: 2, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
  body: { flex: 1, minWidth: 0 },
});
