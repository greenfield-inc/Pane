import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { use, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { canClose } from '@shared/approvalReceipts';

import { ScreenFocus } from '@/daemon';

import { buildAllMachinesList, feedsAnswered, type RecentRow } from '@/features/allMachines/allMachinesList';
import { AllMachinesNotes, allOffline, offlineAlert, openRecentRow, openWaitingRow, RecentRowView, waitingRowText } from '@/features/allMachines/AllMachinesRows';
import { ApprovalGroups } from '@/features/approvals/ApprovalGroups';
import { sessionKey } from '@/features/approvals/approvals';
import { ArchiveUndoBar, useArchiveHold } from '@/features/approvals/ArchiveUndo';
import { approvalRowSpoken, ApprovalRowLines } from '@/features/approvals/ApprovalRowLines';
import { AutopilotRow } from '@/features/autopilot/AutopilotRow';
import { useAutopilot } from '@/features/autopilot/hooks';
import { DemoBadge } from '@/features/demo/DemoBadge';
import { ConnectionBar, Dimmed } from '@/features/hosts/ConnectionStatus';
import { ReadOnlyChip } from '@/features/hosts/ReadOnlyChip';
import { MachineChips } from '@/features/machines/MachineChips';
import { PaneLogo } from '@/features/machines/PaneLogo';
import { AgentPromptActions } from '@/features/notify/AgentPromptActions';
import { useArchivedProjects } from '@/features/panes/hooks';
import { LoadingRows, Notice } from '@/features/panes/PaneKit';
import { buildSidebar, type SidebarItem, type SidebarSection } from '@/features/panes/paneList';
import { PaneRow } from '@/features/panes/PaneRow';
import { SidebarItemView, type SidebarItemContext } from '@/features/panes/SidebarItemView';
import { useSidebarSections } from '@/features/panes/sidebarSections';
import { useOpenSessions } from '@/features/panes/useOpenSessions';
import { HomeRail } from '@/features/layout/HomeRail';
import { OpenMark } from '@/features/layout/OpenMark';
import { InColumn, screenId, useOpenFromHome, useRail, useWideLayout } from '@/features/layout/wideLayout';
import { usePaneActions } from '@/features/panes/usePaneActions';
import { markNextFrame } from '@/features/perf/perfMarks';
import { useLiveMarks, useValueMark } from '@/features/perf/usePerfMarks';
import { useTheme, withAlpha } from '@/theme';
import { Icon, SkeletonSwap, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

import { ActivityRow, ApprovalRow, BoardHeader, BoardSkeleton, Card, CardSkeleton, EmptyCard, GroupRow, HistoryLine } from './BoardRows';
import { useBoardTile } from './boardTile';
import { bottomBarHeight, HomeBottomBar } from './HomeBottomBar';
import { homeScroll, useHomeView } from './homeView';
import { boardCounts, PINNED_PREVIEW, sessionWaiting, terminalWaiting, tilePanes, type PaneRecentRow } from './statusBoard';
import { StatusTiles } from './StatusTiles';
import { useHomeFeeds } from './useHomeData';

/** A row of home's list: a Working or Ready Pane, one of All machines' rows, or a search result. */
type HomeRow =
  | { kind: 'activity'; key: string; row: PaneRecentRow; first: boolean; last: boolean }
  | { kind: 'recent'; key: string; row: RecentRow }
  | { kind: 'sidebar'; key: string; item: SidebarItem; previous: SidebarItem | undefined; first: boolean };

const CLOSED: Record<SidebarSection, boolean> = { pinned: false, sessions: false, repositories: false, archived: false };

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
  // In view: the phone's Home while nothing covers it, and the docked column always.
  const focused = use(ScreenFocus);
  const home = useHomeFeeds({ active: focused });
  const { here, all, feeds, chipMachines, current, presence, live, notice, retry } = home;
  const profile = here.profile;
  const autopilot = useAutopilot();
  const actions = usePaneActions();
  const open = useOpenFromHome();
  // Docked beside an open screen: Sessions, Repositories and Archived open in place.
  const inColumn = use(InColumn);
  // What is open beside the column: its rows are marked, on its own machine only.
  const openNow = useWideLayout(state => (inColumn ? state.open : null));
  const isOpen = (pathname: string, id: string, machineKey: string) => openNow !== null && machineKey === profile.id && openNow.pathname === pathname && screenId(openNow) === id;
  const rail = useRail();
  // + shows only while some machine here takes new work: a phone paired read-only can't create.
  const canCreate = all ? home.saved.some(machine => !machine.readOnly) : !current?.readOnly;
  const setCollapsed = useWideLayout(state => state.setCollapsed);
  const itemOpen = (item: SidebarItem) => (item.type === 'pane' ? isOpen('/pane/[paneId]', item.pane.id, profile.id) : item.type === 'session' ? isOpen('/session/[sessionId]', item.session.id, profile.id) : false);
  const tile = useBoardTile(state => state.tile);
  const selectTile = useBoardTile(state => state.select);
  const query = useHomeView(state => state.query);
  const setQuery = useHomeView(state => state.setQuery);
  const [refreshing, setRefreshing] = useState(false);
  const openSessions = useOpenSessions(state => state.open[profile.id]) ?? [];
  const toggleSession = useOpenSessions(state => state.toggle);
  const pinnedExpanded = useSidebarSections(state => state.allPinned);
  const togglePinnedExpanded = useSidebarSections(state => state.toggleAllPinned);
  const expanded = useSidebarSections(state => state.expanded);
  const toggleSection = useSidebarSections(state => state.toggle);
  const searching = query.trim().length > 0;
  // The archive is read for a search, or by its own screen; the All panes tile counts it only once cached.
  const archived = useArchivedProjects(!all && (searching || (inColumn && expanded.archived)));
  const archiving = useArchiveHold();

  // Approvals swiped to Archive leave the list and its counts while held for Undo.
  const listed = buildAllMachinesList(feeds, '');
  const board = { ...listed, waiting: listed.waiting.filter(row => !archiving.hidden.has(row.key)) };
  // Their Panes still wait on those questions, not in the terminal.
  const held = listed.waiting.filter(row => archiving.hidden.has(row.key));
  // The board paints as soon as any machine answers, so a slow one never holds up the others.
  const loading = all ? feeds.every(feed => !feed.snapshot && feed.offlineSince === undefined && feed.error === undefined) : here.loading;
  // Counts, and the cards that say a list is empty, wait for every machine, so no zero shows that a
  // slower machine's answer would contradict. Needs you waits for the approvals too.
  const answered = feedsAnswered(feeds);
  const tally = boardCounts(board, held);
  const counts = loading || !answered.lists ? undefined : { ...tally, needs: answered.approvals ? tally.needs : undefined };
  // One machine's Home dims once its connection has been down past the grace window; All never dims as a whole.
  const dimmed = !all && !live;
  useValueMark('counts', counts ? `${counts.needs ?? '-'}/${counts.working}/${counts.ready}/${counts.all}` : '-');
  useLiveMarks('home', !dimmed && !loading, Math.min(here.projects.dataUpdatedAt, here.statuses.dataUpdatedAt, here.notify.dataUpdatedAt));
  useEffect(() => markNextFrame(['launch', 'switch'], 'home-frame'), []);
  const machineOf = (key: string) => chipMachines.find(machine => machine.key === key);
  // On All, rows carry their machine's mark.
  const markOf = (key: string) => (all ? machineOf(key) : undefined);
  const sayOffline = offlineAlert(feeds, chipMachines);
  const waitingBySession = sessionWaiting(board, held);
  // The machine the phone is on, as Pinned, Sessions, Repositories and Archived list it.
  const statusOf = new Map(board.recent.flatMap(row => (row.type === 'pane' && row.machineKey === profile.id ? [[row.pane.id, row.pane] as const] : [])));
  const sidebar = (sidebarQuery: string, sections: Record<SidebarSection, boolean>) => buildSidebar({
    projects: here.projects.data ?? [],
    sessions: here.sessions.unavailable ? 'unavailable' : here.sessions.data?.sessions ?? (here.sessions.isError ? [] : undefined),
    sessionsError: here.sessions.isError && !here.sessions.unavailable ? here.sessions.error.message : undefined,
    archivedProjects: archived.data,
    archivedError: archived.isError ? archived.error.message : undefined,
    expanded: sections,
    openSessions,
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
    onToggleSession: sessionId => toggleSession(profile.id, sessionId),
    retry: what => void (what === 'archived' ? archived.refetch() : here.sessions.refetch()),
  });

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([home.refetch(), autopilot.refetch(), archived.isFetched ? archived.refetch() : undefined]);
    setRefreshing(false);
  };

  // What the list holds below its header.
  const rows: HomeRow[] = (() => {
    if (searching) {
      if (all) return buildAllMachinesList(feeds, query).recent.map(row => ({ kind: 'recent', key: row.key, row }));
      // Every section, whatever the person last folded, so a match never hides under a header.
      const items = sidebar(query, { pinned: true, sessions: true, repositories: true, archived: true });
      return items.map((item, index) => ({ kind: 'sidebar', key: item.key, item, previous: items[index - 1], first: index === 0 }));
    }
    if (tile === 'working' || tile === 'ready') {
      const panes = tilePanes(board.recent, tile);
      return panes.map((row, index) => ({ kind: 'activity', key: row.key, row, first: index === 0, last: index === panes.length - 1 }));
    }
    if (tile === 'all' && all) return board.recent.map(row => ({ kind: 'recent', key: row.key, row }));
    return [];
  })();

  // A Pane in a card: Working, Ready, or waiting in its terminal.
  const activityRow = (row: PaneRecentRow, first: boolean, last: boolean, tint = theme.colors.surfaceRaised) => {
    const swipes = row.machineKey === profile.id && !row.stale;
    const radius = theme.radius.card;
    return (
      <View
        key={row.key}
        style={[
          styles.cardRow,
          { backgroundColor: tint },
          first && { borderTopLeftRadius: radius, borderTopRightRadius: radius },
          last && { borderBottomLeftRadius: radius, borderBottomRightRadius: radius },
        ]}
      >
        <OpenMark open={isOpen('/pane/[paneId]', row.pane.id, row.machineKey)}>
          <ActivityRow
            row={row}
            machine={markOf(row.machineKey)}
            divided={!first}
            background={tint}
            onPress={() => openRecentRow(row, profile.id, actions, sayOffline)}
            swipe={swipes ? {
              onTogglePinned: () => actions.togglePanePinned(row.pane.id),
              onArchive: () => actions.archivePane(row.pane),
              onTogglePaused: () => actions.setPanePaused(row.pane.id, !row.pane.paused),
            } : undefined}
          />
        </OpenMark>
      </View>
    );
  };

  const renderRow = ({ item }: { item: HomeRow }) => {
    switch (item.kind) {
      case 'activity':
        return activityRow(item.row, item.first, item.last);
      case 'recent':
        return (
          <View style={styles.below}>
            <OpenMark open={item.row.type === 'pane' ? isOpen('/pane/[paneId]', item.row.pane.id, item.row.machineKey) : isOpen('/session/[sessionId]', item.row.session.id, item.row.machineKey)}>
              <RecentRowView row={item.row} waiting={item.row.type === 'session' ? waitingBySession.get(sessionKey(item.row.machineKey, item.row.session.id)) ?? 0 : 0} machine={machineOf(item.row.machineKey)} currentKey={profile.id} actions={actions} onOpen={() => openRecentRow(item.row, profile.id, actions, sayOffline)} />
            </OpenMark>
          </View>
        );
      case 'sidebar':
        return (
          <View style={styles.below}>
            <OpenMark open={itemOpen(item.item)}>
              <SidebarItemView item={item.item} previous={item.previous} first={item.first} context={sidebarContext()} />
            </OpenMark>
          </View>
        );
    }
  };

  // Needs you: Autopilot, the approvals in the chosen sort, Panes waiting in their terminal (D-81),
  // then the line that opens History.
  const inTerminal = terminalWaiting(board, held);
  const nothingWaiting = board.waiting.length + board.offline.length + inTerminal.length === 0;
  // The approvals card's amber: both lists wait on you.
  const needsTint = withAlpha(theme.colors.warning, 0.09);
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
      <SkeletonSwap loading={nothingWaiting && !answered.approvals} skeleton={<CardSkeleton testID="approvals-skeleton" label="Loading approvals" />}>
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
                  <OpenMark open={row.type === 'question' && isOpen('/approval/[notifyId]', row.item.id, row.machineKey)}>
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
                      onPress={() => openWaitingRow(row, list, profile.id, open)}
                      // The card's Close with no reason, for this machine's questions it can close.
                      onArchive={row.type === 'question' && list === 'waiting' && row.machineKey === profile.id && !row.stale && canClose(row.item) ? {
                        swipeId: row.item.id,
                        archive: () => archiving.archive({ key: row.key, id: row.item.id, title: row.item.title }),
                      } : undefined}
                      background={needsTint}
                    />
                  </OpenMark>
                  {row.type === 'question' && row.item.state === 'waiting' ? (
                    <AgentPromptActions item={row.item} inset={33} machine={row.machineKey === profile.id ? null : machine?.profile ?? null} />
                  ) : null}
                  {archiving.failed.has(row.key) ? (
                    <Notice testID={`approvals-archive-error-${row.key}`} danger message={`Not archived: ${archiving.failed.get(row.key)}`} action={{ title: 'Dismiss', onPress: () => archiving.dismiss(row.key) }} />
                  ) : null}
                </>
              );
            }}
          />
        ) : null}
        {inTerminal.length > 0 ? (
          <View testID="needs-terminal" style={styles.terminalGroup}>
            <Text variant="footnote" tone="secondary" style={styles.groupLabel} accessibilityRole="header">{`Waiting in the terminal · ${inTerminal.length}`}</Text>
            {/* The board's own padding already insets the column; the rows bring the card. */}
            <View style={styles.flush}>{inTerminal.map((row, index) => activityRow(row, index === 0, index === inTerminal.length - 1, needsTint))}</View>
          </View>
        ) : null}
        {nothingWaiting ? (
          <EmptyCard testID="approvals-empty" title="Nothing needs you" detail={!all && current?.readOnly ? `This phone only watches ${current.name}, so its questions and permission requests stay there. Agents waiting in their terminal show here.` : 'Questions, permission requests and agents waiting in their terminal land here.'} />
        ) : null}
      </SkeletonSwap>
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
      {(here.projects.data ?? []).length === 0 && !here.projects.isError ? <Notice testID="panes-empty" message="No remote panes found on this host." /> : null}
      {pinnedItems.length > 0 ? (
        <Card testID="home-pinned" style={styles.cardGap}>
          <GroupRow testID="sidebar-section-pinned" icon={{ ios: 'pin', android: 'push_pin' }} title="Pinned" count={pinnedCount} open={expanded.pinned} onPress={() => toggleSection('pinned')} />
          {expanded.pinned ? shownPinned.map((item, index) => (
            <View key={item.key}>
              {index === 0 ? <View style={[styles.hairline, { backgroundColor: theme.colors.border }]} /> : null}
              <OpenMark open={itemOpen(item)}>
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
              </OpenMark>
            </View>
          )) : null}
          {expanded.pinned && pinnedCount > PINNED_PREVIEW ? (
            <Pressable testID="home-pinned-more" accessibilityRole="button" hitSlop={4} onPress={togglePinnedExpanded} style={styles.more}>
              <Text variant="subhead" tone="accent">{pinnedExpanded ? 'Show less' : `Show ${pinnedCount - PINNED_PREVIEW} more`}</Text>
            </Pressable>
          ) : null}
        </Card>
      ) : null}
      {SECTION_ROWS.filter(row => row.section !== 'sessions' || !here.sessions.unavailable).map(row => {
        const inPlace = inColumn && expanded[row.section];
        const items = inPlace ? sidebar('', { ...CLOSED, [row.section]: true }).filter(item => item.type !== 'section') : [];
        return (
          <Card key={row.section} style={styles.cardGap}>
            <GroupRow
              testID={`home-open-${row.section}`}
              icon={row.icon}
              title={row.title}
              count={row.section === 'sessions' ? sessionCount : row.section === 'repositories' ? here.projects.data?.length : archivedCount}
              open={inColumn ? inPlace : undefined}
              onPress={() => (inColumn ? toggleSection(row.section) : router.push({ pathname: '/panes/[section]', params: { section: row.section } }))}
            />
            {items.map((item, index) => (
              <View key={item.key}>
                {index === 0 ? <View style={[styles.hairline, { backgroundColor: theme.colors.border }]} /> : null}
                <OpenMark open={itemOpen(item)}>
                  <SidebarItemView item={item} previous={items[index - 1]} first={index === 0} context={sidebarContext(theme.colors.surfaceRaised)} />
                </OpenMark>
              </View>
            ))}
          </Card>
        );
      })}
    </>
  );

  const tileTitle = tile === 'working' ? 'Working' : 'Ready';
  const header = searching ? null : (
    <View>
      <StatusTiles counts={counts} selected={tile} onSelect={selectTile} />
      <View style={styles.below}>
        {tile === 'needs' ? needsYou
          : tile === 'all' ? (all ? <BoardHeader title={allOffline(feeds) ? 'Last seen' : 'Recent'} count={counts?.all} /> : allPanes)
          : <BoardHeader title={tileTitle} count={counts?.[tile]} right={<Text variant="rowDetail" tone="muted">Newest first</Text>} />}
      </View>
    </View>
  );
  const empty = searching ? <Notice testID="panes-no-results" message={all ? `No panes match “${query}” on any machine.` : `No panes match “${query}”.`} />
    : !answered.lists ? null
    : tile === 'working' ? <EmptyCard testID="board-working-empty" title="Nothing working" detail="Panes show here while their agent works." />
    : tile === 'ready' ? <EmptyCard testID="board-ready-empty" title="Nothing ready" detail="Panes show here when their agent finishes, until you open them." />
    : null;

  // Until the board's first read lands, the tiles sit over a skeleton of what the selected one lists.
  const skeleton = searching ? <View style={styles.below}><LoadingRows /></View> : (
    <View>
      <StatusTiles counts={undefined} selected={tile} onSelect={selectTile} />
      <View style={styles.below}><BoardSkeleton groups={tile === 'all' && !all} /></View>
    </View>
  );
  const place = all ? 'all' : profile.id;
  const scroll = searching ? undefined : homeScroll(`${place}:${tile}:${rows.length}`);
  const list = (
    // The skeleton draws the tiles too, so the board doesn't fade them in again.
    <SkeletonSwap loading={loading} skeleton={skeleton} style={styles.fill} fade={false}>
      <LegendList
        // All and each machine keep their own place.
        key={place}
        // Back where it was on this list, header height included, or the offset stops where the rows
        // alone would end. Search results draw no header and always start at the top.
        initialScrollOffset={scroll?.offset ?? 0}
        estimatedHeaderSize={scroll?.headerSize}
        onMetricsChange={({ headerSize }) => { if (scroll) scroll.headerSize = headerSize; }}
        onScroll={event => { if (scroll) scroll.offset = Math.max(0, event.nativeEvent.contentOffset.y); }}
        testID="panes-list"
        data={rows}
        keyExtractor={row => row.key}
        getItemType={row => row.kind}
        // All's rows carry a second line and a machine badge.
        estimatedItemSize={tile === 'all' && all ? 60 : 52}
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
    </SkeletonSwap>
  );

  if (rail) {
    return (
      <HomeRail
        machine={all ? undefined : current}
        counts={counts}
        onExpand={() => setCollapsed(false)}
        onSelectTile={next => {
          selectTile(next);
          setCollapsed(false);
        }}
        onSearch={() => setCollapsed(false, { search: true })}
        canCreate={canCreate}
      />
    );
  }

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
        {!all && current?.readOnly ? <ReadOnlyChip /> : null}
        <DemoBadge />
        {/* Beside an open screen, Home collapses to its rail; with nothing open there is nothing to widen. */}
        {openNow ? (
          <Pressable
            testID="home-collapse"
            accessibilityRole="button"
            accessibilityLabel="Collapse Home"
            hitSlop={4}
            onPress={() => setCollapsed(true)}
            style={({ pressed }) => [styles.roundButton, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised }]}
          >
            <Icon ios="sidebar.left" android="left_panel_close" size={17} color={theme.colors.text} />
          </Pressable>
        ) : null}
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
        // The last screen stays, dimmed and untouchable, while the machine isn't connected, search and
        // + included. The pills above stay live, so you can switch away from a machine that is down.
        <Dimmed dimmed={dimmed} style={styles.fill}>
          {/* The Panes read failed: say why above the tiles, which still count what the other reads found. */}
          {here.projects.isError ? (
            <View style={styles.note}>
              <Notice testID="home-read-error" danger message={here.projects.error.message} action={{ title: 'Try again', onPress: () => void here.projects.refetch() }} />
            </View>
          ) : null}
          {list}
          <HomeBottomBar query={query} onQuery={setQuery} canCreate={canCreate} />
        </Dimmed>
      )}
      {all ? <HomeBottomBar query={query} onQuery={setQuery} canCreate={canCreate} /> : null}
      <ArchiveUndoBar held={archiving.held} onUndo={archiving.undo} bottom={bottomBarHeight(insets.bottom) + 8} />
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
  terminalGroup: { gap: 4, marginTop: 8 },
  groupLabel: { fontWeight: '600', paddingHorizontal: 4, minHeight: 22, textAlignVertical: 'center' },
  flush: { marginHorizontal: -12 },
  note: { marginHorizontal: 16, marginBottom: 8 },
  hairline: { height: StyleSheet.hairlineWidth },
  more: { minHeight: 40, justifyContent: 'center', paddingLeft: 36 },
});
