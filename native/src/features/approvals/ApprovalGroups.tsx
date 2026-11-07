import { useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';

import type { Machine } from '@/features/machines/machines';
import { MachineMark } from '@/features/machines/MachineMark';
import { SectionHeader } from '@/features/panes/PaneKit';
import { useTheme, withAlpha } from '@/theme';
import { Icon, Text } from '@/ui';

import { useApprovalSort } from './approvalSortPreference';
import { APPROVAL_SORTS, groupApprovals, machineOfflineLine, waitingCounts, type ApprovalEntry, type ApprovalGroup, type ApprovalList, type ApprovalSort, type OfflineMachine } from './approvals';

type MachineOf = (key: string) => Pick<Machine, 'os' | 'slot' | 'state' | 'name'> | undefined;

/**
 * Home's Approvals: the sort menu, then the entries newest first, flat or in one card per Session or
 * project (its name and its machine's mark above it). Then one row per machine that isn't online, and
 * the collapsed Stale and Answered groups, none of which count. Each home draws its own rows.
 */
export function ApprovalGroups<T extends ApprovalEntry>({ entries, stale = [], answered = [], offline = [], machineOf, renderEntry }: {
  entries: readonly T[];
  stale?: readonly T[];
  answered?: readonly T[];
  offline?: readonly OfflineMachine[];
  machineOf: MachineOf;
  /** `divided`: a hairline above every row but a card's first. `list`: the list it is opened from. */
  renderEntry: (entry: T, divided: boolean, list: ApprovalList) => ReactNode;
}) {
  const theme = useTheme();
  const sort = useApprovalSort(state => state.sort);
  if (entries.length === 0 && stale.length === 0 && answered.length === 0 && offline.length === 0) return null;
  return (
    <View testID="approvals-section" style={styles.section}>
      {/* What waits from every Session plus what waits outside one; answers held for Undo don't count. */}
      <SectionHeader title="Approvals" count={waitingCounts(entries).total} first />
      <SortMenu sort={sort} />
      {groupApprovals(entries, sort).map(group => (
        <GroupCard key={group.key} group={group} machineOf={machineOf} tint={withAlpha(theme.colors.warning, 0.09)} render={(entry, divided) => renderEntry(entry, divided, 'waiting')} />
      ))}
      {offline.map(machine => {
        const mark = machineOf(machine.key);
        return (
          <View key={machine.key} testID={`approvals-offline-${machine.key}`} accessible style={[styles.offline, { borderRadius: theme.radius.card, backgroundColor: theme.colors.surfaceRaised }]}>
            {mark ? <MachineMark os={mark.os} slot={mark.slot} state="dimmed" size={12} /> : null}
            <Text variant="footnote" tone="secondary" style={styles.offlineText}>{machineOfflineLine(machine.name, machine.waiting)}</Text>
          </View>
        );
      })}
      <CollapsedGroup testID="approvals-stale" title="Stale" entries={stale} groups={[{ key: 'stale', label: '', entries: [...stale] }]} machineOf={machineOf} render={(entry, divided) => renderEntry(entry, divided, 'stale')} />
      <CollapsedGroup testID="approvals-answered" title="Answered" entries={answered} groups={groupApprovals(answered, sort)} machineOf={machineOf} render={(entry, divided) => renderEntry(entry, divided, 'answered')} />
    </View>
  );
}

/** The sort's name, opening the phone's own list of the three. */
function SortMenu({ sort }: { sort: ApprovalSort }) {
  const theme = useTheme();
  const setSort = useApprovalSort(state => state.setSort);
  const label = APPROVAL_SORTS.find(option => option.id === sort)?.label ?? '';
  const open = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Sort approvals', options: [...APPROVAL_SORTS.map(option => option.label), 'Cancel'], cancelButtonIndex: APPROVAL_SORTS.length },
        index => {
          const choice = APPROVAL_SORTS[index];
          if (choice) setSort(choice.id);
        },
      );
    } else {
      // Android's alert holds three buttons: tapping outside it cancels.
      Alert.alert('Sort approvals', undefined, APPROVAL_SORTS.map(option => ({ text: option.label, onPress: () => setSort(option.id) })), { cancelable: true });
    }
  };
  return (
    <Pressable testID="approvals-sort" accessibilityRole="button" accessibilityLabel={`Sort approvals: ${label}`} hitSlop={8} onPress={open} style={styles.sort}>
      <Text variant="footnote" tone="secondary" numberOfLines={1}>{label}</Text>
      <Icon ios="chevron.down" android="expand_more" size={12} color={theme.colors.textMuted} />
    </Pressable>
  );
}

/** One group's card, with its header unless it's a flat list's. */
function GroupCard<T extends ApprovalEntry>({ group, machineOf, tint, render }: { group: ApprovalGroup<T>; machineOf: MachineOf; tint: string; render: (entry: T, divided: boolean) => ReactNode }) {
  const theme = useTheme();
  const machine = group.machineKey ? machineOf(group.machineKey) : undefined;
  return (
    <View testID={`approval-group-${group.key}`} style={styles.group}>
      {group.label ? (
        <View style={styles.groupHeader} accessible accessibilityRole="header" accessibilityLabel={machine ? `${group.label}, on ${machine.name}, ${group.entries.length}` : `${group.label}, ${group.entries.length}`}>
          {machine ? <MachineMark os={machine.os} slot={machine.slot} state={machine.state} size={12} /> : null}
          <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.groupLabel}>{group.label}</Text>
          <Text variant="footnote" tone="muted">{group.entries.length}</Text>
        </View>
      ) : null}
      <View style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: tint }]}>
        {group.entries.map((entry, index) => <View key={entry.key}>{render(entry, index > 0)}</View>)}
      </View>
    </View>
  );
}

/** "Stale · 3": closed until tapped. Nothing when it's empty. */
function CollapsedGroup<T extends ApprovalEntry>({ title, entries, groups, machineOf, render, testID }: { title: string; entries: readonly T[]; groups: ApprovalGroup<T>[]; machineOf: MachineOf; render: (entry: T, divided: boolean) => ReactNode; testID: string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <View testID={testID} style={styles.group}>
      <Pressable testID={`${testID}-toggle`} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${title}, ${entries.length}`} onPress={() => setOpen(!open)} style={styles.groupHeader}>
        <Icon ios={open ? 'chevron.down' : 'chevron.right'} android={open ? 'expand_more' : 'chevron_right'} size={12} color={theme.colors.textMuted} />
        <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.groupLabel}>{`${title} · ${entries.length}`}</Text>
      </Pressable>
      {open ? groups.map(group => <GroupCard key={group.key} group={group} machineOf={machineOf} tint={theme.colors.surfaceRaised} render={render} />) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 12 },
  group: { gap: 4, marginTop: 4 },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, minHeight: 22 },
  groupLabel: { flexShrink: 1, fontWeight: '600' },
  sort: { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 4, paddingHorizontal: 4, minHeight: 22 },
  card: { overflow: 'hidden' },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingHorizontal: 12, paddingVertical: 10 },
  offlineText: { flex: 1, minWidth: 0 },
});
