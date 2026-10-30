import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { MachineBadge } from '@/features/machines/MachineBadge';
import { MachineMark } from '@/features/machines/MachineMark';
import type { Machine } from '@/features/machines/machines';
import { openNotifySheet } from '@/features/notify/NotifySheet';
import { LoadingRows, Notice, SectionHeader } from '@/features/panes/PaneKit';
import { describePermission } from '@/features/panes/permissions';
import { SearchField } from '@/features/panes/SearchField';
import { StatusBadge, statusPresentation } from '@/features/panes/StatusBadge';
import { SwipeRow, swipeRowAccessibility } from '@/features/panes/SwipeRow';
import { useTheme, withAlpha } from '@/theme';
import { Button, Icon, Text } from '@/ui';

import { buildAllMachinesList, sinceLabel, type AllPane, type MachineFeed, type RecentRow, type WaitingRow } from './allMachinesList';

/** How far an unreachable machine's rows fade: the same as a disconnected home. */
const STALE_OPACITY = 0.45;

export interface AllMachinesFeed extends MachineFeed {
  /** Reads the machine again now. */
  retry(): void;
}

/** Pin and archive on the machine the phone is on; other machines' rows don't swipe. */
export interface CurrentMachineActions {
  openPane(paneId: string): void;
  togglePanePinned(paneId: string): void;
  archivePane(pane: { id: string; name: string }): void;
  toggleSessionPinned(sessionId: string, pinned: boolean): void;
  archiveSession(sessionId: string): void;
}

/**
 * Home's All machines list: what's waiting on you from every saved machine, then every Pane and
 * Session newest first, each with its machine's badge. An unreachable machine's rows stay,
 * dimmed, under a note that says since when, with Retry.
 */
export function AllMachinesHome({ machines, feeds, currentKey, loading, refreshing, onRefresh, nextMachine, actions, bottomPadding }: {
  machines: Machine[];
  /** Every saved machine, the current one included. */
  feeds: AllMachinesFeed[];
  currentKey: string;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** Where New would create, for the empty list's hint. */
  nextMachine: string;
  actions: CurrentMachineActions;
  bottomPadding: number;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const { waiting, recent } = buildAllMachinesList(feeds, query);
  const machineOf = (key: string) => machines.find(machine => machine.key === key);
  const feedOf = (key: string) => feeds.find(feed => feed.key === key);
  const offline = feeds.filter(feed => feed.offlineSince !== undefined);
  const noneAnswer = feeds.length > 0 && offline.length === feeds.length;
  const now = Date.now();

  const sayOffline = (machineKey: string, what: string) => {
    const feed = feedOf(machineKey);
    const name = machineOf(machineKey)?.name ?? 'This machine';
    const since = feed?.offlineSince ? ` Its rows are from ${clock(feed.offlineSince)}.` : '';
    Alert.alert(`${name} is offline`, `Pane can't reach ${name} right now, so it can't open this ${what}.${since}`, [
      { text: 'OK', style: 'cancel' },
      { text: 'Retry', onPress: () => feed?.retry() },
    ]);
  };

  const openRecent = (row: RecentRow) => {
    if (row.stale) return sayOffline(row.machineKey, row.type === 'pane' ? 'Pane' : 'Session');
    const here = row.machineKey === currentKey;
    if (row.type === 'pane') {
      if (here) actions.openPane(row.pane.id);
      // Switches to its machine, then opens it, like a notification tap.
      else router.push({ pathname: '/open', params: { host: row.machineKey, paneId: row.pane.id } });
    } else if (here) {
      router.push({ pathname: '/session/[sessionId]', params: { sessionId: row.session.id } });
    } else {
      router.push({ pathname: '/open', params: { host: row.machineKey, sessionId: row.session.id } });
    }
  };

  const openWaiting = (row: WaitingRow) => {
    if (row.stale) return sayOffline(row.machineKey, row.type === 'question' ? 'question' : 'request');
    const here = row.machineKey === currentKey;
    if (row.type === 'question') {
      // Another machine's question answers there, without switching.
      openNotifySheet(row.item.id, row.item.source.paneId, here ? undefined : row.machineKey);
    } else if (here) {
      router.push({ pathname: '/pane/[paneId]/permission', params: { paneId: row.request.sessionId, requestId: row.request.id } });
    } else {
      router.push({ pathname: '/open', params: { host: row.machineKey, paneId: row.request.sessionId } });
    }
  };

  const header = (
    <View>
      {waiting.length > 0 ? (
        <View style={styles.waitingSection}>
          <SectionHeader title="Waiting on you" count={waiting.length} first />
          <View style={[styles.waitingCard, { borderRadius: theme.radius.card, backgroundColor: withAlpha(theme.colors.warning, 0.09) }]}>
            {waiting.map((row, index) => {
              const machine = machineOf(row.machineKey);
              const permission = row.type === 'permission' ? describePermission(row.request) : null;
              return (
                <AllRow
                  key={row.key}
                  testID={row.type === 'question' ? `notify-row-${row.item.id}` : `permission-row-${row.request.sessionId}`}
                  title={row.type === 'question' ? row.item.source.name : row.paneName}
                  detail={row.type === 'question' ? row.item.title : permission?.target ? `${permission.title}: ${permission.target}` : permission?.title ?? ''}
                  machine={machine}
                  stale={row.stale}
                  divided={index > 0}
                  leading={<StatusBadge status="blocked" />}
                  onPress={() => openWaiting(row)}
                />
              );
            })}
          </View>
        </View>
      ) : null}
      {recent.length > 0 ? <SectionHeader title={noneAnswer ? 'Last seen' : 'Recent'} first={waiting.length === 0} /> : null}
    </View>
  );

  const renderRow = ({ item: row }: { item: RecentRow }) => {
    const machine = machineOf(row.machineKey);
    const time = sinceLabel(row.type === 'pane' ? row.pane.activeAt : row.activeAt, now);
    const content = row.type === 'pane' ? (
      <AllRow
        testID={`all-pane-row-${row.key}`}
        title={row.pane.name}
        detail={[row.pane.repository, row.pane.session, time].filter(Boolean).join(' · ')}
        label={paneLabel(row.pane, machine?.name)}
        machine={machine}
        stale={row.stale}
        leading={<StatusBadge status={row.pane.status} />}
        onPress={() => openRecent(row)}
        swipe={row.machineKey === currentKey && !row.stale ? {
          pinned: row.pane.pinned,
          onTogglePinned: () => actions.togglePanePinned(row.pane.id),
          onArchive: () => actions.archivePane(row.pane),
        } : undefined}
      />
    ) : (
      <AllRow
        testID={`all-session-row-${row.key}`}
        title={row.session.name || 'Untitled'}
        detail={['Session', row.paneCount === 1 ? '1 Pane' : row.paneCount > 1 ? `${row.paneCount} Panes` : undefined, time].filter(Boolean).join(' · ')}
        machine={machine}
        stale={row.stale}
        leading={<Icon ios="bubble.left" android="chat_bubble" size={12} />}
        onPress={() => openRecent(row)}
        swipe={row.machineKey === currentKey && !row.stale ? {
          pinned: Boolean(row.session.isPinned),
          onTogglePinned: () => actions.toggleSessionPinned(row.session.id, !row.session.isPinned),
          onArchive: () => actions.archiveSession(row.session.id),
        } : undefined}
      />
    );
    return content;
  };

  const empty = loading ? <LoadingRows />
    : noneAnswer ? null
    : query ? <Notice testID="panes-no-results" message={`No panes match “${query}” on any machine.`} />
    : (
      <View testID="all-machines-empty" style={styles.empty}>
        <Text variant="headline">{`Nothing open on your ${feeds.length} machines`}</Text>
        <Text variant="subhead" tone="secondary" style={styles.center}>{`Start a Pane or a Session. It goes to ${nextMachine}, the machine you used last.`}</Text>
        <Button testID="all-machines-new" title="New" onPress={() => router.push('/new')} />
      </View>
    );

  return (
    <View style={styles.fill}>
      {noneAnswer ? (
        <View testID="all-machines-unreachable" style={[styles.unreachable, { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceRaised }]}>
          <Text variant="headline">Can’t reach your machines</Text>
          <Text variant="subhead" tone="secondary">
            {`None of your ${feeds.length} machines answered. Is Tailscale on on this phone? Pane keeps trying.`}
          </Text>
          <Pressable testID="all-machines-retry" accessibilityRole="button" hitSlop={8} onPress={() => feeds.forEach(feed => feed.retry())}>
            <Text variant="callout" tone="accent" style={styles.bold}>Try again</Text>
          </Pressable>
        </View>
      ) : offline.map(feed => (
        <OfflineNote key={feed.key} machine={machineOf(feed.key)} since={feed.offlineSince} hasRows={feed.snapshot !== undefined} onRetry={feed.retry} />
      ))}
      <SearchField value={query} onChange={setQuery} />
      <LegendList
        testID="panes-list"
        data={loading ? [] : recent}
        keyExtractor={row => row.key}
        getItemType={row => row.type}
        estimatedItemSize={60}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshing={refreshing}
        onRefresh={onRefresh}
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]}
        ListHeaderComponent={loading ? null : header}
        ListEmptyComponent={waiting.length > 0 ? null : empty}
        renderItem={renderRow}
      />
    </View>
  );
}

function paneLabel(pane: AllPane, machine: string | undefined): string {
  return [pane.name, pane.repository, pane.session, statusPresentation[pane.status].label, machine].filter(Boolean).join(', ');
}

/** "9:14 AM" in the phone's own clock format. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** One machine that stopped answering: since when its rows are, and Retry. */
function OfflineNote({ machine, since, hasRows, onRetry }: { machine: Machine | undefined; since: number | undefined; hasRows: boolean; onRetry: () => void }) {
  const theme = useTheme();
  const name = machine?.name ?? 'A machine';
  return (
    <View
      testID={`all-machines-offline-${name}`}
      accessibilityLiveRegion="polite"
      style={[styles.offline, { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceRaised }]}
    >
      {machine ? <MachineMark os={machine.os} slot={machine.slot} state="dimmed" size={16} /> : null}
      <Text variant="subhead" tone="secondary" style={styles.fill}>
        {hasRows && since ? (
          <>
            <Text variant="subhead" style={styles.bold}>{`${name} went offline at ${clock(since)}.`}</Text>
            {' Its rows are from then.'}
          </>
        ) : (
          <>
            <Text variant="subhead" style={styles.bold}>{`${name} isn’t answering.`}</Text>
            {' Its Panes show here once it does.'}
          </>
        )}
      </Text>
      <Pressable testID={`all-machines-retry-${name}`} accessibilityRole="button" accessibilityLabel={`Retry ${name}`} hitSlop={10} onPress={onRetry}>
        <Text variant="callout" tone="accent" style={styles.bold}>Retry</Text>
      </Pressable>
    </View>
  );
}

/** A row of All machines: status, name, what it is, and its machine's badge. */
function AllRow({ title, detail, label, machine, stale, divided = false, leading, onPress, swipe, testID }: {
  title: string;
  detail: string;
  /** Spoken instead of title and detail. */
  label?: string;
  machine: Machine | undefined;
  stale: boolean;
  divided?: boolean;
  leading: ReactNode;
  onPress: () => void;
  swipe?: { pinned: boolean; onTogglePinned: () => void; onArchive: () => void };
  testID: string;
}) {
  const theme = useTheme();
  const row = (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label ?? [title, detail, machine?.name].filter(Boolean).join(', ')}
      accessibilityHint={stale ? `${machine?.name ?? 'Its machine'} is offline` : undefined}
      {...(swipe ? swipeRowAccessibility(swipe) : {})}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { opacity: stale ? STALE_OPACITY : 1 },
        swipe ? { backgroundColor: pressed ? theme.colors.selected : theme.colors.background } : pressed && { backgroundColor: theme.colors.surfacePressed },
      ]}
    >
      {divided ? <View style={[styles.divider, { backgroundColor: theme.colors.border }]} /> : null}
      <View style={styles.leading}>{leading}</View>
      <View style={styles.fill}>
        <Text variant="body" numberOfLines={1}>{title}</Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>{detail}</Text>
      </View>
      {machine ? <MachineBadge machine={machine} /> : null}
    </Pressable>
  );
  if (!swipe) return row;
  const rowId = testID.replace(/^all-(pane|session)-row-/, '');
  return <SwipeRow testIDPrefix={testID.startsWith('all-pane') ? 'pane' : 'session'} id={rowId} {...swipe}>{row}</SwipeRow>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bold: { fontWeight: '600' },
  center: { textAlign: 'center' },
  content: { padding: 12 },
  waitingSection: { marginBottom: 12 },
  waitingCard: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 12, paddingVertical: 8 },
  leading: { width: 12, alignItems: 'center' },
  divider: { position: 'absolute', top: 0, left: 36, right: 0, height: StyleSheet.hairlineWidth },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 10 },
  unreachable: { marginHorizontal: 16, marginBottom: 8, padding: 16, gap: 6 },
  empty: { alignItems: 'center', gap: 10, paddingHorizontal: 24, paddingTop: 48 },
});
