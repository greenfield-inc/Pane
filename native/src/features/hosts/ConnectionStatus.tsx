import { useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import type { ConnectionNotice, ConnectionPresence } from '@shared/remoteClient';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

const DOT = 10;
/** One period for every pulsing dot. */
const PULSE_MS = 1800;
const DIMMED_OPACITY = 0.45;

/**
 * The machine dot, in a fixed box: solid when connected, a spreading ring
 * while reconnecting or restoring, dimmed when the machine can't be reached.
 */
export function ConnectionDot({ presence }: { presence: ConnectionPresence }) {
  const { colors } = useTheme();
  const pulsing = presence === 'reconnecting' || presence === 'restoring';
  const progress = useSharedValue(0);

  useEffect(() => {
    if (pulsing) {
      progress.value = 0;
      progress.value = withRepeat(withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.cubic) }), -1);
    } else {
      cancelAnimation(progress);
      progress.value = 0;
    }
  }, [progress, pulsing]);

  // The web app's keyframes: the ring grows to 2.6× and fades out by 70% of the loop.
  const ringStyle = useAnimatedStyle(() => {
    const t = Math.min(progress.value / 0.7, 1);
    return { opacity: 0.55 * (1 - t), transform: [{ scale: 1 + 1.6 * t }] };
  });

  return (
    <View style={styles.dotBox} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {pulsing ? <Animated.View style={[styles.dot, styles.ring, { backgroundColor: colors.textSecondary }, ringStyle]} /> : null}
      <View style={[styles.dot, { backgroundColor: colors.textSecondary, opacity: presence === 'unreachable' ? DIMMED_OPACITY : 1 }]} />
    </View>
  );
}

/** Spoken with the machine name, since the dot itself is hidden from screen readers. */
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
  dotBox: { width: DOT, height: DOT, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  ring: { position: 'absolute' },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 36, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1 },
  barText: { flex: 1 },
  retry: { fontWeight: '600' },
  dimmed: { opacity: DIMMED_OPACITY, pointerEvents: 'none' },
  live: { pointerEvents: 'box-none' },
});
