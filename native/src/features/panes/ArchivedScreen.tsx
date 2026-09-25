import { LegendList } from '@legendapp/list/react-native';
import { Alert, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Icon, ListRow, Skeleton } from '@/ui';

import { useArchivedProjects, useDeleteArchivedPane } from './hooks';

interface ArchivedPane {
  id: string;
  name: string;
  projectName: string;
}

export function ArchivedScreen() {
  const theme = useTheme();
  const projects = useArchivedProjects();
  const deletePane = useDeleteArchivedPane();
  const panes: ArchivedPane[] = (projects.data ?? []).flatMap(project =>
    (project.sessions ?? []).map(session => ({ id: session.id, name: session.name, projectName: project.name })));

  const confirmDelete = (pane: ArchivedPane) => {
    Alert.alert(`Delete “${pane.name}”?`, 'This removes the pane and its history from the host for good.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deletePane.mutate([pane.id], {
          onError: error => Alert.alert('Couldn’t delete the pane', error.message),
        }),
      },
    ]);
  };

  return (
    <LegendList
      testID="archived-list"
      data={panes}
      keyExtractor={pane => pane.id}
      estimatedItemSize={60}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.background }}
      ItemSeparatorComponent={() => <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />}
      ListEmptyComponent={
        projects.isPending ? <View style={styles.loading}><Skeleton width="60%" /><Skeleton width="40%" /></View>
          : projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
          : <EmptyState testID="archived-empty" title="Nothing archived" message="Panes you archive show up here." />
      }
      renderItem={({ item }) => (
        <ListRow
          testID={`archived-row-${item.id}`}
          leading={<Icon ios="archivebox" android="archive" size={20} />}
          title={item.name}
          subtitle={item.projectName}
          trailing={<Icon ios="trash" android="delete" size={18} color={theme.colors.danger} />}
          onPress={() => confirmDelete(item)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  loading: { padding: 20, gap: 12 },
});
