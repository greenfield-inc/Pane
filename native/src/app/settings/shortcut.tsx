import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';

import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';

import { useDaemon } from '@/daemon';
import { saveErrorMessage, useAffordances, useSaveHostSettings } from '@/features/hosts/hostSettings';
import { freeLetter, shortcutProblems } from '@/features/shortcuts/shortcuts';
import { useTheme } from '@/theme';
import { Button, Screen, Text, TextField } from '@/ui';

/** Edit shortcut (or a new one, with no `id`): name, text, desktop hotkey letter, on or off. */
export default function EditShortcutScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const affordances = useAffordances();
  const list = affordances.data?.terminalShortcuts;
  // Wait for the list, so a new shortcut gets a free letter and an edit its saved values.
  if (!list) return <Screen><View /></Screen>;
  const existing = id ? list.find(shortcut => shortcut.id === id) : undefined;
  return <Editor key={existing?.id ?? 'new'} list={list} existing={existing} />;
}

function Editor({ list, existing }: { list: RemotePwaTerminalShortcut[]; existing: RemotePwaTerminalShortcut | undefined }) {
  const theme = useTheme();
  const { colors } = theme;
  const { profile } = useDaemon();
  const save = useSaveHostSettings();
  const [draft, setDraft] = useState<RemotePwaTerminalShortcut>(() => existing ?? {
    id: `shortcut-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: '',
    key: freeLetter(list),
    text: '',
    enabled: true,
  });
  const problems = shortcutProblems(draft, list);
  const valid = Object.keys(problems).length === 0;
  const update = (change: Partial<RemotePwaTerminalShortcut>) => setDraft(current => ({ ...current, ...change }));

  const commit = (next: RemotePwaTerminalShortcut[]) => save.mutate({ terminalShortcuts: next }, { onSuccess: () => router.back() });
  const saveDraft = () => {
    const trimmed = { ...draft, label: draft.label.trim() };
    commit(existing ? list.map(item => (item.id === draft.id ? trimmed : item)) : [...list, trimmed]);
  };
  const confirmDelete = () => Alert.alert(`Delete “${draft.label || 'this shortcut'}”?`, `It goes from ${profile.label}, desktop included.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => commit(list.filter(item => item.id !== draft.id)) },
  ]);

  return (
    <>
      <Stack.Screen
        options={{
          title: existing ? 'Edit shortcut' : 'New shortcut',
          headerLeft: () => (
            <Pressable testID="shortcut-cancel" accessibilityRole="button" hitSlop={8} onPress={() => router.back()}>
              <Text variant="body" tone="accent">Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              testID="shortcut-save"
              accessibilityRole="button"
              accessibilityState={{ disabled: !valid || save.isPending }}
              disabled={!valid || save.isPending}
              hitSlop={8}
              onPress={saveDraft}
            >
              <Text variant="body" tone="accent" style={[styles.bold, { opacity: valid && !save.isPending ? 1 : 0.4 }]}>Save</Text>
            </Pressable>
          ),
        }}
      />
      <Screen scroll testID="shortcut-editor">
        <TextField
          testID="shortcut-name"
          label="Name"
          value={draft.label}
          onChangeText={label => update({ label })}
          error={draft.label ? problems.label : undefined}
          returnKeyType="next"
        />
        <TextField
          testID="shortcut-text"
          label="Text inserted"
          value={draft.text}
          onChangeText={text => update({ text })}
          multiline
          textAlignVertical="top"
          style={styles.text}
        />
        <View style={styles.field}>
          <Text variant="callout" tone="secondary">Desktop hotkey</Text>
          <View style={[styles.hotkey, { borderRadius: theme.radius.md, borderColor: problems.key ? colors.danger : colors.border, backgroundColor: colors.surfaceRaised }]}>
            <Text variant="body" tone="secondary">⌘ ⌥</Text>
            <TextInput
              testID="shortcut-key"
              accessibilityLabel="Desktop hotkey letter"
              value={draft.key.toUpperCase()}
              onChangeText={value => update({ key: value.toLowerCase().replace(/[^a-z]/g, '').slice(-1) })}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={2}
              selectTextOnFocus
              keyboardAppearance={theme.scheme}
              style={[styles.letter, { color: colors.text }]}
            />
          </View>
          <Text variant="footnote" tone={problems.key ? 'danger' : 'muted'}>
            {problems.key ?? 'Desktop Pane on this host types the text when you press ⌘⌥ (Ctrl+Alt on Windows and Linux) and this letter.'}
          </Text>
        </View>
        <View style={[styles.switchRow, { borderRadius: theme.radius.md, borderColor: colors.border, backgroundColor: colors.surface }]}>
          <Text variant="body">Enabled</Text>
          {/* A box of the row's height keeps the iOS switch centered. */}
          <View style={styles.switchBox}>
            <Switch
              testID="shortcut-enabled"
              accessibilityLabel="Enabled"
              value={draft.enabled}
              onValueChange={enabled => update({ enabled })}
              trackColor={{ true: colors.success, false: undefined }}
            />
          </View>
        </View>
        {save.error ? (
          <Text variant="footnote" tone="danger" testID="shortcut-save-error" accessibilityLiveRegion="polite">
            {saveErrorMessage(save.error, profile.label)}
          </Text>
        ) : null}
        {existing ? <Button testID="shortcut-delete" title="Delete shortcut" variant="destructive" onPress={confirmDelete} /> : null}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '600' },
  text: { minHeight: 140 },
  field: { gap: 8 },
  hotkey: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderWidth: 1 },
  // No lineHeight: it pushes an iOS TextInput's text below the row's center.
  letter: { minWidth: 28, paddingVertical: 0, fontSize: 17, fontWeight: '600' },
  switchBox: { height: 52, justifyContent: 'center' },
  switchRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderWidth: 1 },
});
