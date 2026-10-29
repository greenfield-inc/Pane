import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { useTheme, withAlpha } from '@/theme';
import { Text } from '@/ui';

import { shortMachineName, type Machine } from './machines';
import { MachineMark } from './MachineMark';
import { useSelectMachine } from './useMachines';

// Chips grow with the text size up to this, so the row stays one line you can scroll.
const MAX_TEXT_SCALE = 1.6;
const NAME_LENGTH = 10;
const CURRENT = 34;
const FADE_MS = 180;

// Switching remounts home for the new machine; the row comes back where you left it.
let scrollOffset = 0;

/**
 * The current machine at the left as its mark alone, a divider, then a chip for every other
 * machine in its saved order; one tap switches. The current mark pulses and dims with the
 * connection; past the grace window the connection bar under the header says what happened and
 * offers Retry. Hidden with a single machine.
 */
export function MachineChips({ machines }: { machines: Machine[] }) {
  const theme = useTheme();
  const { select, connecting } = useSelectMachine();
  const current = machines.find(machine => machine.current);

  return (
    <View style={styles.row}>
      {current ? <CurrentMachine machine={current} /> : null}
      <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
      <LegendList
        testID="machine-chips"
        horizontal
        data={machines.filter(machine => !machine.current)}
        keyExtractor={machine => machine.key}
        estimatedItemSize={120}
        initialScrollOffset={scrollOffset}
        onScroll={event => { scrollOffset = event.nativeEvent.contentOffset.x; }}
        showsHorizontalScrollIndicator={false}
        style={styles.list}
        contentContainerStyle={styles.content}
        renderItem={({ item: machine }) => (
          <MachineChip machine={machine} connecting={connecting === machine.tailnet?.name} onPress={() => select(machine)} />
        )}
      />
    </View>
  );
}

const openDetails = (machine: Machine) => router.push({ pathname: '/machine/[key]', params: { key: machine.key } });

/** The current machine's mark on its own color; a new machine cross-fades in the same box. */
function CurrentMachine({ machine }: { machine: Machine }) {
  const theme = useTheme();
  const tint = theme.machine[machine.slot % theme.machine.length];
  return (
    <Pressable
      testID="machine-current"
      accessibilityRole="button"
      accessibilityLabel={`${machine.name}, ${machine.status}`}
      accessibilityHint="Opens machine details"
      accessibilityState={{ selected: true }}
      onPress={() => openDetails(machine)}
      style={styles.current}
    >
      <Animated.View
        key={machine.key}
        entering={FadeIn.duration(FADE_MS).reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(FADE_MS).reduceMotion(ReduceMotion.System)}
        style={[styles.currentFill, { backgroundColor: withAlpha(tint, 0.18) }]}
      >
        <MachineMark os={machine.os} slot={machine.slot} state={machine.state} size={16} />
      </Animated.View>
    </Pressable>
  );
}

function MachineChip({ machine, connecting, onPress }: { machine: Machine; connecting: boolean; onPress: () => void }) {
  const theme = useTheme();
  const inactive = !machine.selectable;
  return (
    <Pressable
      testID={`machine-chip-${machine.name}`}
      accessibilityRole="button"
      accessibilityLabel={`${machine.name}, ${machine.status}`}
      accessibilityHint={machine.profile ? 'Switches to this machine' : 'Connects to this machine'}
      accessibilityState={{ disabled: inactive, busy: connecting }}
      onPress={onPress}
      onLongPress={() => openDetails(machine)}
      accessibilityActions={[{ name: 'details', label: 'Machine details' }]}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'details') openDetails(machine); }}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised, opacity: inactive ? 0.4 : 1 },
      ]}
    >
      <View style={styles.mark}>
        {connecting
          ? <ActivityIndicator size="small" color={theme.colors.textMuted} style={styles.spinner} />
          : <MachineMark os={machine.os} slot={machine.slot} state={machine.state} />}
      </View>
      <Text variant="callout" numberOfLines={1} maxFontSizeMultiplier={MAX_TEXT_SCALE} style={styles.name}>{shortMachineName(machine.name, NAME_LENGTH)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingTop: 4, paddingBottom: 12 },
  current: { width: CURRENT, height: CURRENT },
  // Absolute, so the old and new marks overlap while they cross-fade.
  currentFill: { ...StyleSheet.absoluteFill, borderRadius: CURRENT / 2, alignItems: 'center', justifyContent: 'center' },
  divider: { width: StyleSheet.hairlineWidth * 2, height: 20, marginLeft: 10 },
  list: { flexGrow: 0, flexShrink: 1 },
  content: { gap: 8, paddingLeft: 10, paddingRight: 16 },
  chip: { minHeight: 34, borderRadius: 17, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
  // A spinner swaps in for the mark in the same box.
  mark: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  spinner: { transform: [{ scale: 0.7 }] },
  name: { fontWeight: '600' },
});
