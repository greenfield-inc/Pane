import { LegendList } from '@legendapp/list/react-native';
import { useIsFocused } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { buildAllMachinesList, sinceLabel } from '@/features/allMachines/allMachinesList';
import { openWaitingRow, waitingRowText } from '@/features/allMachines/AllMachinesRows';
import { MachineMark } from '@/features/machines/MachineMark';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { Card, EmptyCard, RowDivider, STALE_OPACITY } from './BoardRows';
import { todayBuckets } from './statusBoard';
import { useHomeFeeds } from './useHomeData';

type HistoryTab = 'done' | 'stale';

/**
 * Home's History, from the "1 stale · 78 done today" line: today's answered and closed approvals by
 * time of day, or the stale ones (waiting three days unanswered). On All it covers every machine.
 */
export function HistoryScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { feeds, all, chipMachines, here } = useHomeFeeds({ active: focused });
  const { answered, staleQuestions } = buildAllMachinesList(feeds, '');
  const [picked, setPicked] = useState<HistoryTab | undefined>(undefined);
  const tab: HistoryTab = picked ?? (answered.length === 0 && staleQuestions.length > 0 ? 'stale' : 'done');
  const now = Date.now();
  const groups = tab === 'done'
    ? todayBuckets(answered, row => row.item.resolvedAt ?? row.item.createdAt, now)
    : staleQuestions.length > 0 ? [{ label: '', rows: staleQuestions }] : [];
  const machineOf = (key: string) => (all ? chipMachines.find(machine => machine.key === key) : undefined);

  return (
    <LegendList
      testID="history-list"
      data={groups}
      keyExtractor={group => group.label || 'stale'}
      estimatedItemSize={240}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      ListHeaderComponent={(
        <View style={[styles.segments, { backgroundColor: theme.colors.surfaceRaised }]} accessibilityRole="tablist">
          {([['done', `Done today · ${answered.length}`], ['stale', `Stale · ${staleQuestions.length}`]] as const).map(([id, label]) => {
            const on = id === tab;
            return (
              <Pressable
                key={id}
                testID={`history-tab-${id}`}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setPicked(id)}
                style={[styles.segment, on && { backgroundColor: theme.colors.surfacePressed }]}
              >
                <Text variant="rowDetail" style={[styles.bold, { color: on ? theme.colors.text : theme.colors.textMuted }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      ListEmptyComponent={(
        <EmptyCard
          testID="history-empty"
          title={tab === 'done' ? 'Nothing done today yet' : 'Nothing stale'}
          detail={tab === 'done' ? 'Approvals you or Autopilot answer today show here.' : 'Approvals that wait three days unanswered show here.'}
        />
      )}
      renderItem={({ item: group }) => (
        <View>
          {group.label ? <Text variant="footnote" tone="muted" style={styles.groupLabel} accessibilityRole="header">{group.label.toUpperCase()}</Text> : <View style={styles.groupGap} />}
          <Card>
            {group.rows.map((row, index) => {
              const { title, detail } = waitingRowText(row);
              const machine = machineOf(row.machineKey);
              const time = sinceLabel(tab === 'done' ? row.item.resolvedAt ?? row.item.createdAt : row.item.createdAt, now);
              return (
                <Pressable
                  key={row.key}
                  testID={`history-row-${row.item.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={[title, detail, time, machine?.name].filter(Boolean).join(', ')}
                  onPress={() => openWaitingRow(row, tab === 'done' ? 'answered' : 'stale', here.profile.id)}
                  style={({ pressed }) => [styles.row, { opacity: row.stale ? STALE_OPACITY : 1 }, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                >
                  {index > 0 ? <RowDivider inset={40} /> : null}
                  <View style={styles.icon}>
                    {tab === 'done'
                      ? <Icon ios="checkmark.circle" android="check_circle" size={15} color={theme.colors.neutral} />
                      : <Icon ios="hourglass" android="hourglass_empty" size={15} color={theme.colors.warning} />}
                  </View>
                  <View style={styles.fill}>
                    <View style={styles.titleLine}>
                      {machine ? <MachineMark os={machine.os} slot={machine.slot} state={machine.state} size={12} /> : null}
                      <Text variant="callout" tone="secondary" numberOfLines={1} style={[styles.fill, styles.bold]}>{title}</Text>
                      <Text variant="footnote" tone="muted">{time}</Text>
                    </View>
                    <Text variant="rowDetail" tone="muted" numberOfLines={2}>{detail}</Text>
                  </View>
                </Pressable>
              );
            })}
          </Card>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '600' },
  content: { paddingHorizontal: 12, paddingTop: 4 },
  segments: { flexDirection: 'row', gap: 2, padding: 2, borderRadius: 9, marginHorizontal: 4 },
  segment: { flex: 1, height: 32, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  groupLabel: { fontWeight: '600', letterSpacing: 0.2, paddingHorizontal: 8, paddingTop: 18, paddingBottom: 6 },
  groupGap: { height: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingHorizontal: 14, paddingVertical: 11 },
  icon: { width: 15, height: 20, justifyContent: 'center' },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
