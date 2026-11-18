import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { useDaemon } from '@/daemon';
import { saveErrorMessage, useAffordances, useSaveHostSettings } from '@/features/hosts/hostSettings';
import { ShortcutList } from '@/features/shortcuts/ShortcutList';
import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Screen, Skeleton, SkeletonSwap, Text } from '@/ui';

/** Settings › Shortcuts: the host's list, saved there on every change. */
export default function ShortcutsSettingsScreen() {
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
      <Screen scroll grouped testID="shortcuts-settings">
        <Text variant="subhead" tone="secondary" style={styles.inset}>
          Saved on <Text variant="subhead" style={styles.bold}>{profile.label}</Text>. Desktop and every phone paired with it see this same list.
        </Text>
        <SkeletonSwap loading={affordances.isPending} skeleton={<ShortcutsSkeleton />}>
          {affordances.isError ? (
            <ErrorState error={affordances.error} onRetry={() => void affordances.refetch()} />
          ) : shortcuts.length === 0 ? (
            <EmptyState testID="shortcuts-none" title="No shortcuts" message="Tap Add to save text you send often." />
          ) : (
            <View>
              <Text variant="sectionLabel" tone="muted" style={styles.label}>Shortcuts</Text>
              <ShortcutList
                shortcuts={shortcuts}
                disabled={save.isPending}
                onReorder={saveList}
                onToggle={(shortcut, enabled) => saveList(shortcuts.map(item => (item.id === shortcut.id ? { ...item, enabled } : item)))}
                onOpen={shortcut => router.push({ pathname: '/settings/shortcut', params: { id: shortcut.id } })}
              />
              {save.error ? (
                <Text variant="rowDetail" tone="danger" testID="shortcuts-save-error" accessibilityLiveRegion="polite" style={styles.footer}>
                  {saveErrorMessage(save.error, profile.label)}
                </Text>
              ) : (
                <Text variant="rowDetail" tone="muted" style={styles.footer}>
                  Drag to reorder. Turn one off to hide it on the phone and free its desktop hotkey.
                </Text>
              )}
            </View>
          )}
        </SkeletonSwap>
      </Screen>
    </>
  );
}

/** The Shortcuts label over a card of shortcut rows: handle, label and text, switch. */
function ShortcutsSkeleton() {
  const theme = useTheme();
  return (
    <View testID="shortcuts-settings-skeleton" accessible accessibilityLabel="Loading shortcuts">
      <View style={styles.label}><Skeleton width={72} height={13} style={styles.labelBone} /></View>
      <View style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: theme.colors.card, borderColor: theme.colors.cardBorder }]}>
        {[0.35, 0.5, 0.3].map((width, index) => (
          <View key={width} style={styles.row}>
            {index > 0 ? <View style={[styles.separator, { backgroundColor: theme.colors.border }]} /> : null}
            <View style={styles.handle}><Skeleton width={16} height={10} /></View>
            <View style={styles.body}>
              <Skeleton width={`${width * 100}%`} height={16} />
              <Skeleton width="70%" height={12} />
            </View>
            <Skeleton width={51} height={31} radius={theme.radius.pill} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '600' },
  inset: { paddingHorizontal: 4 },
  // ListSection's label and footer, around a card that ListSection can't hold (rows lift out of it).
  label: { paddingHorizontal: 4, paddingBottom: 6 },
  footer: { paddingHorizontal: 4, paddingTop: 6 },
  // ShortcutList's card and 64 pt rows.
  labelBone: { marginVertical: 2.5 },
  card: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 64, paddingRight: 16 },
  handle: { width: 40, alignItems: 'center' },
  body: { flex: 1, gap: 8 },
  separator: { position: 'absolute', top: 0, left: 50, right: 0, height: StyleSheet.hairlineWidth },
});
