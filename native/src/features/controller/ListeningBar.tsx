import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import type { DictationPhase } from '../voice/useVoiceDictation';

/** While a controller's R2 dictates into a box without its own mic: "Listening…" and the words so far, one line tall. */
export function ListeningBar({ phase, preview }: { phase: DictationPhase; preview: string }) {
  const theme = useTheme();
  if (phase === 'idle') return null;
  const label = phase === 'transcribing' ? 'Finishing…' : phase === 'starting' ? 'Starting…' : 'Listening…';
  return (
    <View testID="controller-listening" accessibilityLiveRegion="polite" style={[styles.bar, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceRaised, borderRadius: theme.radius.md }]}>
      <View style={[styles.dot, { backgroundColor: phase === 'listening' ? theme.colors.danger : theme.colors.textMuted }]} />
      <Text variant="footnote" tone="secondary">{label}</Text>
      <Text variant="footnote" numberOfLines={1} style={styles.preview}>{preview}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { height: 32, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  preview: { flex: 1 },
});
