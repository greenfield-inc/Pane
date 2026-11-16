import { LegendList } from '@legendapp/list/react-native';
import { router, useIsFocused } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { buildAllMachinesList, type RecentRow } from '@/features/allMachines/allMachinesList';
import { AllMachinesNotes, allOffline, offlineAlert, openRecentRow, openWaitingRow, RecentRowView, waitingRowText } from '@/features/allMachines/AllMachinesRows';
import { ApprovalGroups } from '@/features/approvals/ApprovalGroups';
import { sessionKey, waitingCounts } from '@/features/approvals/approvals';
import { approvalRowSpoken, ApprovalRowLines } from '@/features/approvals/ApprovalRowLines';
import { AutopilotRow } from '@/features/autopilot/AutopilotRow';
import { useAutopilot } from '@/features/autopilot/hooks';
import { DemoBadge } from '@/features/demo/DemoBadge';
import { ConnectionBar, Dimmed } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { MachineChips } from '@/features/machines/MachineChips';
import { PaneLogo } from '@/features/machines/PaneLogo';
import { AgentPromptActions } from '@/features/notify/AgentPromptActions';
import { useArchivedProjects } from '@/features/panes/hooks';
import { LoadingRows, Notice } from '@/features/panes/PaneKit';
import { buildSidebar, type SidebarItem, type SidebarSection } from '@/features/panes/paneList';
import { PaneRow } from '@/features/panes/PaneRow';
import { SidebarItemView, toggleMember, type SidebarItemContext } from '@/features/panes/SidebarItemView';
import { useSidebarSections } from '@/features/panes/sidebarSections';
import { usePaneActions } from '@/features/panes/usePaneActions';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

import { ActivityRow, ApprovalRow, BoardHeader, Card, EmptyCard, GroupRow, HistoryLine, RowDivider } from './BoardRows';
import { useBoardTile } from './boardTile';
import { bottomBarHeight, HomeBottomBar } from './HomeBottomBar';
import { boardCounts, PINNED_PREVIEW, tilePanes, type PaneRecentRow } from './statusBoard';
import { StatusTiles } from './StatusTiles';
import { useHomeFeeds } from './useHomeData';

/** A row of home's list: a Working or Ready Pane, one of All machines' rows, or a search result. */
type HomeRow =
  | { kind: 'activity'; key: string; row: PaneRecentRow; first: boolean; last: boolean }
  | { kind: 'recent'; key: string; row: RecentRow }
  | { kind: 'sidebar'; key: string; item: SidebarItem; previous: SidebarItem | undefined; first: boolean };

const SECTION_ROWS: ReadonlyArray<{ section: Exclude<SidebarSection, 'pinned'>; title: string; icon: Pick<IconProps, 'ios' | 'android'> }> = [
  { section: 'sessions', title: 'Sessions', icon: { ios: 'bubble.left', android: 'chat_bubble' } },
  { section: 'repositories', title: 'Repositories', icon: { ios: 'folder', android: 'folder' } },
  { section: 'archived', title: 'Archived', icon: { ios: 'archivebox', android: 'archive' } },
];

/**
 * Home, a status board: the Pane logo and a pill per machine, then four tiles counting what needs
 * you, what's working, what's ready and every Pane. The selected tile lists those below it: Needs you
 * holds Autopilot and the approvals, with Stale and Done today in one line that opens History; All
 * panes holds Pinned and the rows that open Sessions, Repositories and Archived. Search and + sit in a
 * bottom bar. With All selected the tiles sum every saved machine and rows carry their machine's mark.
 */
export function HomeScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { presence, notice, retry } = useConnectionPresence();
  const home = useHomeFeeds({ active: focused, unreachable: presence === 'unreachable', retry });
  const { here, all, feeds, chipMachines, current } = home;
  const profile = here.profile;
  const autopilot = useAutopilot();
  const actions = usePaneActions();
  const tile = useBoardTile(state => state.tile);
  const selectTile = useBoardTile(state => state.select);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [collapsedSessions, setCollapsedSessions] = useState<ReadonlySet<string>>(new Set());
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const expanded = useSidebarSections(state => state.expanded);
  const toggleSection = useSidebarSections(state => state.toggle);
  const searching = query.trim().length > 0;
  // Archived's count shows on the All panes tile; search covers it while its section is open.
  const archived = useArchivedProjects(!all && ((tile === 'all' && !searching) || (searching && expanded.archived)));

  const board = buildAllMachinesList(feeds, '');
  const loading = all ? feeds.every(feed => !feed.snapshot && feed.offlineSince === undefined && feed.error === undefined) : here.loading;
  const counts = loading ? undefined : boardCounts(board);
  const machineOf = (key: string) => chipMachines.find(machine => machine.key === key);
  // On All, rows carry their machine's mark.
  const markOf = (key: string) => (all ? machineOf(key) : undefined);
  const sayOffline = offlineAlert(feeds, chipMachines);
  const waitingBySession = waitingCounts(board.waiting).bySession;
  // The machine the phone is on, as Pinned, Sessions, Repositories and Archived list it.
  const statusOf = new Map(board.recent.flatMap(row => (row.type === 'pane' && row.machineKey === profile.id ? [[row.pane.id, row.pane] as const] : [])));
  const sidebar = (sidebarQuery: string, sections: Record<SidebarSection, boolean>) => buildSidebar({
    projects: here.projects.data ?? [],
    sessions: here.sessions.unavailable ? 'unavailable' : here.sessions.data?.sessions ?? (here.sessions.isError ? [] : undefined),
    sessionsError: here.sessions.isError && !here.sessions.unavailable ? here.sessions.error.message : undefined,
    archivedProjects: archived.data,
    archivedError: archived.isError ? archived.error.message : undefined,
    expanded: sections,
    collapsedSessions,
    query: sidebarQuery,
    lookup: {
      status: paneId => statusOf.get(paneId)?.status ?? 'unknown',
      agent: paneId => statusOf.get(paneId)?.agent,
    },
  });
  const sidebarContext = (background?: string): SidebarItemContext => ({
    actions,
    background,
    waitingFor: sessionId => waitingBySession.get(sessionKey(profile.id, sessionId)) ?? 0,
    onToggleSection: toggleSection,
    onToggleNested: nestedKey => setCollapsedSessions(currentSet => toggleMember(currentSet, nestedKey)),
    retry: what => void (what === 'archived' ? archived.refetch() : here.sessions.refetch()),
  });

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([home.refetch(), autopilot.refetch(), archived.isFetched ? archived.refetch() : undefined]);
    setRefreshing(false);
  };

  // What the list holds below its header.
  const rows: HomeRow[] = (() => {
    if (loading) return [];
    if (searching) {
      if (all) return buildAllMachinesList(feeds, query).recent.map(row => ({ kind: 'recent', key: row.key, row }));
      const items = sidebar(query, expanded);
      return items.map((item, index) => ({ kind: 'sidebar', key: item.key, item, previous: items[index - 1], first: index === 0 }));
    }
    if (tile === 'working' || tile === 'ready') {
      const panes = tilePanes(board.recent, tile);
      return panes.map((row, index) => ({ kind: 'activity', key: row.key, row, first: index === 0, last: index === panes.length - 1 }));
    }
    if (tile === 'all' && all) return board.recent.map(row => ({ kind: 'recent', key: row.key, row }));
    return [];
  })();

  const renderRow = ({ item }: { item: HomeRow }) => {
    switch (item.kind) {
      case 'activity': {
        const swipes = item.row.machineKey === profile.id && !item.row.stale;
        const radius = theme.radius.card;
        return (
          <View style={[
            styles.cardRow,
            { backgroundColor: theme.colors.surfaceRaised },
            item.first && { borderTopLeftRadius: radius, borderTopRightRadius: radius },
            item.last && { borderBottomLeftRadius: radius, borderBottomRightRadius: radius },
          ]}>
            <ActivityRow
              row={item.row}
              machine={markOf(item.row.machineKey)}
              divided={!item.first}
              onPress={() => openRecentRow(item.row, profile.id, actions, sayOffline)}
              swipe={swipes ? {
                onTogglePinned: () => actions.togglePanePinned(item.row.pane.id),
                onArchive: () => actions.archivePane(item.row.pane),
                onTogglePaused: () => actions.setPanePaused(item.row.pane.id, !item.row.pane.paused),
              } : undefined}
            />
          </View>
        );
      }
      case 'recent':
        return (
          <View style={styles.below}>
            <RecentRowView row={item.row} machine={machineOf(item.row.machineKey)} currentKey={profile.id} actions={actions} onOpen={() => openRecentRow(item.row, profile.id, actions, sayOffline)} />
          </View>
        );
      case 'sidebar':
        return (
          <View style={styles.below}>
            <SidebarItemView item={item.item} previous={item.previous} first={item.first} context={sidebarContext()} />
          </View>
        );
    }
  };

  // Needs you: Autopilot, the approvals in the chosen sort, then the line that opens History.
  const autopilotSnapshot = autopilot.data?.enabled ? autopilot.data : undefined;
  const needsYou = (
    <>
      {autopilotSnapshot ? <View style={styles.autopilot}><AutopilotRow snapshot={autopilotSnapshot} /></View> : null}
      <BoardHeader
        testID="approvals-header"
        title="Needs you"
        count={counts?.needs}
        right={(
          <Pressable
            testID="approvals-sort"
            accessibilityRole="button"
            accessibilityLabel="Sort approvals"
            hitSlop={8}
            onPress={() => router.push('/sort-approvals')}
            style={({ pressed }) => [styles.sortButton, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
          >
            <Icon ios="arrow.up.arrow.down" android="swap_vert" size={14} color={theme.colors.textSecondary} />
          </Pressable>
        )}
      />
      {board.waiting.length + board.offline.length > 0 ? (
        <ApprovalGroups
          entries={board.waiting}
          offline={board.offline}
          machineOf={machineOf}
          renderEntry={(row, divided, list) => {
            const { title, detail } = waitingRowText(row);
            const id = row.type === 'question' ? `notify-row-${row.item.id}` : `permission-row-${row.request.sessionId}`;
            const machine = machineOf(row.machineKey);
            return (
              <>
                <ApprovalRow
                  testID={id}
                  title={title}
                  detail={detail}
                  below={row.type === 'question' ? <ApprovalRowLines item={row.item} testID={id} /> : undefined}
                  spoken={row.type === 'question' ? approvalRowSpoken(row.item) : undefined}
                  at={row.at}
                  machine={markOf(row.machineKey)}
                  stale={row.stale}
                  done={list === 'agent' || !row.waiting}
                  divided={divided}
                  onPress={() => openWaitingRow(row, list, profile.id)}
                />
                {row.type === 'question' && row.item.state === 'waiting' ? (
                  <AgentPromptActions item={row.item} inset={33} machine={row.machineKey === profile.id ? null : machine?.profile ?? null} />
                ) : null}
              </>
            );
          }}
        />
      ) : (
        <EmptyCard testID="approvals-empty" title="Nothing needs you" detail="Questions and permission requests from your agents land here." />
      )}
      <HistoryLine stale={board.staleQuestions.length} done={board.answered.length} onPress={() => router.push('/history')} />
    </>
  );

  // All panes on one machine: Pinned in place, then rows that open Sessions, Repositories and Archived.
  const pinnedItems = (() => {
    const items = sidebar('', { pinned: true, sessions: false, repositories: false, archived: false });
    const end = items.findIndex((item, index) => index > 0 && item.type === 'section');
    return items[0]?.type === 'section' && items[0].section === 'pinned' ? items.slice(1, end === -1 ? undefined : end) : [];
  })();
  // Count and preview what is pinned: a pinned Session brings its nested Panes along.
  const isPinnedItem = (item: SidebarItem) => !(item.type === 'pane' && item.nested);
  const pinnedCount = pinnedItems.filter(isPinnedItem).length;
  const previewEnd = pinnedItems.findIndex((item, index) => isPinnedItem(item) && pinnedItems.slice(0, index).filter(isPinnedItem).length === PINNED_PREVIEW);
  const shownPinned = pinnedExpanded || previewEnd === -1 ? pinnedItems : pinnedItems.slice(0, previewEnd);
  const sessionCount = here.sessions.data?.sessions.filter(session => !session.archived).length;
  const archivedCount = archived.data
    ? archived.data.reduce((sum, project) => sum + (project.sessions ?? []).length, 0) + (here.sessions.data?.sessions.filter(session => session.archived).length ?? 0)
    : undefined;
  const allPanes = (
    <>
      {here.projects.isError ? <Notice danger message={here.projects.error.message} action={{ title: 'Try again', onPress: () => void here.projects.refetch() }} /> : null}
      {(here.projects.data ?? []).length === 0 && !here.projects.isError ? <Notice testID="panes-empty" message="No remote panes found on this host." /> : null}
      {pinnedItems.length > 0 ? (
        <Card testID="home-pinned" style={styles.cardGap}>
          <GroupRow testID="sidebar-section-pinned" icon={{ ios: 'pin', android: 'push_pin' }} title="Pinned" count={pinnedCount} open={expanded.pinned} onPress={() => toggleSection('pinned')} />
          {expanded.pinned ? shownPinned.map((item, index) => (
            <View key={item.key}>
              {index === 0 ? <View style={[styles.hairline, { backgroundColor: theme.colors.border }]} /> : <RowDivider inset={36} />}
              {item.type === 'pane' && !item.nested ? (
                <PaneRow
                  pane={item.pane}
                  label={item.pane.name}
                  detail={item.pane.projectName}
                  background={theme.colors.surfaceRaised}
                  onOpen={() => actions.openPane(item.pane.id)}
                  onTogglePinned={() => actions.togglePanePinned(item.pane.id)}
                  onArchive={() => actions.archivePane(item.pane)}
                  onTogglePaused={() => actions.setPanePaused(item.pane.id, !item.pane.paused)}
                />
              ) : <SidebarItemView item={item} previous={undefined} first={false} context={sidebarContext(theme.colors.surfaceRaised)} />}
            </View>
          )) : null}
          {expanded.pinned && pinnedCount > PINNED_PREVIEW ? (
            <Pressable testID="home-pinned-more" accessibilityRole="button" hitSlop={4} onPress={() => setPinnedExpanded(!pinnedExpanded)} style={styles.more}>
              <Text variant="subhead" tone="accent">{pinnedExpanded ? 'Show less' : `Show ${pinnedCount - PINNED_PREVIEW} more`}</Text>
            </Pressable>
          ) : null}
        </Card>
      ) : null}
      {SECTION_ROWS.filter(row => row.section !== 'sessions' || !here.sessions.unavailable).map(row => (
        <Card key={row.section} style={styles.cardGap}>
          <GroupRow
            testID={`home-open-${row.section}`}
            icon={row.icon}
            title={row.title}
            count={row.section === 'sessions' ? sessionCount : row.section === 'repositories' ? here.projects.data?.length : archivedCount}
            onPress={() => router.push({ pathname: '/panes/[section]', params: { section: row.section } })}
          />
        </Card>
      ))}
    </>
  );

  const tileTitle = tile === 'working' ? 'Working' : 'Ready';
  const header = searching ? null : (
    <View>
      <StatusTiles counts={counts} selected={tile} onSelect={selectTile} />
      <View style={styles.below}>
        {loading ? <LoadingRows />
          : tile === 'needs' ? needsYou
          : tile === 'all' ? (all ? <BoardHeader title={allOffline(feeds) ? 'Last seen' : 'Recent'} count={counts?.all} /> : allPanes)
          : <BoardHeader title={tileTitle} count={counts?.[tile]} right={<Text variant="rowDetail" tone="muted">Newest first</Text>} />}
      </View>
    </View>
  );
  const empty = loading ? (searching ? <LoadingRows /> : null)
    : searching ? <Notice testID="panes-no-results" message={all ? `No panes match “${query}” on any machine.` : `No panes match “${query}”.`} />
    : tile === 'working' ? <EmptyCard testID="board-working-empty" title="Nothing working" detail="Panes show here while their agent works." />
    : tile === 'ready' ? <EmptyCard testID="board-ready-empty" title="Nothing ready" detail="Panes show here when their agent finishes, until you open them." />
    : null;

  const list = (
    <LegendList
      testID="panes-list"
      data={rows}
      keyExtractor={row => row.key}
      getItemType={row => row.kind}
      estimatedItemSize={52}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      // Search results scroll clear of the keyboard.
      automaticallyAdjustKeyboardInsets
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      style={styles.fill}
      contentContainerStyle={[{ paddingBottom: bottomBarHeight(insets.bottom) + 12 }]}
      ListHeaderComponent={header}
      ListEmptyComponent={empty ? <View style={searching ? undefined : styles.below}>{empty}</View> : null}
      renderItem={renderRow}
    />
  );

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <View
          // Flows wait on the connection through this id.
          testID={`connection-status-${presence}`}
          style={styles.brand}
          accessible
          accessibilityRole="header"
          accessibilityLabel={`Pane on ${current?.name ?? profile.label}`}
        >
          <PaneLogo />
          <Text variant="title" numberOfLines={1} style={styles.brandTitle}>Pane</Text>
        </View>
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
      <MachineChips machines={chipMachines} showAll={home.showAll} />
      <ConnectionBar notice={notice} onRetry={retry} />
      {all ? (
        <>
          <AllMachinesNotes feeds={feeds} machines={chipMachines} currentKey={profile.id} />
          {list}
        </>
      ) : (
        // The last screen stays, dimmed and untouchable, while the machine isn't connected. The pills
        // above stay live, so you can switch away from a machine that is down.
        <Dimmed dimmed={presence !== 'connected'} style={styles.fill}>{list}</Dimmed>
      )}
      <HomeBottomBar query={query} onQuery={setQuery} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, paddingBottom: 8 },
  brand: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandTitle: { flexShrink: 1, fontSize: 21, letterSpacing: -0.2, fontWeight: '700' },
  roundButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  // The tiles bring their own 12 pt sides; everything below them sits in the same column.
  below: { paddingHorizontal: 12 },
  autopilot: { marginTop: 12 },
  sortButton: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  cardGap: { marginTop: 12 },
  cardRow: { marginHorizontal: 12, overflow: 'hidden' },
  hairline: { height: StyleSheet.hairlineWidth },
  more: { minHeight: 40, justifyContent: 'center', paddingLeft: 36 },
});
