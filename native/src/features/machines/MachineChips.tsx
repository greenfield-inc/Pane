import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Text } from '@/ui';

import type { Machine } from './machines';
import { MachineMark } from './MachineMark';
import { useSelectMachine } from './useMachines';

type ChipItem = { type: 'machine'; machine: Machine } | { type: 'connection' };

/**
 * One chip per machine under the home header; one tap switches. The current machine's chip is
 * filled, and its Retry sits right after it. Hidden with a single machine, where home shows the
 * Retry in the header instead.
 */
export function MachineChips({ machines }: { machines: Machine[] }) {
  const { select, connecting } = useSelectMachine();
  const items: ChipItem[] = machines.flatMap(machine => (machine.current
    ? [{ type: 'machine' as const, machine }, { type: 'connection' as const }]
    : [{ type: 'machine' as const, machine }]));

  return (
    <LegendList
      testID="machine-chips"
      horizontal
      data={items}
      keyExtractor={item => (item.type === 'machine' ? item.machine.key : 'connection')}
      getItemType={item => item.type}
      estimatedItemSize={120}
      showsHorizontalScrollIndicator={false}
      style={styles.list}
      contentContainerStyle={styles.content}
      renderItem={({ item }) => (item.type === 'connection'
        ? <ConnectionAccessory />
        : <MachineChip machine={item.machine} connecting={connecting === item.machine.tailnet?.name} onPress={() => select(item.machine)} />)}
    />
  );
}

function MachineChip({ machine, connecting, onPress }: { machine: Machine; connecting: boolean; onPress: () => void }) {
  const theme = useTheme();
  const filled = machine.current;
  const inactive = !machine.selectable && !machine.current;
  return (
    <Pressable
      testID={`machine-chip-${machine.name}`}
      accessibilityRole="button"
      accessibilityLabel={`${machine.name}, ${machine.status}`}
      accessibilityHint={machine.current ? undefined : machine.profile ? 'Switches to this machine' : 'Connects to this machine'}
      accessibilityState={{ selected: filled, disabled: inactive, busy: connecting }}
      onPress={onPress}
      onLongPress={() => router.push({ pathname: '/machine/[key]', params: { key: machine.key } })}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: filled ? theme.colors.text : pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised, opacity: inactive ? 0.4 : 1 },
      ]}
    >
      <View style={styles.mark}>
        {connecting
          ? <ActivityIndicator size="small" color={theme.colors.textMuted} style={styles.spinner} />
          : <MachineMark os={machine.os} slot={machine.slot} state={machine.state} color={filled ? theme.colors.background : undefined} />}
      </View>
      <Text variant="callout" numberOfLines={1} style={[styles.name, { color: filled ? theme.colors.background : theme.colors.text }]}>{machine.name}</Text>
    </Pressable>
  );
}

/** Retry, or that the machine is updating, while the current machine isn't connected. */
export function ConnectionAccessory() {
  const { client, connection } = useDaemon();
  if (connection.status === 'connected') return null;
  if (connection.updateIntent) {
    return <Text testID="machine-updating" variant="footnote" tone="secondary" style={styles.accessory}>Updating Pane…</Text>;
  }
  if (connection.status !== 'error' && connection.status !== 'reconnecting') return null;
  return (
    <Pressable testID="machine-retry" accessibilityRole="button" accessibilityLabel="Retry now" hitSlop={8} onPress={() => client.retryNow()} style={styles.accessory}>
      <Text variant="callout" tone="accent" style={styles.name}>Retry</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  content: { gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  chip: { height: 34, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
  // A spinner swaps in for the mark in the same box.
  mark: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  spinner: { transform: [{ scale: 0.7 }] },
  name: { fontWeight: '600' },
  accessory: { height: 34, justifyContent: 'center', paddingHorizontal: 4 },
});
