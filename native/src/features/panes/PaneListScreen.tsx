import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDaemon } from '@/daemon';
import { ConnectionStatus } from '@/features/hosts/ConnectionStatus';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { paneAgent, paneDisplayStatus } from './agentStatus';
import {
  useAgentStatuses,
  useArchivePane,
  useMarkPaneSeen,
  usePendingPermissions,
  useProjects,
  useToggleFavorite,
} from './hooks';
import { IconButton, LoadingRows, Notice, SectionHeader } from './PaneKit';
import { buildPaneList, type PaneListEntry, type PaneListItem } from './paneList';
import { PaneRow } from './PaneRow';
import { describePermission, pendingByPane } from './permissions';
import { StatusBadge } from './StatusBadge';

/** Home: the PWA's pane drawer as a full screen, plus search and permission requests. */
export function PaneListScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { connection } = useDaemon();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const projects = useProjects();
  const statuses = useAgentStatuses();
  const permissions = usePendingPermissions();
  const markSeen = useMarkPaneSeen();
  const toggleFavorite = useToggleFavorite();
  const archive = useArchivePane();

  const waiting = Object.values(pendingByPane(permissions.data ?? []));
  const blocked = new Set(waiting.map(request => request.sessionId));
  const items = buildPaneList(projects.data ?? [], query, {
    status: paneId => (blocked.has(paneId) ? 'blocked' : statuses.data ? paneDisplayStatus(statuses.data, paneId) : 'unknown'),
    agent: paneId => (statuses.data ? paneAgent(statuses.data, paneId) : undefined),
  });
  const paneNames = new Map((projects.data ?? []).flatMap(project => (project.sessions ?? []).map(session => [session.id, session.name])));
  // Wait for statuses too, so dots don't flip from "No agent" to their real status.
  const loading = projects.isPending || statuses.isPending;
  const divider = { borderColor: theme.colors.border };

  const confirmArchive = (pane: PaneListEntry) => {
    Alert.alert(`Archive “${pane.name}”?`, 'Its agents stop and its worktree is removed. You can still find it under Archived.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        style: 'destructive',
        onPress: () => archive(pane.id).catch((error: Error) => Alert.alert('Couldn’t archive the pane', error.message)),
      },
    ]);
  };

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([projects.refetch(), statuses.refetch(), permissions.refetch()]);
    setRefreshing(false);
  };

  const renderItem = ({ item, index }: { item: PaneListItem; index: number }) => item.type === 'section'
    ? (
      <SectionHeader
        title={item.title}
        first={index === 0 && waiting.length === 0}
        icon={item.projectId !== undefined ? <Icon ios="desktopcomputer" android="desktop_windows" size={14} /> : undefined}
        add={item.projectId !== undefined ? {
          label: `New pane in ${item.title}`,
          testID: `panes-new-${item.projectId}`,
          onPress: () => router.push({ pathname: '/pane/new', params: { projectId: String(item.projectId) } }),
        } : undefined}
      />
    )
    : (
      <PaneRow
        pane={item.pane}
        label={item.label}
        onOpen={() => {
          markSeen(item.pane.id);
          router.push({ pathname: '/pane/[paneId]', params: { paneId: item.pane.id } });
        }}
        onTogglePinned={() => toggleFavorite(item.pane.id).catch((error: Error) => Alert.alert('Couldn’t update pinned panes', error.message))}
        onArchive={() => confirmArchive(item.pane)}
      />
    );

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      {/* px-4 py-2 min-h-12 border-b: icon and title, then the actions. */}
      <View style={[styles.header, divider, { paddingTop: insets.top + 8 }]}>
        <View style={styles.brand}>
          <Icon ios="apple.terminal" android="terminal" size={20} color={theme.colors.accent} />
          <Text variant="headline" accessibilityRole="header" numberOfLines={1} style={styles.brandTitle}>Remote Pane</Text>
        </View>
        <ConnectionStatus status={connection.status} />
        <View style={styles.headerActions}>
          <IconButton label="Refresh remote sessions" testID="panes-refresh" onPress={() => void refresh()}>
            <RefreshIcon spinning={loading || refreshing} />
          </IconButton>
          <IconButton label="New pane" testID="panes-new" onPress={() => router.push('/pane/new')}>
            <Icon ios="plus" android="add" size={16} />
          </IconButton>
          <IconButton label="Settings" testID="open-settings" onPress={() => router.push('/settings')}>
            <Icon ios="gearshape" android="settings" size={16} />
          </IconButton>
        </View>
      </View>

      {/* Where the PWA shows its Remote Desktop link: p-3 border-b. */}
      <View style={[styles.toolbar, divider]}>
        <View style={[styles.search, { borderRadius: theme.radius.md, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised }]}>
          <Icon ios="magnifyingglass" android="search" size={16} />
          <TextInput
            testID="panes-search"
            accessibilityLabel="Search panes"
            placeholder="Search panes"
            placeholderTextColor={theme.colors.textMuted}
            selectionColor={theme.colors.accent}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            value={query}
            onChangeText={setQuery}
            style={[theme.typography.subhead, styles.searchInput, { color: theme.colors.text }]}
          />
          {query ? (
            <IconButton label="Clear search" testID="panes-search-clear" size={28} onPress={() => setQuery('')}>
              <Icon ios="xmark.circle.fill" android="cancel" size={16} />
            </IconButton>
          ) : null}
        </View>
      </View>

      <LegendList
        testID="panes-list"
        data={loading ? [] : items}
        keyExtractor={item => item.key}
        getItemType={item => item.type}
        estimatedItemSize={48}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 12 }]}
        ListHeaderComponent={waiting.length > 0 ? (
          <View>
            <SectionHeader title="Needs approval" first />
            {waiting.map(request => {
              const { title, target } = describePermission(request);
              return (
                <PermissionRow
                  key={request.id}
                  testID={`permission-row-${request.sessionId}`}
                  name={paneNames.get(request.sessionId) ?? 'Pane'}
                  detail={target ? `${title}: ${target}` : title}
                  onPress={() => router.push({ pathname: '/pane/[paneId]/permission', params: { paneId: request.sessionId, requestId: request.id } })}
                />
              );
            })}
          </View>
        ) : null}
        ListEmptyComponent={
          loading ? <LoadingRows />
            : projects.isError ? <Notice danger message={projects.error.message} action={{ title: 'Try again', onPress: () => void projects.refetch() }} />
            : query && (projects.data ?? []).length > 0 ? <Notice testID="panes-no-results" message={`No panes match “${query}”.`} />
            : <Notice testID="panes-empty" message="No remote panes found on this host." />
        }
        ListFooterComponent={projects.isSuccess ? <ArchivedLink /> : null}
        renderItem={renderItem}
      />
    </View>
  );
}

/** The drawer's refresh icon, spinning while the list loads. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    if (spinning) {
      rotation.value = 0;
      rotation.value = withRepeat(withTiming(360, { duration: 1000, easing: Easing.linear }), -1, false);
    } else if (rotation.value % 360 !== 0) {
      // Finish the turn instead of snapping back.
      cancelAnimation(rotation);
      rotation.value = withTiming(360, { duration: ((360 - (rotation.value % 360)) / 360) * 1000, easing: Easing.linear });
    }
  }, [spinning, rotation]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={spin}>
      <Icon ios="arrow.clockwise" android="refresh" size={16} />
    </Animated.View>
  );
}

function PermissionRow({ name, detail, onPress, testID }: { name: string; detail: string; onPress: () => void; testID: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.permissionRow, { borderRadius: theme.radius.md, backgroundColor: pressed ? theme.colors.selected : theme.colors.background }]}
    >
      <StatusBadge status="blocked" />
      <View style={styles.fill}>
        <Text variant="callout" numberOfLines={1}>{name}</Text>
        <Text variant="footnote" tone="muted" numberOfLines={2}>{detail}</Text>
      </View>
      <Icon ios="chevron.right" android="chevron_right" size={14} />
    </Pressable>
  );
}

/** Styled like the PWA's Remote Desktop link. */
function ArchivedLink() {
  const theme = useTheme();
  return (
    <Pressable
      testID="panes-archived"
      accessibilityRole="button"
      accessibilityLabel="Archived"
      onPress={() => router.push('/archived')}
      style={({ pressed }) => [styles.archived, {
        borderRadius: theme.radius.md,
        borderColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised,
      }]}
    >
      <Icon ios="archivebox" android="archive" size={16} />
      <Text variant="callout" tone="secondary" style={styles.fill}>Archived</Text>
      <Icon ios="chevron.right" android="chevron_right" size={14} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1 },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandTitle: { flexShrink: 1, fontSize: 18, lineHeight: 28 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  toolbar: { padding: 12, borderBottomWidth: 1 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingLeft: 12, paddingRight: 6, borderWidth: 1 },
  searchInput: { flex: 1, height: '100%', paddingVertical: 0 },
  content: { padding: 12 },
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, marginBottom: 4 },
  archived: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1 },
});
