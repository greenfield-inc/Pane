import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RemotePaneConnectionStatus } from '@shared/types/remoteDaemon';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, Text } from '@/ui';

const STATUS_LABEL: Record<RemotePaneConnectionStatus, string> = {
  connected: 'Connected to',
  connecting: 'Connecting to',
  reconnecting: 'Reconnecting to',
  error: 'Connection issue with',
  local: 'Disconnected from',
};

/**
 * The web app's status bar, drawn inside the top safe area: back, the host's
 * connection dot, label and address, and a button to host settings. The pane
 * name follows the host label, where the web app has none.
 */
export function TerminalTopBar({ paneName }: { paneName: string }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const { profile, connection } = useDaemon();
  const { status, lastError, lastSeenAt } = connection;
  const title = status === 'connected' ? profile.label : `${STATUS_LABEL[status]} ${profile.label}`;

  return (
    <View style={{ paddingTop: insets.top, backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: 1 }}>
      <View style={styles.row}>
        <View style={styles.leading}>
          <Pressable
            testID="terminal-back"
            accessibilityRole="button"
            accessibilityLabel={paneName ? `Back from ${paneName}` : 'Back'}
            hitSlop={4}
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.back,
              { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' },
            ]}
          >
            <Icon ios="chevron.left" android="arrow_back" size={20} color={colors.textSecondary} />
          </Pressable>
          <StatusDot status={status} />
          <View style={styles.text}>
            <View style={styles.titleRow}>
              <Text
                variant="subhead"
                style={[styles.semibold, styles.shrink]}
                numberOfLines={1}
                accessibilityLabel={`${STATUS_LABEL[status]} ${profile.label}`}
              >
                {title}
              </Text>
              {paneName ? (
                <>
                  <Text variant="subhead" tone="muted" importantForAccessibility="no" accessibilityElementsHidden>›</Text>
                  <Text variant="subhead" tone="secondary" style={styles.pane} numberOfLines={1}>{paneName}</Text>
                </>
              ) : null}
            </View>
            <Text variant="footnote" tone="muted" numberOfLines={1}>
              {lastError || profile.baseUrl}
              {lastSeenAt ? ` · seen ${formatLastSeen(lastSeenAt)}` : ''}
            </Text>
          </View>
        </View>
        <Pressable
          testID="open-settings"
          accessibilityRole="button"
          accessibilityLabel="Host settings"
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [
            styles.settings,
            {
              borderRadius: theme.radius.md,
              borderColor: colors.border,
              backgroundColor: pressed ? colors.surfacePressed : colors.surface,
            },
          ]}
        >
          <Icon ios="gearshape" android="settings" size={16} color={colors.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

/** Green when connected, red on error, amber with a spreading ring while reaching the host. */
function StatusDot({ status }: { status: RemotePaneConnectionStatus }) {
  const { colors } = useTheme();
  const color = status === 'connected' ? colors.success : status === 'error' ? colors.danger : colors.warning;
  const reaching = status === 'connecting' || status === 'reconnecting';
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reaching) {
      progress.value = 0;
      progress.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.out(Easing.cubic) }), -1);
    } else {
      cancelAnimation(progress);
      progress.value = 0;
    }
  }, [progress, reaching]);

  // The web app's keyframes: the ring grows to 2.6× and fades out by 70% of the loop.
  const ringStyle = useAnimatedStyle(() => {
    const t = Math.min(progress.value / 0.7, 1);
    return { opacity: 0.55 * (1 - t), transform: [{ scale: 1 + 1.6 * t }] };
  });

  return (
    <View style={styles.dotBox} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {reaching ? <Animated.View style={[styles.dot, styles.ring, { backgroundColor: color }, ringStyle]} /> : null}
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

function formatLastSeen(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'recently';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

const DOT = 10;

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  leading: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  semibold: { fontWeight: '600' },
  shrink: { flexShrink: 1 },
  pane: { flexShrink: 2 },
  settings: { width: 40, height: 40, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dotBox: { width: DOT, height: DOT, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  ring: { position: 'absolute' },
});
