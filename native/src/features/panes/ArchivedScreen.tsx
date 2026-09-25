import { LegendList } from '@legendapp/list/react-native';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { useArchivedProjects, useDeleteArchivedPane } from './hooks';
import { LoadingRows, Notice, SectionHeader } from './PaneKit';

type ArchivedItem =
  | { type: 'section'; key: string; title: string }
  | { type: 'pane'; key: string; id: string; name: string };

/** Archived panes grouped by repository like the pane list; tapping one deletes it for good. */
export function ArchivedScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const projects = useArchivedProjects();
  const deletePane = useDeleteArchivedPane();
  const items: ArchivedItem[] = (projects.data ?? []).flatMap(project => {
    const sessions = project.sessions ?? [];
    return sessions.length === 0 ? [] : [
      { type: 'section' as const, key: `project-${project.id}`, title: project.name },
      ...sessions.map(session => ({ type: 'pane' as const, key: session.id, id: session.id, name: session.name })),
    ];
  });

  const confirmDelete = (pane: { id: string; name: string }) => {
    Alert.alert(`Delete “${pane.name}”?`, 'This removes the pane and its history from the host for good.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deletePane(pane.id).catch((error: Error) => Alert.alert('Couldn’t delete the pane', error.message)),
      },
    ]);
  };

  return (
    <LegendList
      testID="archived-list"
      data={items}
      keyExtractor={item => item.key}
      getItemType={item => item.type}
      estimatedItemSize={48}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 12 }]}
      ListEmptyComponent={
        projects.isPending ? <LoadingRows />
          : projects.isError ? <Notice danger message={projects.error.message} action={{ title: 'Try again', onPress: () => void projects.refetch() }} />
          : <Notice testID="archived-empty" message="Nothing archived. Panes you archive show up here." />
      }
      renderItem={({ item, index }) => item.type === 'section'
        ? <SectionHeader title={item.title} first={index === 0} icon={<Icon ios="desktopcomputer" android="desktop_windows" size={14} />} />
        : (
          <Pressable
            testID={`archived-row-${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={item.name}
            accessibilityHint="Deletes the pane for good"
            onPress={() => confirmDelete(item)}
            style={({ pressed }) => [styles.row, { borderRadius: theme.radius.md, backgroundColor: pressed ? theme.colors.selected : theme.colors.background }]}
          >
            <Text variant="callout" tone="secondary" numberOfLines={1} style={styles.name}>{item.name}</Text>
            <View style={styles.trash}><Icon ios="trash" android="delete" size={14} /></View>
          </Pressable>
        )}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 12 },
  // The pane list's rows: rounded-md px-3 py-3, space-y-1.
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, paddingVertical: 12, marginBottom: 4 },
  name: { flex: 1 },
  // Lines up with the pane list's 32 pt action buttons.
  trash: { width: 32, alignItems: 'center' },
});
