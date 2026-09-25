import { LegendList } from '@legendapp/list/react-native';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { ConnectionStatus } from '@/features/hosts/ConnectionStatus';
import { useTheme } from '@/theme';
import { Button, EmptyState, ErrorState, Icon, ListRow, ListSection, Skeleton, Text } from '@/ui';

import { paneAgent, paneDisplayStatus } from './agentStatus';
import {
  useAgentStatuses,
  useArchivePane,
  useMarkPaneSeen,
  usePendingPermissions,
  useProjects,
  useToggleFavorite,
} from './hooks';
import { buildPaneList, type PaneListEntry, type PaneListItem } from './paneList';
import { PaneRow } from './PaneRow';
import { describePermission, pendingByPane } from './permissions';
import { StatusBadge } from './StatusBadge';

export function PaneListScreen() {
  const theme = useTheme();
  const { connection } = useDaemon();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const projects = useProjects();
  const statuses = useAgentStatuses();
  const permissions = usePendingPermissions();
  const markSeen = useMarkPaneSeen();
  const toggleFavorite = useToggleFavorite();
  const archive = useArchivePane();

  const waiting = pendingByPane(permissions.data ?? []);
  const items = buildPaneList(projects.data ?? [], query, {
    status: paneId => (waiting[paneId] ? 'blocked' : statuses.data ? paneDisplayStatus(statuses.data, paneId) : 'unknown'),
    agent: paneId => (statuses.data ? paneAgent(statuses.data, paneId) : undefined),
  });
  const paneNames = new Map((projects.data ?? []).flatMap(project => (project.sessions ?? []).map(session => [session.id, session.name])));
  const hasPanes = (projects.data ?? []).some(project => project.sessions?.some(session => !session.archived && !session.isHidden));

  const confirmArchive = (pane: PaneListEntry) => {
    Alert.alert(`Archive “${pane.name}”?`, 'Its agents stop and its worktree is removed. You can still find it under Archived.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        style: 'destructive',
        onPress: () => archive.mutate([pane.id], {
          onError: error => Alert.alert('Couldn’t archive the pane', error.message),
        }),
      },
    ]);
  };

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([projects.refetch(), statuses.refetch(), permissions.refetch()]);
    setRefreshing(false);
  };

  const renderItem = ({ item }: { item: PaneListItem }) => item.type === 'section'
    ? <Text variant="footnote" tone="muted" style={styles.sectionTitle}>{item.title.toUpperCase()}</Text>
    : (
      <PaneRow
        pane={item.pane}
        position={item.position}
        showProject={item.inFavorites}
        onOpen={() => markSeen(item.pane.id)}
        onToggleFavorite={() => toggleFavorite(item.pane.id)}
        onArchive={() => confirmArchive(item.pane)}
      />
    );

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: 'Search panes',
            onChangeText: event => setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          },
          headerRight: () => (
            <Pressable testID="panes-new" accessibilityRole="button" accessibilityLabel="New pane" hitSlop={12} onPress={() => router.push('/pane/new')}>
              <Icon ios="plus" android="add" size={22} color={theme.colors.accentText} />
            </Pressable>
          ),
        }}
      />
      <LegendList
        testID="panes-list"
        data={items}
        keyExtractor={item => item.key}
        getItemType={item => item.type}
        estimatedItemSize={60}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        style={{ backgroundColor: theme.colors.background }}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.connection}><ConnectionStatus status={connection.status} /></View>
            {Object.values(waiting).length > 0 ? (
              <View style={styles.inset}>
                <ListSection title="Needs approval">
                  {Object.values(waiting).map(request => {
                    const { title, target } = describePermission(request);
                    return (
                      <ListRow
                        key={request.id}
                        testID={`permission-row-${request.sessionId}`}
                        leading={<StatusBadge status="blocked" />}
                        title={paneNames.get(request.sessionId) ?? 'Pane'}
                        subtitle={target ? `${title}: ${target}` : title}
                        trailing="chevron"
                        onPress={() => router.push({ pathname: '/pane/[paneId]/permission', params: { paneId: request.sessionId, requestId: request.id } })}
                      />
                    );
                  })}
                </ListSection>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          projects.isPending ? <LoadingRows />
            : projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
            : hasPanes ? <EmptyState testID="panes-no-results" title="No matches" message={`No pane matches “${query}”.`} />
            : (
              <EmptyState
                testID="panes-empty"
                title="No panes yet"
                message="Start an agent on one of this host’s repositories."
                action={<Button testID="panes-empty-new" title="New pane" onPress={() => router.push('/pane/new')} />}
              />
            )
        }
        ListFooterComponent={
          projects.isSuccess ? (
            <View style={[styles.inset, styles.footer]}>
              <ListSection>
                <ListRow
                  testID="panes-archived"
                  leading={<Icon ios="archivebox" android="archive" size={20} color={theme.colors.accentText} />}
                  title="Archived"
                  trailing="chevron"
                  onPress={() => router.push('/archived')}
                />
              </ListSection>
            </View>
          ) : null
        }
        renderItem={renderItem}
      />
    </>
  );
}

function LoadingRows() {
  return (
    <View style={styles.loading}>
      {[0, 1, 2, 3].map(index => (
        <View key={index} style={styles.loadingRow}>
          <Skeleton width={22} height={22} radius={11} />
          <View style={styles.loadingText}>
            <Skeleton width="60%" height={16} />
            <Skeleton width="35%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  header: { gap: 16, paddingBottom: 4 },
  connection: { paddingHorizontal: 20 },
  inset: { paddingHorizontal: 16 },
  footer: { paddingTop: 28 },
  sectionTitle: { paddingHorizontal: 32, paddingTop: 24, paddingBottom: 6 },
  loading: { padding: 20, gap: 24 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  loadingText: { flex: 1, gap: 8 },
});
