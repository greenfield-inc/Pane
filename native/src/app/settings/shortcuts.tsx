import { router, Stack } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { useDaemon } from '@/daemon';
import { saveErrorMessage, useAffordances, useSaveHostSettings } from '@/features/hosts/hostSettings';
import { ShortcutList } from '@/features/shortcuts/ShortcutList';
import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Screen, Text } from '@/ui';

/** Settings › Shortcuts: the host's list, saved there on every change. */
export default function ShortcutsSettingsScreen() {
  const theme = useTheme();
  const { profile } = useDaemon();
  const affordances = useAffordances();
  const save = useSaveHostSettings();
  // While a save is in flight, show what it sends, so a reorder or toggle doesn't snap back.
  const shortcuts = (save.isPending ? save.variables.terminalShortcuts : undefined) ?? affordances.data?.terminalShortcuts ?? [];
  const saveList = (next: RemotePwaTerminalShortcut[]) => save.mutate({ terminalShortcuts: next });

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable testID="shortcuts-add" accessibilityRole="button" accessibilityLabel="Add shortcut" hitSlop={8} onPress={() => router.push('/settings/shortcut')}>
              <Text variant="body" tone="accent">Add</Text>
            </Pressable>
          ),
        }}
      />
      <Screen scroll testID="shortcuts-settings">
        <Text variant="subhead" tone="secondary">
          Saved on <Text variant="subhead" style={styles.bold}>{profile.label}</Text>. Desktop and every phone paired with it see this same list.
        </Text>
        {affordances.isPending ? (
          <ActivityIndicator color={theme.colors.textMuted} />
        ) : affordances.isError ? (
          <ErrorState error={affordances.error} onRetry={() => void affordances.refetch()} />
        ) : shortcuts.length === 0 ? (
          <EmptyState testID="shortcuts-none" title="No shortcuts" message="Tap Add to save text you send often." />
        ) : (
          <View style={styles.section}>
            <Text variant="caption" tone="muted" style={styles.caption}>SHORTCUTS</Text>
            <ShortcutList
              shortcuts={shortcuts}
              disabled={save.isPending}
              onReorder={saveList}
              onToggle={(shortcut, enabled) => saveList(shortcuts.map(item => (item.id === shortcut.id ? { ...item, enabled } : item)))}
              onOpen={shortcut => router.push({ pathname: '/settings/shortcut', params: { id: shortcut.id } })}
            />
            {save.error ? (
              <Text variant="footnote" tone="danger" testID="shortcuts-save-error" accessibilityLiveRegion="polite" style={styles.caption}>
                {saveErrorMessage(save.error, profile.label)}
              </Text>
            ) : (
              <Text variant="footnote" tone="muted" style={styles.caption}>
                Drag to reorder. Turn one off to hide it on the phone and free its desktop hotkey.
              </Text>
            )}
          </View>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '600' },
  section: { gap: 6 },
  caption: { paddingHorizontal: 4 },
});
