import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import type { AutopilotSnapshot } from '@shared/types/autopilot';

import { useTheme, withAlpha } from '@/theme';
import { Icon, Text } from '@/ui';

import { autopilotRowState } from './autopilot';
import { useAutopilotControl } from './hooks';

function openAutopilot() {
  router.push('/autopilot');
}

/**
 * Home's Autopilot bar (D-75), above Needs you, only while Autopilot is on for this computer. Before
 * Start it reads "Walk these with Autopilot" and carries Start (which starts it and opens it); then
 * it says Running, Paused or Sentinel, with how many items are open on its stack.
 */
export function AutopilotRow({ snapshot }: { snapshot: AutopilotSnapshot }) {
  const theme = useTheme();
  const { colors } = theme;
  const start = useAutopilotControl('start');
  const state = autopilotRowState(snapshot);
  const walking = snapshot.walk.sessions.find(session => session.id === snapshot.walk.sessionId)?.name;
  const detail = state.kind === 'sentinel' ? 'Sentinel · keeping Sessions moving' : state.kind === 'paused' ? 'Paused' : walking ? `Running · ${walking}` : 'Running';
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
        <Icon ios="location" android="near_me" size={15} color={colors.autopilot} />
        {state.kind === 'start' ? (
          <Text testID="autopilot-row-state" variant="subhead" numberOfLines={1} style={styles.text}>
            {'Walk these with '}
            <Text variant="subhead" style={styles.bold}>Autopilot</Text>
          </Text>
        ) : (
          <Text testID="autopilot-row-state" variant="subhead" tone="secondary" numberOfLines={1} style={styles.text}>
            <Text variant="subhead" style={styles.bold}>Autopilot</Text>
            {` · ${detail}`}
          </Text>
        )}
        {state.kind === 'start' ? (
          <Pressable
            testID="autopilot-row-start"
            accessibilityRole="button"
            accessibilityLabel="Start Autopilot"
            accessibilityState={{ disabled: !!state.blocked || start.isPending }}
            disabled={!!state.blocked || start.isPending}
            hitSlop={8}
            // Starts it, then opens it: the same Start as on its screen.
            onPress={() => start.mutate([], { onSuccess: openAutopilot })}
            style={({ pressed }) => [styles.start, { borderRadius: theme.radius.md, backgroundColor: colors.accent, opacity: state.blocked || start.isPending ? 0.5 : pressed ? 0.8 : 1 }]}
          >
            <Text variant="callout" tone="onAccent" style={styles.bold}>Start</Text>
          </Pressable>
        ) : (
          <>
            {state.kind === 'open' ? (
              <View style={[styles.count, { backgroundColor: withAlpha(colors.autopilot, 0.16) }]}>
                <Text variant="caption" style={{ color: colors.autopilotText }}>{state.count}</Text>
              </View>
            ) : null}
            <Icon ios="chevron.right" android="chevron_right" size={13} />
          </>
        )}
      </Pressable>
      {start.isError ? <Text testID="autopilot-row-error" variant="footnote" tone="danger" style={styles.error}>{start.error.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingLeft: 14, paddingRight: 8, paddingVertical: 8, borderWidth: 1 },
  text: { flex: 1, minWidth: 0 },
  bold: { fontWeight: '600' },
  start: { justifyContent: 'center', minHeight: 30, paddingHorizontal: 14 },
  count: { minWidth: 28, height: 22, borderRadius: 11, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  error: { paddingHorizontal: 4 },
});
