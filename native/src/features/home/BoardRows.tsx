import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';

import { sinceLabel } from '@/features/allMachines/allMachinesList';
import type { Machine } from '@/features/machines/machines';
import { MachineMark } from '@/features/machines/MachineMark';
import { PausedBadge, StatusBadge, statusPresentation } from '@/features/panes/StatusBadge';
import { SwipeRow, swipeRowAccessibility } from '@/features/panes/SwipeRow';
import { useTheme } from '@/theme';
import { Icon, Skeleton, Text } from '@/ui';
import type { IconProps } from '@/ui/Icon';

import type { PaneRecentRow } from './statusBoard';

/** How far a row from a machine that went offline fades: the same as a disconnected home. */
export const STALE_OPACITY = 0.45;

type MarkedMachine = Pick<Machine, 'name' | 'os' | 'slot' | 'state'>;

/** "Needs you  3", with an optional control at its end. */
export function BoardHeader({ title, count, right, testID }: { title: string; count?: number; right?: ReactNode; testID?: string }) {
  return (
    <View testID={testID} style={styles.header}>
      <View style={styles.headerTitle} accessible accessibilityRole="header" accessibilityLabel={count === undefined ? title : `${title}, ${count}`}>
        <Text variant="sectionLabel" tone="secondary">{title}</Text>
        {count === undefined ? null : <Text variant="rowDetail" tone="muted" style={styles.tabular}>{String(count)}</Text>}
      </View>
      {right}
    </View>
  );
}

/** A rounded card that holds rows, divided by hairlines. */
export function Card({ children, tint, testID, style }: { children: ReactNode; tint?: string; testID?: string; style?: object }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: tint ?? theme.colors.surfaceRaised }, style]}>
      {children}
    </View>
  );
}

/** The hairline above a card's second and later rows, inset past their leading dot or icon. */
export function RowDivider({ inset = 33 }: { inset?: number }) {
  const theme = useTheme();
  return <View style={[styles.divider, { left: inset, backgroundColor: theme.colors.border }]} />;
}

/** A question or permission request: its status dot, who asks, what, how long ago, and what's under it. */
export function ApprovalRow({ title, detail, below, spoken = [], at, machine, stale = false, done = false, divided, onPress, onArchive, background, testID }: {
  title: string;
  detail: string;
  /** A question's subtitle and reply status. */
  below?: ReactNode;
  /** What `below` says, for screen readers. */
  spoken?: string[];
  /** Epoch ms it was asked, or answered once it's done. */
  at: number;
  /** On All, the machine it's on, marked before its title. */
  machine?: MarkedMachine;
  stale?: boolean;
  /** Answered, held for Undo, or with the agent: a gray dot. */
  done?: boolean;
  divided: boolean;
  onPress: () => void;
  /** Swipe left (or the screen reader's Archive) to archive it; `swipeId` names its swipe action. */
  onArchive?: { swipeId: string; archive: () => void };
  /** The card's colour, over the page's own so the swipe action stays hidden behind it. */
  background?: string;
  testID: string;
}) {
  const theme = useTheme();
  const time = sinceLabel(at, Date.now());
  const content = (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[title, detail, ...spoken, time, machine?.name].filter(Boolean).join(', ')}
      accessibilityHint={stale ? `${machine?.name ?? 'Its machine'} is offline` : undefined}
      {...(onArchive ? swipeRowAccessibility({ onArchive: onArchive.archive }) : {})}
      onPress={onPress}
      style={({ pressed }) => [styles.approval, { opacity: stale ? STALE_OPACITY : 1 }, onArchive && { backgroundColor: background }, pressed && { backgroundColor: theme.colors.surfacePressed }]}
    >
      {divided ? <RowDivider /> : null}
      <View style={styles.approvalDot}><StatusBadge status={done ? 'idle' : 'blocked'} /></View>
      <View style={styles.fill}>
        <View style={styles.titleLine}>
          {machine ? <MachineMark os={machine.os} slot={machine.slot} state={machine.state} size={12} /> : null}
          <Text variant="callout" numberOfLines={1} style={[styles.fill, styles.bold]}>{title}</Text>
          <Text variant="footnote" tone="muted" style={styles.time}>{time}</Text>
        </View>
        <Text variant="rowDetail" tone="muted" numberOfLines={2}>{detail}</Text>
        {below}
      </View>
    </Pressable>
  );
  if (!onArchive) return content;
  return (
    <SwipeRow testIDPrefix="approval" id={onArchive.swipeId} onArchive={onArchive.archive}>
      <View style={{ backgroundColor: theme.colors.background }}>{content}</View>
    </SwipeRow>
  );
}

/** A Working or Ready Pane: its name over agent, time and repository, with a chevron. */
export function ActivityRow({ row, machine, divided, onPress, swipe, background }: {
  row: PaneRecentRow;
  /** The card's colour, over the page's own so its swipe actions stay hidden behind a tint. */
  background?: string;
  machine?: MarkedMachine;
  divided: boolean;
  onPress: () => void;
  swipe?: { onTogglePinned: () => void; onArchive: () => void; onTogglePaused: () => void };
}) {
  const theme = useTheme();
  const { pane } = row;
  const agent = AGENT_LAUNCH_PRESETS.find(preset => preset.id === pane.agent)?.title;
  const detail = [agent, pane.activeAt ? sinceLabel(pane.activeAt, Date.now()) : undefined, pane.repository].filter(Boolean).join(' · ');
  const actions = swipe ? { pinned: pane.pinned, onTogglePinned: swipe.onTogglePinned, onArchive: swipe.onArchive, pause: { paused: Boolean(pane.paused), onToggle: swipe.onTogglePaused } } : undefined;
  const content = (
    <Pressable
      testID={`board-pane-${row.key}`}
      accessibilityRole="button"
      accessibilityLabel={[pane.name, statusPresentation[pane.status].label, detail, pane.session, machine?.name].filter(Boolean).join(', ')}
      accessibilityHint={row.stale ? `${machine?.name ?? 'Its machine'} is offline` : undefined}
      {...(actions ? swipeRowAccessibility(actions) : {})}
      onPress={onPress}
      style={({ pressed }) => [styles.activity, { opacity: row.stale ? STALE_OPACITY : 1, backgroundColor: pressed ? theme.colors.surfacePressed : background ?? theme.colors.surfaceRaised }]}
    >
      {divided ? <RowDivider /> : null}
      <View style={styles.approvalDot}>{pane.paused ? <PausedBadge /> : <StatusBadge status={pane.status} />}</View>
      <View style={styles.fill}>
        <View style={styles.titleLine}>
          {machine ? <MachineMark os={machine.os} slot={machine.slot} state={machine.state} size={12} /> : null}
          <Text variant="rowValue" numberOfLines={1} style={styles.fill}>{pane.name}</Text>
        </View>
        <Text variant="rowDetail" tone="muted" numberOfLines={1}>{detail}</Text>
      </View>
      <Icon ios="chevron.right" android="chevron_right" size={14} />
    </Pressable>
  );
  if (!actions) return content;
  return (
    <SwipeRow testIDPrefix="pane" id={pane.id} {...actions}>
      <View style={{ backgroundColor: theme.colors.background }}>{content}</View>
    </SwipeRow>
  );
}

/** A card row that opens a list or a group: icon, title, count and a chevron (down while open). */
export function GroupRow({ icon, title, count, open, onPress, testID }: {
  icon: Pick<IconProps, 'ios' | 'android'>;
  title: string;
  count?: number;
  /** Set for a group that opens in place: its chevron points down while it is open. */
  open?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  const chevron = open === undefined ? 'right' : open ? 'down' : 'right';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={count === undefined ? title : `${title}, ${count}`}
      accessibilityState={open === undefined ? undefined : { expanded: open }}
      onPress={onPress}
      style={({ pressed }) => [styles.group, pressed && { backgroundColor: theme.colors.surfacePressed }]}
    >
      <View style={styles.groupIcon}><Icon ios={icon.ios} android={icon.android} size={16} color={theme.colors.textSecondary} /></View>
      <Text variant="rowValue" numberOfLines={1} style={[styles.fill, styles.bold]}>{title}</Text>
      {count === undefined ? null : <Text variant="rowDetail" tone="muted" style={styles.tabular}>{String(count)}</Text>}
      <Icon ios={chevron === 'down' ? 'chevron.down' : 'chevron.right'} android={chevron === 'down' ? 'expand_more' : 'chevron_right'} size={13} />
    </Pressable>
  );
}

/** "⌛ 1 stale · ✓ 78 done today ›": opens History. Nothing when both are zero. */
export function HistoryLine({ stale, done, onPress }: { stale: number; done: number; onPress: () => void }) {
  const theme = useTheme();
  if (stale + done === 0) return null;
  const parts = [stale > 0 ? `${stale} stale` : undefined, done > 0 ? `${done} done today` : undefined].filter(Boolean);
  return (
    <Pressable testID="home-history" accessibilityRole="button" accessibilityLabel={`History: ${parts.join(', ')}`} hitSlop={6} onPress={onPress} style={styles.history}>
      {stale > 0 ? (
        <>
          <Icon ios="hourglass" android="hourglass_empty" size={13} color={theme.colors.warning} />
          <Text variant="rowDetail" tone="muted">{`${stale} stale`}</Text>
        </>
      ) : null}
      {stale > 0 && done > 0 ? <Text variant="rowDetail" tone="muted">·</Text> : null}
      {done > 0 ? (
        <>
          <Icon ios="checkmark.circle" android="check_circle" size={13} color={theme.colors.success} />
          <Text variant="rowDetail" tone="muted">{`${done} done today`}</Text>
        </>
      ) : null}
      <View style={styles.fill} />
      <Icon ios="chevron.right" android="chevron_right" size={11} />
    </Pressable>
  );
}

/** A card's quiet line when its list is empty. */
export function EmptyCard({ title, detail, testID }: { title: string; detail?: string; testID: string }) {
  return (
    <Card testID={testID} style={styles.empty}>
      <Text variant="rowValue" tone="secondary" style={[styles.bold, styles.center]}>{title}</Text>
      {detail ? <Text variant="rowDetail" tone="muted" style={styles.center}>{detail}</Text> : null}
    </Card>
  );
}

/** A card of Pane rows as a skeleton, in ActivityRow's footprint. */
export function CardSkeleton({ testID, label }: { testID: string; label: string }) {
  const theme = useTheme();
  const lines = { height: theme.typography.rowValue.lineHeight + theme.typography.rowDetail.lineHeight };
  return (
    <View testID={testID} accessible accessibilityLabel={label}>
      <Card>
        {[0.5, 0.65, 0.4].map((width, index) => (
          <View key={width} style={styles.activity}>
            {index > 0 ? <RowDivider /> : null}
            <View style={styles.approvalDot}><Skeleton width={8} height={8} radius={4} /></View>
            <View style={[styles.fill, styles.boneLines, lines]}>
              <Skeleton width={`${width * 100}%`} height={14} />
              <Skeleton width="35%" height={12} />
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

/**
 * The board below the tiles while its first read runs: a header over a card of Pane rows, or with
 * `groups` (one machine's All panes) the cards that open Sessions, Repositories and Archived.
 */
export function BoardSkeleton({ groups }: { groups: boolean }) {
  if (groups) {
    return (
      <View testID="board-skeleton" accessible accessibilityLabel="Loading panes">
        {[0.3, 0.4, 0.25].map(width => (
          <Card key={width} style={styles.groupCard}>
            <View style={styles.group}>
              <View style={styles.groupIcon}><Skeleton width={16} height={16} /></View>
              <Skeleton width={`${width * 100}%`} height={14} />
            </View>
          </Card>
        ))}
      </View>
    );
  }
  return (
    <View>
      <View style={styles.header}><Skeleton width={84} height={14} /></View>
      <CardSkeleton testID="board-skeleton" label="Loading panes" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '600' },
  tabular: { fontVariant: ['tabular-nums'] },
  center: { textAlign: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingHorizontal: 8, marginTop: 18, marginBottom: 6 },
  headerTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: { overflow: 'hidden' },
  divider: { position: 'absolute', top: 0, right: 0, height: StyleSheet.hairlineWidth },
  approval: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingHorizontal: 14, paddingVertical: 11 },
  // Centres the dot on the title's first line.
  approvalDot: { height: 20, width: 8, justifyContent: 'center' },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  time: { fontVariant: ['tabular-nums'] },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 54, paddingHorizontal: 14, paddingVertical: 8 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14 },
  groupIcon: { width: 18, alignItems: 'center' },
  groupCard: { marginTop: 12 },
  boneLines: { justifyContent: 'space-evenly' },
  history: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 8, marginTop: 4 },
  empty: { paddingHorizontal: 16, paddingVertical: 18, gap: 4, alignItems: 'center' },
});
