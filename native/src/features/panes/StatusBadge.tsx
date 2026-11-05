import { StyleSheet, View } from 'react-native';

import type { AgentDisplayStatus } from '@shared/types/agentStatus';

import { useTheme, type ThemeColors } from '@/theme';

export const statusPresentation: Record<AgentDisplayStatus, { label: string; color: keyof ThemeColors }> = {
  blocked: { label: 'Needs input', color: 'warning' },
  working: { label: 'Working', color: 'accent' },
  done: { label: 'Ready', color: 'success' },
  idle: { label: 'Idle', color: 'neutral' },
  unknown: { label: 'No agent', color: 'textMuted' },
};

/** The live agent status as a small dot before the pane name; "No agent" is a hollow ring. */
export function StatusBadge({ status }: { status: AgentDisplayStatus }) {
  const theme = useTheme();
  const color = theme.colors[statusPresentation[status].color];
  return (
    <View
      testID={`status-${status}`}
      accessibilityLabel={statusPresentation[status].label}
      style={[styles.dot, status === 'unknown' ? { borderWidth: 1.5, borderColor: color } : { backgroundColor: color }]}
    />
  );
}

/** Two bars in the status dot's 8 pt box: the Pane or Session is paused. */
export function PausedBadge() {
  const theme = useTheme();
  const bar = [styles.bar, { backgroundColor: theme.colors.textMuted }];
  return (
    <View testID="status-paused" accessibilityLabel="Paused" style={styles.paused}>
      <View style={bar} />
      <View style={bar} />
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4 },
  paused: { width: 8, height: 8, flexDirection: 'row', justifyContent: 'space-between' },
  bar: { width: 2.5, height: 8, borderRadius: 1 },
});
