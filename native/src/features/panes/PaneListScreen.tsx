import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDaemon } from '@/daemon';
import { ConnectionStatus } from '@/features/hosts/ConnectionStatus';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { useSessions, useUpdateSession } from '../sessions/hooks';
import { paneAgent, paneDisplayStatus } from './agentStatus';
import {
  useAgentStatuses,
  useArchivedProjects,
  useArchivePane,
  useDeleteArchivedPane,
  useMarkPaneSeen,
  usePendingPermissions,
  useProjects,
  useRestorePane,
  useToggleFavorite,
} from './hooks';
import { IconButton, LoadingRows, Notice, SectionHeader } from './PaneKit';
import { buildSidebar, type PaneListEntry, type SidebarItem } from './paneList';
import { PaneRow } from './PaneRow';
import { describePermission, pendingByPane } from './permissions';
import { ArchivedRow, SessionRow, SidebarNote, SidebarSectionHeader } from './SidebarRows';
import { useSidebarSections } from './sidebarSections';
import { StatusBadge } from './StatusBadge';

/**
 * Home: the PWA's drawer as a full screen. Pinned, Sessions, Repositories and
 * Archived, plus search and permission requests.
 */
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
  const sessions = useSessions();
  const updateSession = useUpdateSession();
  const expanded = useSidebarSections(state => state.expanded);
  const toggleSection = useSidebarSections(state => state.toggle);
  const archived = useArchivedProjects(expanded.archived);
  const restorePane = useRestorePane();
  const deleteArchivedPane = useDeleteArchivedPane();
  const [collapsedSessions, setCollapsedSessions] = useState<ReadonlySet<string>>(new Set());

  const waiting = Object.values(pendingByPane(permissions.data ?? []));
  const blocked = new Set(waiting.map(request => request.sessionId));
  const items = buildSidebar({
    projects: projects.data ?? [],
    sessions: sessions.unavailable ? 'unavailable' : sessions.data?.sessions ?? (sessions.isError ? [] : undefined),
    sessionsError: sessions.isError && !sessions.unavailable ? sessions.error.message : undefined,
    archivedProjects: archived.data ?? (archived.isError ? [] : undefined),
    expanded,
    collapsedSessions,
    query,
    lookup: {
      status: paneId => (blocked.has(paneId) ? 'blocked' : statuses.data ? paneDisplayStatus(statuses.data, paneId) : 'unknown'),
      agent: paneId => (statuses.data ? paneAgent(statuses.data, paneId) : undefined),
    },
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

  const confirmDelete = (pane: { id: string; label: string }) => {
    Alert.alert(`Delete “${pane.label}”?`, 'This removes the pane and its history from the host for good.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteArchivedPane(pane.id).catch((error: Error) => Alert.alert('Couldn’t delete the pane', error.message)),
      },
    ]);
  };

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      projects.refetch(),
      statuses.refetch(),
      permissions.refetch(),
      sessions.refetch(),
      expanded.archived ? archived.refetch() : undefined,
    ]);
    setRefreshing(false);
  };

  const renderItem = ({ item, index }: { item: SidebarItem; index: number }) => {
    switch (item.type) {
      case 'section':
        return <SidebarSectionHeader item={item} first={index === 0 && waiting.length === 0} onToggle={() => toggleSection(item.section)} />;
      case 'repo':
        return (
          <SectionHeader
            title={item.title}
            // Flush under the Repositories header, spaced like the PWA's `pb-2` groups after that.
            first={items[index - 1]?.type === 'section'}
            icon={<Icon ios="desktopcomputer" android="desktop_windows" size={14} />}
            add={{
              label: `New pane in ${item.title}`,
              testID: `panes-new-${item.projectId}`,
              onPress: () => router.push({ pathname: '/pane/new', params: { projectId: String(item.projectId) } }),
            }}
          />
        );
      case 'pane':
        return (
          <View style={item.nested ? [styles.nested, divider] : undefined}>
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
          </View>
        );
      case 'session':
        return (
          <SessionRow
            item={item}
            onOpen={() => router.push({ pathname: '/session/[sessionId]', params: { sessionId: item.session.id } })}
            onToggleNested={() => setCollapsedSessions(current => toggleMember(current, item.nestedKey))}
            onTogglePinned={() => updateSession(item.session.id, { isPinned: !item.session.isPinned })
              .catch((error: Error) => Alert.alert('Couldn’t update the Session pin', error.message))}
            // Desktop archives Sessions without asking; Restore brings them back.
            onArchive={() => updateSession(item.session.id, { archived: true })
              .catch((error: Error) => Alert.alert('Couldn’t archive the Session', error.message))}
          />
        );
      case 'archived':
        return item.kind === 'session' ? (
          <ArchivedRow
            item={item}
            onRestore={() => updateSession(item.id, { archived: false }).catch((error: Error) => Alert.alert('Couldn’t restore the Session', error.message))}
          />
        ) : (
          <ArchivedRow
            item={item}
            onRestore={() => restorePane(item.id).catch((error: Error) => Alert.alert('Couldn’t restore the pane', error.message))}
            onDelete={() => confirmDelete(item)}
          />
        );
      case 'note':
        return item.danger
          ? <Notice danger message={item.text} action={{ title: 'Try again', onPress: () => void sessions.refetch() }} />
          : <SidebarNote testID={item.key} text={item.text} />;
    }
  };

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
          <IconButton label="Settings" testID="open-settings" onPress={() => router.push('/settings')}>
            <Icon ios="gearshape" android="settings" size={16} />
          </IconButton>
        </View>
      </View>

      {/* The PWA's create buttons and, where it shows its Remote Desktop link, search: p-3 border-b. */}
      <View style={[styles.toolbar, divider]}>
        <View style={styles.createButtons}>
          {sessions.unavailable ? null : (
            <CreateButton testID="sessions-new" title="New Session" onPress={() => router.push('/session/new')}>
              <Icon ios="bubble.left" android="chat_bubble" size={16} color={theme.colors.onAccent} />
            </CreateButton>
          )}
          <CreateButton testID="panes-new" title="New Pane" disabled={(projects.data ?? []).length === 0} onPress={() => router.push('/pane/new')}>
            <Icon ios="plus" android="add" size={16} color={theme.colors.onAccent} />
          </CreateButton>
        </View>
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

/** The PWA's `min-h-11 flex-1 rounded-md bg-interactive` create button. */
function CreateButton({ title, onPress, disabled, testID, children }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.createButton, {
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.accent,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      }]}
    >
      {children}
      <Text variant="callout" tone="onAccent" style={styles.bold}>{title}</Text>
    </Pressable>
  );
}

function toggleMember(current: ReadonlySet<string>, member: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(member)) next.delete(member);
  else next.add(member);
  return next;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1 },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandTitle: { flexShrink: 1, fontSize: 18, lineHeight: 28 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  toolbar: { padding: 12, gap: 8, borderBottomWidth: 1 },
  createButtons: { flexDirection: 'row', gap: 8 },
  createButton: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12 },
  bold: { fontWeight: '600' },
  // ml-5 border-l pl-2 under the Session row.
  nested: { marginLeft: 20, paddingLeft: 8, borderLeftWidth: 1 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingLeft: 12, paddingRight: 6, borderWidth: 1 },
  searchInput: { flex: 1, height: '100%', paddingVertical: 0 },
  content: { padding: 12 },
  permissionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, marginBottom: 4 },
});
