import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { Machine } from '@/features/machines/machines';
import { MachineMark } from '@/features/machines/MachineMark';
import { SectionHeader } from '@/features/panes/PaneKit';
import { useTheme, withAlpha } from '@/theme';
import { Text } from '@/ui';

import { groupBySession, waitingCounts, type ApprovalEntry } from './approvals';

/**
 * Home's Approvals: one card per Session (its name and its machine's mark above it), oldest
 * first, with "Not in a Session" last. Each home draws its own rows.
 */
export function ApprovalGroups<T extends ApprovalEntry>({ entries, machineOf, renderEntry }: {
  entries: readonly T[];
  machineOf: (key: string) => Pick<Machine, 'os' | 'slot' | 'state' | 'name'> | undefined;
  /** `divided`: a hairline above every row but a card's first. */
  renderEntry: (entry: T, divided: boolean) => ReactNode;
}) {
  const theme = useTheme();
  if (entries.length === 0) return null;
  return (
    <View testID="approvals-section" style={styles.section}>
      {/* What waits from every Session plus what waits outside one; answers held for Undo don't count. */}
      <SectionHeader title="Approvals" count={waitingCounts(entries).total} first />
      {groupBySession(entries).map(group => {
        const machine = group.machineKey ? machineOf(group.machineKey) : undefined;
        return (
          <View key={group.key} testID={`approval-group-${group.key}`} style={styles.group}>
            <View style={styles.groupHeader} accessible accessibilityRole="header" accessibilityLabel={machine ? `${group.label}, on ${machine.name}` : group.label}>
              {machine ? <MachineMark os={machine.os} slot={machine.slot} state={machine.state} size={12} /> : null}
              <Text variant="footnote" tone="secondary" numberOfLines={1} style={styles.groupLabel}>{group.label}</Text>
            </View>
            <View style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: withAlpha(theme.colors.warning, 0.09) }]}>
              {group.entries.map((entry, index) => <View key={entry.key}>{renderEntry(entry, index > 0)}</View>)}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 12 },
  group: { gap: 4, marginTop: 4 },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, minHeight: 22 },
  groupLabel: { flexShrink: 1, fontWeight: '600' },
  card: { overflow: 'hidden' },
});
