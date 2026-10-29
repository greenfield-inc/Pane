import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import type { Machine } from './machines';
import { MachineMark } from './MachineMark';
import { useSelectMachine } from './useMachines';

// Chips grow with the text size up to this, so the row stays one line you can scroll.
const MAX_TEXT_SCALE = 1.6;

/**
 * One chip per machine under the home header; one tap switches. The current machine's chip is
 * filled, and its mark pulses and dims with the connection; past the grace window the connection
 * bar under the header says what happened and offers Retry. Hidden with a single machine.
 */
export function MachineChips({ machines }: { machines: Machine[] }) {
  const { select, connecting } = useSelectMachine();

  return (
    <LegendList
      testID="machine-chips"
      horizontal
      data={machines}
      keyExtractor={machine => machine.key}
      estimatedItemSize={120}
      showsHorizontalScrollIndicator={false}
      style={styles.list}
      contentContainerStyle={styles.content}
      renderItem={({ item: machine }) => (
        <MachineChip machine={machine} connecting={connecting === machine.tailnet?.name} onPress={() => select(machine)} />
      )}
    />
  );
}

function MachineChip({ machine, connecting, onPress }: { machine: Machine; connecting: boolean; onPress: () => void }) {
  const theme = useTheme();
  const filled = machine.current;
  const inactive = !machine.selectable && !machine.current;
  const openDetails = () => router.push({ pathname: '/machine/[key]', params: { key: machine.key } });
  return (
    <Pressable
      testID={`machine-chip-${machine.name}`}
      accessibilityRole="button"
      accessibilityLabel={`${machine.name}, ${machine.status}`}
      accessibilityHint={machine.current ? undefined : machine.profile ? 'Switches to this machine' : 'Connects to this machine'}
      accessibilityState={{ selected: filled, disabled: inactive, busy: connecting }}
      onPress={onPress}
      onLongPress={openDetails}
      accessibilityActions={[{ name: 'details', label: 'Machine details' }]}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'details') openDetails(); }}
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
      <Text variant="callout" numberOfLines={1} maxFontSizeMultiplier={MAX_TEXT_SCALE} style={[styles.name, { color: filled ? theme.colors.background : theme.colors.text }]}>{machine.name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  content: { gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  chip: { minHeight: 34, borderRadius: 17, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
  // A spinner swaps in for the mark in the same box.
  mark: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  spinner: { transform: [{ scale: 0.7 }] },
  name: { fontWeight: '600' },
});
