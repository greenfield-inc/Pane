import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDaemon } from '@/daemon';
import { DemoBadge } from '@/features/demo/DemoBadge';
import { ConnectionBar, Dimmed, presenceLabel } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { MachineChips } from '@/features/machines/MachineChips';
import { MachineMark } from '@/features/machines/MachineMark';
import { PaneLogo } from '@/features/machines/PaneLogo';
import { useMachines } from '@/features/machines/useMachines';
import { useNotifyShared } from '@/features/notify/hooks';
import { waitingQuestions } from '@/features/notify/notifyQuestions';
import { openNotifySheet } from '@/features/notify/NotifySheet';
import { useTheme, withAlpha } from '@/theme';
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
 * Home: the Pane logo and a chip per machine, then Pinned, Sessions, Repositories and Archived,
 * with search and one card of what's waiting on you (permission requests and Notify questions).
 */
export function PaneListScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { profile } = useDaemon();
  const machines = useMachines();
  const current = machines.find(machine => machine.current);
  const { presence, notice, retry } = useConnectionPresence();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const projects = useProjects();
  const statuses = useAgentStatuses();
  const permissions = usePendingPermissions();
  const notify = useNotifyShared();
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
  const questions = waitingQuestions(notify.data);
  const blocked = new Set([...waiting.map(request => request.sessionId), ...questions.flatMap(item => item.source.paneId ?? [])]);
  const items = buildSidebar({
    projects: projects.data ?? [],
    sessions: sessions.unavailable ? 'unavailable' : sessions.data?.sessions ?? (sessions.isError ? [] : undefined),
    sessionsError: sessions.isError && !sessions.unavailable ? sessions.error.message : undefined,
    archivedProjects: archived.data,
    archivedError: archived.isError ? archived.error.message : undefined,
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
  const waitingCount = waiting.length + questions.length;

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
      notify.refetch(),
      sessions.refetch(),
      expanded.archived ? archived.refetch() : undefined,
    ]);
    setRefreshing(false);
  };

  const renderItem = ({ item, index }: { item: SidebarItem; index: number }) => {
    switch (item.type) {
      case 'section':
        return <SidebarSectionHeader item={item} first={index === 0 && waitingCount === 0} onToggle={() => toggleSection(item.section)} />;
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
          ? <Notice danger message={item.text} action={{ title: 'Try again', onPress: () => void (item.retry === 'archived' ? archived.refetch() : sessions.refetch()) }} />
          : <SidebarNote testID={item.key} text={item.text} />;
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <View
          // Flows wait on the connection through this id.
          testID={`connection-status-${presence}`}
          style={styles.brand}
          accessible
          accessibilityRole="header"
          accessibilityLabel={`Pane on ${profile.label}`}
        >
          <PaneLogo />
          <Text variant="title" numberOfLines={1} style={styles.brandTitle}>Pane</Text>
        </View>
        {/* With one machine there are no chips, so its mark and name sit here. */}
        {machines.length > 1 || !current ? null : (
          <View style={styles.machine} accessible accessibilityLabel={presenceLabel(presence, current.name)}>
            <MachineMark os={current.os} slot={current.slot} state={current.state} />
            <Text variant="footnote" tone="secondary" numberOfLines={1}>{current.name}</Text>
          </View>
        )}
        <DemoBadge />
        <Pressable
          testID="open-settings"
          accessibilityRole="button"
          accessibilityLabel="Settings"
          hitSlop={4}
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.roundButton, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
        >
          <Icon ios="gearshape" android="settings" size={17} color={theme.colors.text} />
        </Pressable>
      </View>
      {machines.length > 1 ? <MachineChips machines={machines} /> : null}
      <ConnectionBar notice={notice} onRetry={retry} />

      {/* The last screen stays, dimmed and untouchable, while the machine isn't connected. The chips
          above stay live, so you can switch away from a machine that is down. */}
      <Dimmed dimmed={presence !== 'connected'} style={styles.fill}>
        <View style={styles.toolbar}>
          <View style={styles.createButtons}>
            {sessions.unavailable ? null : (
              <CreateButton testID="sessions-new" title="New Session" secondary onPress={() => router.push('/session/new')}>
                <Icon ios="bubble.left" android="chat_bubble" size={16} color={theme.colors.text} />
              </CreateButton>
            )}
            <CreateButton testID="panes-new" title="New Pane" disabled={(projects.data ?? []).length === 0} onPress={() => router.push('/pane/new')}>
              <Icon ios="plus" android="add" size={16} color={theme.colors.onAccent} />
            </CreateButton>
          </View>
          <View style={[styles.search, { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceRaised }]}>
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
              style={[theme.typography.body, styles.searchInput, { color: theme.colors.text }]}
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
          ListHeaderComponent={waitingCount > 0 ? (
            <View style={styles.waitingSection}>
              <SectionHeader title="Waiting on you" count={waitingCount} first />
              <View style={[styles.waitingCard, { borderRadius: theme.radius.card, backgroundColor: withAlpha(theme.colors.warning, 0.09) }]}>
                {questions.map((item, index) => (
                  <WaitingRow
                    key={item.id}
                    testID={`notify-row-${item.id}`}
                    name={item.source.name}
                    detail={item.title}
                    divided={index > 0}
                    onPress={() => openNotifySheet(item.id, item.source.paneId)}
                  />
                ))}
                {waiting.map((request, index) => {
                  const { title, target } = describePermission(request);
                  return (
                    <WaitingRow
                      key={request.id}
                      testID={`permission-row-${request.sessionId}`}
                      name={paneNames.get(request.sessionId) ?? 'Pane'}
                      detail={target ? `${title}: ${target}` : title}
                      divided={questions.length + index > 0}
                      onPress={() => router.push({ pathname: '/pane/[paneId]/permission', params: { paneId: request.sessionId, requestId: request.id } })}
                    />
                  );
                })}
              </View>
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
      </Dimmed>
    </View>
  );
}

/** A permission request or Notify question waiting on this phone's owner. */
function WaitingRow({ name, detail, divided, onPress, testID }: { name: string; detail: string; divided: boolean; onPress: () => void; testID: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.waitingRow, pressed && { backgroundColor: theme.colors.surfacePressed }]}
    >
      {divided ? <View style={[styles.waitingDivider, { backgroundColor: theme.colors.border }]} /> : null}
      <StatusBadge status="blocked" />
      <View style={styles.fill}>
        <Text variant="callout" numberOfLines={1} style={styles.bold}>{name}</Text>
        <Text variant="footnote" tone="muted" numberOfLines={2}>{detail}</Text>
      </View>
      <Icon ios="chevron.right" android="chevron_right" size={14} />
    </Pressable>
  );
}

/** A create button: New Pane filled with the accent, New Session quieter beside it. */
function CreateButton({ title, onPress, disabled, secondary, testID, children }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
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
        borderRadius: theme.radius.lg,
        backgroundColor: secondary ? theme.colors.surfaceRaised : theme.colors.accent,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      }]}
    >
      {children}
      <Text variant="callout" tone={secondary ? 'primary' : 'onAccent'} numberOfLines={1} maxFontSizeMultiplier={1.6} style={[styles.bold, styles.shrink]}>{title}</Text>
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, paddingBottom: 10 },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandTitle: { flexShrink: 1, fontSize: 21, letterSpacing: -0.2, fontWeight: '700' },
  machine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  roundButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  toolbar: { paddingHorizontal: 16, paddingBottom: 4, gap: 10 },
  createButtons: { flexDirection: 'row', gap: 10 },
  createButton: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12 },
  bold: { fontWeight: '600' },
  // ml-5 border-l pl-2 under the Session row.
  nested: { marginLeft: 20, paddingLeft: 8, borderLeftWidth: 1 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingLeft: 12, paddingRight: 6 },
  searchInput: { flex: 1, paddingVertical: 8 },
  shrink: { flexShrink: 1 },
  content: { padding: 12 },
  waitingSection: { marginBottom: 12 },
  waitingCard: { overflow: 'hidden' },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 10 },
  waitingDivider: { position: 'absolute', top: 0, left: 33, right: 0, height: StyleSheet.hairlineWidth },
});
