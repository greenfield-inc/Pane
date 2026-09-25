import { LegendList } from '@legendapp/list/react-native';
import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useDaemon, useInvokeQuery } from '@/daemon';
import { ConnectionStatus } from '@/features/hosts/ConnectionStatus';
import { useTheme } from '@/theme';
import { EmptyState, ErrorState, Icon, ListRow, Skeleton } from '@/ui';

// PLACEHOLDER: the pane-list feature replaces this screen (live agent
// status, favorites, grouping). It only proves routing and the data layer.
interface ProjectWithPanes {
  id: number;
  name: string;
  sessions?: Array<{ id: string; name: string; status?: string }>;
}

export default function PanesScreen() {
  const theme = useTheme();
  const { connection } = useDaemon();
  const projects = useInvokeQuery<ProjectWithPanes[]>('sessions:get-all-with-projects');
  const panes = (projects.data ?? []).flatMap(project =>
    (project.sessions ?? []).map(session => ({ ...session, projectName: project.name })));

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable testID="panes-new" accessibilityRole="button" accessibilityLabel="New pane" hitSlop={12} onPress={() => router.push('/pane/new')}>
              <Icon ios="plus" android="add" size={22} color={theme.colors.accentText} />
            </Pressable>
          ),
        }}
      />
      <LegendList
        testID="panes-list"
        data={panes}
        keyExtractor={pane => pane.id}
        estimatedItemSize={64}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.colors.background }}
        ListHeaderComponent={<View style={styles.header}><ConnectionStatus status={connection.status} /></View>}
        ListEmptyComponent={
          projects.isPending ? <LoadingRows />
            : projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
            : <EmptyState testID="panes-empty" title="No panes yet" message="Panes you create on this host show up here." />
        }
        renderItem={({ item }) => (
          <ListRow
            testID={`pane-row-${item.id}`}
            title={item.name}
            subtitle={item.projectName}
            trailing="chevron"
            onPress={() => router.push({ pathname: '/pane/[paneId]', params: { paneId: item.id } })}
          />
        )}
      />
    </>
  );
}

function LoadingRows() {
  return (
    <View style={styles.loading}>
      {[0, 1, 2, 3].map(index => (
        <View key={index} style={styles.loadingRow}>
          <Skeleton width="60%" height={16} />
          <Skeleton width="35%" height={12} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  loading: { padding: 16, gap: 20 },
  loadingRow: { gap: 8 },
});
