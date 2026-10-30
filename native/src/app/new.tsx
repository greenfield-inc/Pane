import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMachinePrefs } from '@/features/machines/machinePrefs';
import type { Machine } from '@/features/machines/machines';
import { MachineMark } from '@/features/machines/MachineMark';
import { useMachines } from '@/features/machines/useMachines';
import { CreatePaneForm } from '@/features/panes/CreatePaneSheet';
import { CreateSessionForm } from '@/features/sessions/CreateSessionSheet';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

type Kind = 'session' | 'pane';

/**
 * Home's + (and a repository's own +): one sheet for a Session or a Pane. The toggle picks which,
 * the machine row picks where (starting on the last machine New created on), and the form below
 * is that machine's. Create goes straight to the picked machine; then the phone switches there and
 * opens what it made.
 */
export default function NewSheet() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ kind?: Kind; projectId?: string }>();
  const machines = useMachines();
  const lastNew = useMachinePrefs(state => state.lastNew);
  const setLastNew = useMachinePrefs(state => state.setLastNew);
  const saved = machines.filter(machine => machine.profile);
  const current = saved.find(machine => machine.current);
  // A repository's own + names a repository on the machine the phone is on.
  const projectId = params.projectId ? Number(params.projectId) : undefined;
  const last = saved.find(machine => machine.key === lastNew);
  const [pickedKey, setPickedKey] = useState(() => (projectId === undefined && last && reachable(last) ? last.key : current?.key));
  const [kind, setKind] = useState<Kind>(params.kind ?? 'session');
  const machine = saved.find(candidate => candidate.key === pickedKey) ?? current;

  const created = (target: { paneId: string } | { sessionId: string }) => {
    if (!machine?.profile) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setLastNew(machine.key);
    if (!machine.current) {
      // Switch to the machine it was made on, then open it there.
      router.replace({ pathname: '/open', params: { host: machine.key, ...target } });
      return;
    }
    router.back();
    if ('paneId' in target) router.push({ pathname: '/pane/[paneId]', params: { paneId: target.paneId } });
    else router.push({ pathname: '/session/[sessionId]', params: { sessionId: target.sessionId } });
  };

  return (
    <ScrollView
      testID="new-sheet"
      style={{ backgroundColor: theme.colors.surface }}
      contentContainerStyle={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.header}>
        <Pressable testID="new-cancel" accessibilityRole="button" hitSlop={10} onPress={() => router.back()} style={styles.headerSide}>
          <Text variant="body" tone="accent">Cancel</Text>
        </Pressable>
        <Text variant="headline" accessibilityRole="header">New</Text>
        <View style={styles.headerSide} />
      </View>

      <View accessibilityRole="tablist" style={[styles.toggle, { borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfaceRaised }]}>
        <Segment testID="sessions-new" title="Session" ios="bubble.left" android="chat_bubble" selected={kind === 'session'} onPress={() => setKind('session')} />
        <Segment testID="panes-new" title="Pane" ios="arrow.triangle.branch" android="call_split" selected={kind === 'pane'} onPress={() => setKind('pane')} />
      </View>

      <View style={styles.section}>
        <Text variant="callout" tone="secondary" style={styles.bold}>Machine</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Machine" style={styles.machines}>
          {saved.map(candidate => (
            <MachineOption
              key={candidate.key}
              machine={candidate}
              selected={candidate.key === machine?.key}
              onPress={() => setPickedKey(candidate.key)}
            />
          ))}
        </View>
        {last ? <Text variant="footnote" tone="muted">{`${last.name} was your last pick.`}</Text> : null}
      </View>

      {/* Keyed by machine: another machine's form starts over with its own repositories and agents. */}
      {machine?.profile ? (
        kind === 'session'
          ? <CreateSessionForm key={machine.key} machine={machine.profile} onCreated={sessionId => created({ sessionId })} />
          : (
            <CreatePaneForm
              key={machine.key}
              machine={machine.profile}
              projectId={machine.current ? projectId : undefined}
              onCreated={paneId => created({ paneId })}
            />
          )
      ) : null}
    </ScrollView>
  );
}

/** A machine New can create on: saved, and not known to be offline. */
function reachable(machine: Machine): boolean {
  return machine.current || machine.state !== 'dimmed';
}

function Segment({ title, ios, android, selected, onPress, testID }: {
  title: string;
  ios: 'bubble.left' | 'arrow.triangle.branch';
  android: 'chat_bubble' | 'call_split';
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  const color = selected ? theme.colors.text : theme.colors.textSecondary;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="tab"
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.segment, {
        borderRadius: theme.radius.md,
        backgroundColor: selected ? theme.colors.surface : 'transparent',
        borderColor: selected ? theme.colors.border : 'transparent',
      }]}
    >
      <Icon ios={ios} android={android} size={16} color={color} />
      <Text variant="callout" style={[styles.bold, { color }]}>{title}</Text>
    </Pressable>
  );
}

function MachineOption({ machine, selected, onPress }: { machine: Machine; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const offline = !reachable(machine);
  const ink = selected ? theme.colors.background : theme.colors.text;
  return (
    <Pressable
      testID={`new-machine-${machine.name}`}
      accessibilityRole="radio"
      accessibilityLabel={offline ? `${machine.name}, offline` : machine.name}
      accessibilityState={{ selected, disabled: offline }}
      disabled={offline}
      onPress={onPress}
      style={({ pressed }) => [styles.machine, {
        backgroundColor: selected ? theme.colors.text : pressed ? theme.colors.surfacePressed : theme.colors.surfaceRaised,
        opacity: offline ? 0.4 : 1,
      }]}
    >
      <MachineMark os={machine.os} slot={machine.slot} state={machine.state} color={selected ? ink : undefined} />
      <Text variant="callout" numberOfLines={1} style={[styles.bold, { color: ink }]}>{offline ? `${machine.name} · offline` : machine.name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, gap: 20 },
  bold: { fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerSide: { minWidth: 64 },
  toggle: { flexDirection: 'row', padding: 3 },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 40, borderWidth: 1 },
  section: { gap: 8 },
  machines: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  machine: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, borderRadius: 17, paddingHorizontal: 13, paddingVertical: 6 },
});
