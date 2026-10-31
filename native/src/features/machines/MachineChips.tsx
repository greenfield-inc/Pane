import { LegendList } from '@legendapp/list/react-native';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

import { useMachinePrefs } from './machinePrefs';
import { shortMachineName, type Machine } from './machines';
import { MachineMark } from './MachineMark';
import { useSelectMachine } from './useMachines';

// Chips grow with the text size up to this, so the row stays one line you can scroll.
const MAX_TEXT_SCALE = 1.6;
const NAME_LENGTH = 10;

// Switching remounts home for the new machine; the row comes back where you left it.
let scrollOffset = 0;

type Chip = { kind: 'all' } | { kind: 'machine'; machine: Machine };

/**
 * A filter row: All first (when two or more machines are saved), then every machine in its saved
 * order. The selected chip is filled: All, or the machine the phone is on. Tapping another saved
 * machine switches to it; a machine you never connected to connects in that tap. Tapping the
 * selected machine, or long-pressing any, opens Machine details. Hidden with a single machine.
 */
export function MachineChips({ machines, showAll }: { machines: Machine[]; showAll: boolean }) {
  const { select, connecting } = useSelectMachine();
  const all = useMachinePrefs(state => state.all) && showAll;
  const setAll = useMachinePrefs(state => state.setAll);
  const chips: Chip[] = [...(showAll ? [{ kind: 'all' as const }] : []), ...machines.map(machine => ({ kind: 'machine' as const, machine }))];

  const press = (machine: Machine) => {
    if (machine.current) {
      if (all) setAll(false);
      else openDetails(machine);
      return;
    }
    // Picking one saved machine leaves All machines; a new machine joins the list it is on.
    if (machine.profile && machine.selectable) setAll(false);
    select(machine);
  };

  return (
    <LegendList
      testID="machine-chips"
      horizontal
      data={chips}
      keyExtractor={chip => (chip.kind === 'all' ? 'all' : chip.machine.key)}
      estimatedItemSize={120}
      initialScrollOffset={scrollOffset}
      onScroll={event => { scrollOffset = event.nativeEvent.contentOffset.x; }}
      showsHorizontalScrollIndicator={false}
      style={styles.list}
      contentContainerStyle={styles.content}
      renderItem={({ item: chip }) => chip.kind === 'all'
        ? <AllChip selected={all} onPress={() => setAll(true)} />
        : (
          <MachineChip
            machine={chip.machine}
            selected={!all && chip.machine.current}
            connecting={connecting === chip.machine.tailnet?.name}
            onPress={() => press(chip.machine)}
          />
        )}
    />
  );
}

const openDetails = (machine: Machine) => router.push({ pathname: '/machine/[key]', params: { key: machine.key } });

function AllChip({ selected, onPress }: { selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const tint = selected ? theme.colors.background : theme.colors.text;
  return (
    <Pressable
      testID="machine-chip-all"
      accessibilityRole="button"
      accessibilityLabel="All machines"
      accessibilityHint="Lists every machine's Panes"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, { backgroundColor: chipBackground(theme, selected, pressed) }]}
    >
      <View style={styles.mark}>
        <Icon ios="square.3.layers.3d" android="layers" size={15} color={tint} />
      </View>
      <Text variant="callout" maxFontSizeMultiplier={MAX_TEXT_SCALE} style={[styles.name, { color: tint }]}>All</Text>
    </Pressable>
  );
}

function MachineChip({ machine, selected, connecting, onPress }: { machine: Machine; selected: boolean; connecting: boolean; onPress: () => void }) {
  const theme = useTheme();
  const inactive = !machine.selectable && !machine.current;
  return (
    <Pressable
      testID={`machine-chip-${machine.name}`}
      accessibilityRole="button"
      accessibilityLabel={`${machine.name}, ${machine.status}`}
      accessibilityHint={selected ? 'Opens machine details' : machine.current ? 'Lists this machine only' : machine.profile ? 'Switches to this machine' : 'Connects to this machine'}
      accessibilityState={{ selected, disabled: inactive, busy: connecting }}
      onPress={onPress}
      onLongPress={() => openDetails(machine)}
      accessibilityActions={[{ name: 'details', label: 'Machine details' }]}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'details') openDetails(machine); }}
      style={({ pressed }) => [styles.chip, { backgroundColor: chipBackground(theme, selected, pressed), opacity: inactive ? 0.4 : 1 }]}
    >
      <View style={styles.mark}>
        {connecting
          ? <ActivityIndicator size="small" color={theme.colors.textMuted} style={styles.spinner} />
          : <MachineMark os={machine.os} slot={machine.slot} state={machine.state} color={selected ? theme.colors.background : undefined} />}
      </View>
      <Text
        variant="callout"
        numberOfLines={1}
        maxFontSizeMultiplier={MAX_TEXT_SCALE}
        style={[styles.name, { color: selected ? theme.colors.background : theme.colors.text }]}
      >
        {shortMachineName(machine.name, NAME_LENGTH)}
      </Text>
    </Pressable>
  );
}

function chipBackground(theme: ReturnType<typeof useTheme>, selected: boolean, pressed: boolean): string {
  if (selected) return theme.colors.text;
  return pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised;
}

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  content: { gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  chip: { minHeight: 34, borderRadius: 17, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13 },
  // A spinner swaps in for the mark in the same box.
  mark: { width: 15, height: 15, alignItems: 'center', justifyContent: 'center' },
  spinner: { transform: [{ scale: 0.7 }] },
  name: { fontWeight: '600' },
});
