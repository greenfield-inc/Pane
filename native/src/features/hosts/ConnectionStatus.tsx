import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { ConnectionNotice, ConnectionPresence } from '@shared/remoteClient';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

/** How far content under a machine that isn't connected fades. */
const DIMMED_OPACITY = 0.45;

// The machine's own status mark is MachineMark (features/machines): one status style on the phone.

/** Spoken with the machine name, since the machine mark itself is hidden from screen readers. */
export function presenceLabel(presence: ConnectionPresence, machine: string): string {
  return presence === 'connected' ? `Connected to ${machine}` : presence === 'unreachable' ? `Can't reach ${machine}` : `Reconnecting to ${machine}`;
}

/** The one-line bar under a header once the grace window has passed. */
export function ConnectionBar({ notice, onRetry }: { notice: ConnectionNotice | null; onRetry: () => void }) {
  const { colors } = useTheme();
  if (!notice) return null;
  return (
    <View testID="connection-bar" accessibilityLiveRegion="polite" style={[styles.bar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
      <Text variant="footnote" tone="secondary" style={styles.barText}>{notice.message}</Text>
      {notice.canRetry ? (
        <Pressable testID="connection-retry" accessibilityRole="button" accessibilityLabel="Retry now" hitSlop={10} onPress={onRetry}>
          <Text variant="footnote" tone="accent" style={styles.retry}>Retry now</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Content that stays on screen but takes no touches while the machine is not
 * connected. It only restyles its children, so a terminal inside keeps its page.
 */
export function Dimmed({ dimmed, style, children }: { dimmed: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <View style={[style, dimmed ? styles.dimmed : styles.live]} accessibilityElementsHidden={dimmed}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  barText: { flex: 1 },
  retry: { fontWeight: '600' },
  dimmed: { opacity: DIMMED_OPACITY, pointerEvents: 'none' },
  live: { pointerEvents: 'box-none' },
});
