import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { buildAllMachinesList } from '@/features/allMachines/allMachinesList';
import { sessionKey } from '@/features/approvals/approvals';
import { useFreshCounts } from '@/features/home/seenStore';
import { sessionWaiting } from '@/features/home/statusBoard';
import { useCurrentMachine } from '@/features/home/useHomeData';
import { ConnectionBar, Dimmed } from '@/features/hosts/ConnectionStatus';
import { useConnectionPresence } from '@/features/hosts/useConnectionPresence';
import { useTheme } from '@/theme';
import { SkeletonSwap } from '@/ui';

import { useArchivedProjects } from './hooks';
import { LoadingRows, Notice } from './PaneKit';
import { buildSidebar, type SidebarSection } from './paneList';
import { SidebarItemView } from './SidebarItemView';
import { useOpenSessions } from './useOpenSessions';
import { usePaneActions } from './usePaneActions';
import { FocusListContext } from '@/features/controller/focusContext';
import { useFocusList } from '@/features/controller/useFocusList';

const TITLES: Record<Exclude<SidebarSection, 'pinned'>, string> = { sessions: 'Sessions', repositories: 'Repositories', archived: 'Archived' };

function parseSection(value: string | undefined): Exclude<SidebarSection, 'pinned'> {
  return value === 'sessions' || value === 'archived' ? value : 'repositories';
}

/**
 * Sessions, Repositories or Archived from home's All panes tile, on the machine the phone is on:
 * the same rows as before, swipes included, with a + on each repository and Restore and Delete on
 * archived ones. While the machine isn't connected, the rows stay dimmed and untouchable under the
 * connection bar, as on home.
 */
export function SidebarSectionScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const section = parseSection(useLocalSearchParams<{ section?: string }>().section);
  const { presence, live, notice, retry } = useConnectionPresence();
  const here = useCurrentMachine({ unreachable: presence === 'unreachable', retry });
  const actions = usePaneActions();
  const archived = useArchivedProjects(section === 'archived');
  const openSessions = useOpenSessions(state => state.open[here.profile.id]) ?? [];
  const toggleSession = useOpenSessions(state => state.toggle);
  const [refreshing, setRefreshing] = useState(false);
  const board = buildAllMachinesList([here.feed], '');
  const statusOf = new Map(board.recent.flatMap(row => (row.type === 'pane' ? [[row.pane.id, row.pane] as const] : [])));
  const waitingBySession = sessionWaiting(board);
  const fresh = useFreshCounts();
  const items = buildSidebar({
    projects: here.projects.data ?? [],
    sessions: here.sessions.unavailable ? 'unavailable' : here.sessions.data?.sessions ?? (here.sessions.isError ? [] : undefined),
    sessionsError: here.sessions.isError && !here.sessions.unavailable ? here.sessions.error.message : undefined,
    archivedProjects: archived.data,
    archivedError: archived.isError ? archived.error.message : undefined,
    expanded: { pinned: false, sessions: false, repositories: false, archived: false, [section]: true },
    openSessions,
    query: '',
    lookup: {
      status: paneId => statusOf.get(paneId)?.status ?? 'unknown',
      agent: paneId => statusOf.get(paneId)?.agent,
    },
  }).filter(item => item.type !== 'section');

  // Sessions and Archived wait for their own reads too, so their rows come in one swap.
  const waiting = here.loading
    || (section === 'sessions' && !here.sessions.data && !here.sessions.isError && !here.sessions.unavailable)
    || (section === 'archived' && !archived.data && !archived.isError);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([here.refetch(), section === 'archived' ? archived.refetch() : undefined]);
    setRefreshing(false);
  };

  const listRef = useRef<LegendListRef>(null);
  const focusList = useFocusList(listRef);
  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      <Stack.Screen options={{ title: TITLES[section] }} />
      <ConnectionBar notice={notice} onRetry={retry} />
      <Dimmed dimmed={!live} style={styles.fill}>
        <SkeletonSwap
          loading={waiting}
          style={styles.fill}
          skeleton={<View style={styles.content}><LoadingRows archived={section === 'archived'} /></View>}
        >
          <FocusListContext value={focusList}>
          <LegendList
            ref={listRef}
            testID={`section-list-${section}`}
            data={items}
            keyExtractor={item => item.key}
            getItemType={item => item.type}
            estimatedItemSize={44}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            contentInsetAdjustmentBehavior="automatic"
            style={{ backgroundColor: theme.colors.background }}
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
            ListEmptyComponent={here.projects.isError ? <Notice danger message={here.projects.error.message} action={{ title: 'Try again', onPress: () => void here.projects.refetch() }} />
              : <Notice testID="section-empty" message={section === 'repositories' ? 'No repositories on this host yet.' : 'Nothing here yet.'} />}
            renderItem={({ item, index }) => (
              <SidebarItemView
                item={item}
                previous={items[index - 1]}
                first={index === 0}
                context={{
                  actions,
                  waitingFor: sessionId => waitingBySession.get(sessionKey(here.profile.id, sessionId)) ?? 0,
                  freshFor: row => ('sessionId' in row ? fresh.bySession.get(sessionKey(here.profile.id, row.sessionId)) : fresh.byPane.get(`${here.profile.id}:${row.paneId}`)) ?? 0,
                  onToggleSection: () => undefined,
                  onToggleSession: sessionId => toggleSession(here.profile.id, sessionId),
                  retry: what => void (what === 'archived' ? archived.refetch() : here.sessions.refetch()),
                }}
              />
            )}
          />
          </FocusListContext>
        </SkeletonSwap>
      </Dimmed>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 12 },
});
