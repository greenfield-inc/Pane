import { LegendList } from '@legendapp/list/react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { ComposerSheet, useAfterSheetCloses } from '../composer/ComposerSheet';
import { KeyBadge } from './KeyBadge';
import { filterShortcuts } from './shortcuts';

export interface ShortcutsSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The host's list, from `remote:pwa-affordances`. */
  shortcuts: readonly RemotePwaTerminalShortcut[];
  loading: boolean;
  /** Inserts the shortcut's text into the draft at the cursor. */
  onPick: (text: string) => void;
}

/** The host's enabled shortcuts, filterable by name or text. Edit opens Settings › Shortcuts. */
export function ShortcutsSheet({ visible, onClose, shortcuts, loading, onPick }: ShortcutsSheetProps) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const [query, setQuery] = useState('');
  const shown = filterShortcuts(shortcuts, query);
  const { afterClose, onDismiss } = useAfterSheetCloses();

  const close = () => {
    setQuery('');
    onClose();
  };
  const edit = () => {
    afterClose(() => router.push('/settings/shortcuts'));
    close();
  };

  return (
    <ComposerSheet
      visible={visible}
      onClose={close}
      onDismiss={onDismiss}
      testID="shortcuts-sheet"
    >
      <View style={styles.header}>
        <Text variant="headline" accessibilityRole="header">Shortcuts</Text>
        <Text variant="subhead" tone="muted" numberOfLines={1} style={styles.host}> · {profile.label}</Text>
        <Pressable testID="shortcuts-edit" accessibilityRole="button" accessibilityLabel="Edit shortcuts" hitSlop={8} onPress={edit}>
          <Text variant="callout" tone="accent" style={styles.link}>Edit</Text>
        </Pressable>
      </View>
      <View style={[styles.search, { borderRadius: theme.radius.md, backgroundColor: colors.surfaceRaised, borderColor: colors.border }]}>
        <Icon ios="magnifyingglass" android="search" size={15} color={colors.textMuted} />
        <TextInput
          testID="shortcuts-filter"
          value={query}
          onChangeText={setQuery}
          placeholder="Filter by name or text"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          keyboardAppearance={theme.scheme}
          accessibilityLabel="Filter shortcuts"
          style={[theme.typography.subhead, styles.searchInput, { color: colors.text }]}
        />
      </View>
      {loading ? (
        <Text variant="subhead" tone="muted" style={styles.message}>Loading the host's shortcuts…</Text>
      ) : shown.length === 0 ? (
        <Text variant="subhead" tone="muted" style={styles.message} testID="shortcuts-empty">
          {query ? 'No shortcut matches.' : 'No shortcuts are on. Tap Edit to add one.'}
        </Text>
      ) : (
        <LegendList
          data={shown}
          keyExtractor={shortcut => shortcut.id}
          estimatedItemSize={60}
          keyboardShouldPersistTaps="handled"
          // A list in a sheet needs a set height; rows are about 80 pt.
          style={[styles.list, { height: Math.min(shown.length * 80 + 8, 360) }]}
          renderItem={({ item }) => (
            <Pressable
              testID={`shortcut-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityHint="Inserts its text at the cursor"
              onPress={() => {
                void Haptics.selectionAsync();
                onPick(item.text);
                close();
              }}
              style={({ pressed }) => [styles.item, { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' }]}
            >
              <KeyBadge letter={item.key} style={styles.badge} />
              <View style={styles.body}>
                <Text variant="callout" numberOfLines={1}>{item.label}</Text>
                <Text variant="footnote" tone="muted" numberOfLines={2}>{item.text}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </ComposerSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 16, paddingBottom: 10 },
  host: { flex: 1 },
  link: { fontWeight: '600' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, paddingHorizontal: 10, height: 38, borderWidth: 1 },
  searchInput: { flex: 1, paddingVertical: 0 },
  message: { paddingHorizontal: 16, paddingVertical: 20 },
  list: { marginTop: 6 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginHorizontal: 6, paddingHorizontal: 10, paddingVertical: 9 },
  badge: { marginTop: 2 },
  body: { flex: 1, minWidth: 0 },
});
