import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { originLine } from '@shared/approvalReceipts';

import { askerLine, questionDetail, type ApprovalList } from '@/features/approvals/approvals';
import { openApproval } from '@/features/approvals/ApprovalScreen';
import { WaitingCount } from '@/features/approvals/WaitingCount';
import { MachineBadge } from '@/features/machines/MachineBadge';
import { MachineMark } from '@/features/machines/MachineMark';
import type { Machine } from '@/features/machines/machines';
import { Notice } from '@/features/panes/PaneKit';
import { describePermission } from '@/features/panes/permissions';
import { PausedBadge, StatusBadge, statusPresentation } from '@/features/panes/StatusBadge';
import { SwipeRow, swipeRowAccessibility } from '@/features/panes/SwipeRow';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { sinceLabel, type AllPane, type MachineFeed, type RecentRow, type WaitingRow } from './allMachinesList';

/** How far an unreachable machine's rows fade: the same as a disconnected home. */
const STALE_OPACITY = 0.45;

export interface AllMachinesFeed extends MachineFeed {
  /** Reads the machine again now. */
  retry(): void;
  /** It answers, but its list couldn't be read: the reason, shown with Try again. */
  error?: string;
}

/** Pin, pause and archive on the machine the phone is on; other machines' rows don't swipe. */
export interface CurrentMachineActions {
  openPane(paneId: string): void;
  togglePanePinned(paneId: string): void;
  archivePane(pane: { id: string; name: string }): void;
  toggleSessionPinned(sessionId: string, pinned: boolean): void;
  archiveSession(sessionId: string): void;
  setPanePaused(paneId: string, paused: boolean): void;
  setSessionPaused(sessionId: string, paused: boolean): void;
}

/** Opens a Pane or Session row: here, or on its machine after switching there, like a notification tap. */
export function openRecentRow(row: RecentRow, currentKey: string, actions: Pick<CurrentMachineActions, 'openPane'>, sayOffline: (machineKey: string, what: string) => void) {
  if (row.stale) return sayOffline(row.machineKey, row.type === 'pane' ? 'Pane' : 'Session');
  const here = row.machineKey === currentKey;
  if (row.type === 'pane') {
    if (here) actions.openPane(row.pane.id);
    else router.push({ pathname: '/open', params: { host: row.machineKey, paneId: row.pane.id } });
  } else if (here) {
    router.push({ pathname: '/session/[sessionId]', params: { sessionId: row.session.id } });
  } else {
    router.push({ pathname: '/open', params: { host: row.machineKey, sessionId: row.session.id } });
  }
}

/** Opens a question or permission request: here, or switching to its machine first. */
export function openWaitingRow(row: WaitingRow, list: ApprovalList, currentKey: string) {
  const here = row.machineKey === currentKey;
  if (row.type === 'question') {
    // The approval screen shows its machine's Session below the card, so another machine's switches first.
    if (here) openApproval(row.item.id, list);
    else router.push({ pathname: '/open', params: { host: row.machineKey, notifyId: row.item.id, ...(list === 'waiting' ? {} : { list }) } });
  } else if (here) {
    router.push({ pathname: '/pane/[paneId]/permission', params: { paneId: row.request.sessionId, requestId: row.request.id } });
  } else {
    router.push({ pathname: '/open', params: { host: row.machineKey, paneId: row.request.sessionId } });
  }
}

/** Says a stale row's machine is offline, with Retry. */
export function offlineAlert(feeds: readonly AllMachinesFeed[], machines: readonly Machine[]) {
  return (machineKey: string, what: string) => {
    const feed = feeds.find(candidate => candidate.key === machineKey);
    const name = machines.find(machine => machine.key === machineKey)?.name ?? 'This machine';
    const since = feed?.offlineSince ? ` Its rows are from ${clock(feed.offlineSince)}.` : '';
    Alert.alert(`${name} is offline`, `Pane can't reach ${name} right now, so it can't open this ${what}.${since}`, [
      { text: 'OK', style: 'cancel' },
      { text: 'Retry', onPress: () => feed?.retry() },
    ]);
  };
}

/** A question's or permission request's title and detail, as every list words them. */
export function waitingRowText(row: WaitingRow, machineLabel: string): { title: string; detail: string } {
  if (row.type === 'question') return { title: originLine(row.item, machineLabel), detail: questionDetail(row.item) };
  const permission = describePermission(row.request);
  return { title: askerLine(row.paneName, row.session), detail: permission.target ? `${permission.title}: ${permission.target}` : permission.title };
}

/** One row of All machines' every Pane and Session, newest first, with its machine's badge. */
export function RecentRowView({ row, machine, currentKey, actions, onOpen }: {
  row: RecentRow;
  machine: Machine | undefined;
  currentKey: string;
  actions: CurrentMachineActions;
  onOpen: () => void;
}) {
  const time = sinceLabel(row.type === 'pane' ? row.pane.activeAt : row.activeAt, Date.now());
  const swipes = row.machineKey === currentKey && !row.stale;
  return row.type === 'pane' ? (
    <AllRow
      testID={`all-pane-row-${row.key}`}
      title={row.pane.name}
      detail={[row.pane.repository, row.pane.session, time].filter(Boolean).join(' · ')}
      label={paneLabel(row.pane, machine?.name)}
      machine={machine}
      stale={row.stale}
      paused={Boolean(row.pane.paused)}
      leading={row.pane.paused ? <PausedBadge /> : <StatusBadge status={row.pane.status} />}
      onPress={onOpen}
      swipe={swipes ? {
        pinned: row.pane.pinned,
        onTogglePinned: () => actions.togglePanePinned(row.pane.id),
        onArchive: () => actions.archivePane(row.pane),
        pause: { paused: Boolean(row.pane.paused), onToggle: () => actions.setPanePaused(row.pane.id, !row.pane.paused) },
      } : undefined}
    />
  ) : (
    <AllRow
      testID={`all-session-row-${row.key}`}
      title={row.session.name || 'Untitled'}
      detail={['Session', row.paneCount === 1 ? '1 Pane' : row.paneCount > 1 ? `${row.paneCount} Panes` : undefined, time].filter(Boolean).join(' · ')}
      machine={machine}
      stale={row.stale}
      label={[row.session.name || 'Untitled', 'Session', row.waiting > 0 ? `${row.waiting} waiting` : undefined, machine?.name].filter(Boolean).join(', ')}
      paused={Boolean(row.session.paused)}
      leading={row.session.paused ? <PausedBadge /> : <Icon ios="bubble.left" android="chat_bubble" size={12} />}
      trailing={<WaitingCount testID={`all-session-waiting-${row.key}`} count={row.waiting} />}
      onPress={onOpen}
      swipe={swipes ? {
        pinned: Boolean(row.session.isPinned),
        onTogglePinned: () => actions.toggleSessionPinned(row.session.id, !row.session.isPinned),
        onArchive: () => actions.archiveSession(row.session.id),
        pause: { paused: Boolean(row.session.paused), onToggle: () => actions.setSessionPaused(row.session.id, !row.session.paused) },
      } : undefined}
    />
  );
}

/**
 * Above All machines' lists: one note per machine that stopped answering (since when its rows are,
 * with Retry), or one box when none answers, and a machine whose list couldn't be read.
 */
export function AllMachinesNotes({ feeds, machines, currentKey }: { feeds: readonly AllMachinesFeed[]; machines: readonly Machine[]; currentKey: string }) {
  const theme = useTheme();
  const machineOf = (key: string) => machines.find(machine => machine.key === key);
  const offline = feeds.filter(feed => feed.offlineSince !== undefined);
  return (
    <>
      {/* Home's connection bar already says why the machine the phone is on can't be reached. */}
      {allOffline(feeds) ? (
        <View testID="all-machines-unreachable" style={[styles.unreachable, { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceRaised }]}>
          <Text variant="headline">Can’t reach your machines</Text>
          <Text variant="subhead" tone="secondary">
            {`None of your ${feeds.length} machines answered. Is Tailscale on on this phone? Pane keeps trying.`}
          </Text>
          <Pressable testID="all-machines-retry" accessibilityRole="button" hitSlop={8} onPress={() => feeds.forEach(feed => feed.retry())}>
            <Text variant="callout" tone="accent" style={styles.bold}>Try again</Text>
          </Pressable>
        </View>
      ) : offline.filter(feed => feed.key !== currentKey).map(feed => (
        <OfflineNote key={feed.key} machine={machineOf(feed.key)} since={feed.offlineSince} hasRows={feed.snapshot !== undefined} onRetry={feed.retry} />
      ))}
      {feeds.map(feed => (feed.error ? (
        <View key={feed.key} style={styles.note}>
          <Notice testID={`all-machines-error-${feed.name}`} danger message={`${feed.name}: ${feed.error}`} action={{ title: 'Try again', onPress: feed.retry }} />
        </View>
      ) : null))}
    </>
  );
}

/** None of the saved machines answers. */
export function allOffline(feeds: readonly AllMachinesFeed[]): boolean {
  return feeds.length > 0 && feeds.every(feed => feed.offlineSince !== undefined);
}

function paneLabel(pane: AllPane, machine: string | undefined): string {
  return [pane.name, pane.repository, pane.session, pane.paused ? 'Paused' : statusPresentation[pane.status].label, machine].filter(Boolean).join(', ');
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
function AllRow({ title, detail, below, spoken = [], label, machine, stale, paused = false, divided = false, leading, trailing, onPress, swipe, testID }: {
  title: string;
  detail: string;
  /** A question's subtitle and reply status, under its detail. */
  below?: ReactNode;
  /** What `below` says, for screen readers. */
  spoken?: string[];
  /** Spoken instead of title and detail. */
  label?: string;
  machine: Machine | undefined;
  stale: boolean;
  /** Grays the title out. */
  paused?: boolean;
  divided?: boolean;
  leading: ReactNode;
  /** Before the machine badge: a Session row's waiting count. */
  trailing?: ReactNode;
  onPress: () => void;
  swipe?: { pinned: boolean; onTogglePinned: () => void; onArchive: () => void; pause?: { paused: boolean; onToggle: () => void } };
  testID: string;
}) {
  const theme = useTheme();
  const row = (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label ?? [title, paused ? 'Paused' : undefined, detail, ...spoken, machine?.name].filter(Boolean).join(', ')}
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
        <Text variant="body" tone={paused ? 'muted' : 'primary'} numberOfLines={1}>{title}</Text>
        <Text variant="footnote" tone="muted" numberOfLines={1}>{detail}</Text>
        {below}
      </View>
      {trailing}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 12, paddingVertical: 8 },
  leading: { width: 12, alignItems: 'center' },
  divider: { position: 'absolute', top: 0, left: 36, right: 0, height: StyleSheet.hairlineWidth },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 10 },
  unreachable: { marginHorizontal: 16, marginBottom: 8, padding: 16, gap: 6 },
  note: { marginHorizontal: 16, marginBottom: 8 },
  empty: { alignItems: 'center', gap: 10, paddingHorizontal: 24, paddingTop: 48 },
});
