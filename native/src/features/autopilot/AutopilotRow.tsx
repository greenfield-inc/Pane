import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AutopilotSnapshot } from '@shared/types/autopilot';

import { useTheme, withAlpha } from '@/theme';
import { Icon, Text } from '@/ui';

import { autopilotRowState } from './autopilot';
import { AutopilotMark } from './AutopilotScreen';
import { useAutopilotControl } from './hooks';

function openAutopilot() {
  router.push('/autopilot');
}

/**
 * Home's Autopilot row (D-75), above "Waiting on you", only while Autopilot is on for this
 * computer. Before Start it carries Start (which starts it and opens it); then Paused, or how
 * many items are open on its stack.
 */
export function AutopilotRow({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const theme = useTheme();
  const { colors } = theme;
  const start = useAutopilotControl('start');
  const state = autopilotRowState(snapshot);
  const walking = snapshot.walk.sessions.find(session => session.id === snapshot.walk.sessionId)?.name;
  const detail = state.kind === 'start' ? 'Brings what needs you, one at a time' : state.kind === 'sentinel' ? 'Sentinel · keeping Sessions moving' : state.kind === 'paused' ? 'Paused' : walking ? `Running · ${walking}` : 'Running';
  return (
    <View style={styles.wrap}>
      <Pressable
        testID="autopilot-row"
        accessibilityRole="button"
        accessibilityLabel={`Autopilot, ${state.kind === 'start' ? 'not started' : state.kind === 'open' ? `${detail}, ${state.count} open` : detail}`}
        onPress={openAutopilot}
        style={({ pressed }) => [styles.row, {
          borderRadius: theme.radius.card,
          borderColor: withAlpha(colors.autopilot, 0.32),
          backgroundColor: withAlpha(colors.autopilot, pressed ? 0.14 : 0.07),
        }]}
      >
        <AutopilotMark size={30} />
        <View style={styles.text}>
          <Text variant="callout" style={styles.bold}>Autopilot</Text>
          <Text testID="autopilot-row-state" variant="footnote" tone="muted" numberOfLines={1}>{detail}</Text>
        </View>
        {state.kind === 'start' ? (
          <Pressable
            testID="autopilot-row-start"
            accessibilityRole="button"
            accessibilityLabel="Start Autopilot"
            accessibilityState={{ disabled: !!state.blocked || start.isPending }}
            disabled={!!state.blocked || start.isPending}
            hitSlop={6}
            // Starts it, then opens it: the same Start as on its screen.
            onPress={() => start.mutate([], { onSuccess: openAutopilot })}
            style={({ pressed }) => [styles.start, { borderRadius: theme.radius.md, backgroundColor: colors.accent, opacity: state.blocked || start.isPending ? 0.5 : pressed ? 0.8 : 1 }]}
          >
            <Icon ios="location.fill" android="near_me" size={13} color={colors.onAccent} />
            <Text variant="callout" tone="onAccent" style={styles.bold}>Start</Text>
          </Pressable>
        ) : (
          <View style={[styles.count, { backgroundColor: withAlpha(colors.autopilot, 0.16) }]}>
            <Text variant="caption" style={{ color: colors.autopilotText }}>{state.kind === 'paused' ? 'paused' : state.kind === 'sentinel' ? 'Sentinel' : state.count}</Text>
          </View>
        )}
        <Icon ios="chevron.right" android="chevron_right" size={14} />
      </Pressable>
      {start.isError ? <Text testID="autopilot-row-error" variant="footnote" tone="danger" style={styles.error}>{start.error.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 12, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1 },
  text: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '600' },
  start: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: 12 },
  count: { minWidth: 28, height: 22, borderRadius: 11, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  error: { paddingHorizontal: 4 },
});
