import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { useReadOnlyHost } from '@/daemon';
import { useTheme, type ThemeColors } from '@/theme';
import { Text } from '@/ui';

interface SwipeRowActions {
  /** Pin or Unpin on a right swipe; rows that can't pin (approvals) leave it out. */
  pinned?: boolean;
  onTogglePinned?: () => void;
  onArchive: () => void;
  /** Pause or Resume beside Archive; rows that can't pause leave it out. */
  pause?: { paused: boolean; onToggle: () => void };
}

/**
 * A home-list row of the machine the phone is on (it stays put when the phone only watches it) that swipes right to pin or unpin, and left to pause or resume and archive. Pin and
 * pause are optional.
 * The swipe actions' testIDs are `<testIDPrefix>-swipe-pin-<id>`, `<testIDPrefix>-swipe-pause-<id>`
 * and `<testIDPrefix>-swipe-archive-<id>`.
 */
export function SwipeRow({ testIDPrefix, id, pinned, onTogglePinned, onArchive, pause, children }: SwipeRowActions & {
  testIDPrefix: string;
  id: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  const readOnly = useReadOnlyHost();
  return (
    <View style={[styles.outer, { borderRadius: theme.radius.md }]}>
      <ReanimatedSwipeable
        enabled={!readOnly}
        friction={2}
        // The screen's left edge belongs to swipe-back on pushed screens.
        hitSlop={{ left: -24 }}
        overshootFriction={8}
        leftThreshold={48}
        rightThreshold={48}
        renderLeftActions={onTogglePinned ? (_progress, _translation, swipe) => (
          <SwipeAction
            testID={`${testIDPrefix}-swipe-pin-${id}`}
            label={pinned ? 'Unpin' : 'Pin'}
            color="accent"
            onPress={() => { swipe.close(); onTogglePinned(); }}
          />
        ) : undefined}
        renderRightActions={(_progress, _translation, swipe) => (
          <View style={styles.actions}>
            {pause ? (
              <SwipeAction
                testID={`${testIDPrefix}-swipe-pause-${id}`}
                label={pause.paused ? 'Resume' : 'Pause'}
                color="surfacePressed"
                tone="primary"
                onPress={() => { swipe.close(); pause.onToggle(); }}
              />
            ) : null}
            {/* Archive stays outermost. */}
            <SwipeAction
              testID={`${testIDPrefix}-swipe-archive-${id}`}
              label="Archive"
              color="danger"
              onPress={() => { swipe.close(); onArchive(); }}
            />
          </View>
        )}
        onSwipeableWillOpen={() => void Haptics.selectionAsync()}
      >
        {children}
      </ReanimatedSwipeable>
    </View>
  );
}

/** Pin/Unpin and Pause/Resume when the row has them, and Archive, as screen reader actions, for the row's focusable Pressable; none for a row that doesn't swipe. */
export function useSwipeRowAccessibility(actions: SwipeRowActions | undefined) {
  const readOnly = useReadOnlyHost();
  if (!actions || readOnly) return {};
  const { pinned, onTogglePinned, onArchive, pause } = actions;
  return {
    accessibilityActions: [
      ...(onTogglePinned ? [{ name: 'pin', label: pinned ? 'Unpin' : 'Pin' }] : []),
      ...(pause ? [{ name: 'pause', label: pause.paused ? 'Resume' : 'Pause' }] : []),
      { name: 'archive', label: 'Archive' },
    ],
    onAccessibilityAction: (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'pin') onTogglePinned?.();
      else if (event.nativeEvent.actionName === 'pause') pause?.onToggle();
      else if (event.nativeEvent.actionName === 'archive') onArchive();
    },
  };
}

function SwipeAction({ label, color, tone = 'onAccent', onPress, testID }: {
  label: string;
  color: keyof ThemeColors;
  tone?: 'onAccent' | 'primary';
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.swipeAction, { backgroundColor: theme.colors[color] }]}
    >
      <Text variant="caption" tone={tone}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // space-y-1 between rows.
  outer: { marginBottom: 4, overflow: 'hidden' },
  actions: { flexDirection: 'row' },
  swipeAction: { width: 84, alignItems: 'center', justifyContent: 'center' },
});
