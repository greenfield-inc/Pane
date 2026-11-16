import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Machine } from '@/features/machines/machines';
import { MachineMark } from '@/features/machines/MachineMark';
import { useTheme, withAlpha } from '@/theme';
import { Text } from '@/ui';

import { useApprovalSort } from './approvalSortPreference';
import { groupApprovals, machineOfflineLine, type ApprovalEntry, type ApprovalGroup, type ApprovalList, type OfflineMachine } from './approvals';

export type MachineOf = (key: string) => Pick<Machine, 'os' | 'slot' | 'state' | 'name'> | undefined;

/**
 * Home's Needs you list: what waits on you newest first, flat or in one card per Session or project
 * (its name and its machine's mark above it), in the sort chosen on its sheet. Then With the agent
 * (approvals whose reply an agent is reading, P7) and one row per machine that isn't online, neither
 * of which counts. Each home draws its own rows.
 */
export function ApprovalGroups<T extends ApprovalEntry>({ entries, offline = [], machineOf, renderEntry }: {
  entries: readonly T[];
  offline?: readonly OfflineMachine[];
  machineOf: MachineOf;
  /** `divided`: a hairline above every row but a card's first. `list`: the list it is opened from. */
  renderEntry: (entry: T, divided: boolean, list: ApprovalList) => ReactNode;
}) {
  const theme = useTheme();
  const sort = useApprovalSort(state => state.sort);
  const onYou = entries.filter(entry => !entry.withAgent);
  const withAgent = entries.filter(entry => entry.withAgent);
  if (entries.length === 0 && offline.length === 0) return null;
  return (
    <View testID="approvals-section" style={styles.section}>
      {withAgent.length > 0 && onYou.length > 0 ? <ListLabel testID="approvals-waiting-label" title={`Waiting on you · ${onYou.length}`} /> : null}
      {groupApprovals(onYou, sort).map(group => (
        <GroupCard key={group.key} group={group} machineOf={machineOf} tint={withAlpha(theme.colors.warning, 0.09)} render={(entry, divided) => renderEntry(entry, divided, 'waiting')} />
      ))}
      {withAgent.length > 0 ? (
        <View testID="approvals-with-agent" style={styles.group}>
          <ListLabel testID="approvals-with-agent-label" title={`With the agent · ${withAgent.length}`} />
          {groupApprovals(withAgent, sort).map(group => (
            <GroupCard key={group.key} group={group} machineOf={machineOf} tint={theme.colors.surfaceRaised} render={(entry, divided) => renderEntry(entry, divided, 'agent')} />
          ))}
        </View>
      ) : null}
      {offline.map(machine => {
        const mark = machineOf(machine.key);
        return (
          <View key={machine.key} testID={`approvals-offline-${machine.key}`} accessible style={[styles.offline, { borderRadius: theme.radius.card, backgroundColor: theme.colors.surfaceRaised }]}>
            {mark ? <MachineMark os={mark.os} slot={mark.slot} state="dimmed" size={12} /> : null}
            <Text variant="footnote" tone="secondary" style={styles.offlineText}>{machineOfflineLine(machine.name, machine.waiting)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** A list's name over its cards: "Waiting on you · 2", "With the agent · 1". */
function ListLabel({ title, testID }: { title: string; testID: string }) {
  return (
    <View testID={testID} style={styles.groupHeader} accessible accessibilityRole="header">
      <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.groupLabel}>{title}</Text>
    </View>
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

const styles = StyleSheet.create({
  section: { gap: 4 },
  group: { gap: 4, marginTop: 4 },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, minHeight: 22 },
  groupLabel: { flexShrink: 1, fontWeight: '600' },
  card: { overflow: 'hidden' },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingHorizontal: 12, paddingVertical: 10 },
  offlineText: { flex: 1, minWidth: 0 },
});
