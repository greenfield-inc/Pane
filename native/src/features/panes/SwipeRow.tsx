import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { useTheme, type ThemeColors } from '@/theme';
import { Text } from '@/ui';

interface SwipeRowActions {
  pinned: boolean;
  onTogglePinned: () => void;
  onArchive: () => void;
}

/**
 * A home-list row that swipes right to pin or unpin and left to archive.
 * The swipe actions' testIDs are `<testIDPrefix>-swipe-pin-<id>` and `<testIDPrefix>-swipe-archive-<id>`.
 */
export function SwipeRow({ testIDPrefix, id, pinned, onTogglePinned, onArchive, children }: SwipeRowActions & {
  testIDPrefix: string;
  id: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.outer, { borderRadius: theme.radius.md }]}>
      <ReanimatedSwipeable
        friction={2}
        overshootFriction={8}
        leftThreshold={48}
        rightThreshold={48}
        renderLeftActions={(_progress, _translation, swipe) => (
          <SwipeAction
            testID={`${testIDPrefix}-swipe-pin-${id}`}
            label={pinned ? 'Unpin' : 'Pin'}
            color="accent"
            onPress={() => { swipe.close(); onTogglePinned(); }}
          />
        )}
        renderRightActions={(_progress, _translation, swipe) => (
          <SwipeAction
            testID={`${testIDPrefix}-swipe-archive-${id}`}
            label="Archive"
            color="danger"
            onPress={() => { swipe.close(); onArchive(); }}
          />
        )}
        onSwipeableWillOpen={() => void Haptics.selectionAsync()}
      >
        {children}
      </ReanimatedSwipeable>
    </View>
  );
}

/** Pin/Unpin and Archive as screen reader actions, for the row's focusable Pressable. */
export function swipeRowAccessibility({ pinned, onTogglePinned, onArchive }: SwipeRowActions) {
  return {
    accessibilityActions: [
      { name: 'pin', label: pinned ? 'Unpin' : 'Pin' },
      { name: 'archive', label: 'Archive' },
    ],
    onAccessibilityAction: (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'pin') onTogglePinned();
      else if (event.nativeEvent.actionName === 'archive') onArchive();
    },
  };
}

function SwipeAction({ label, color, onPress, testID }: { label: string; color: keyof ThemeColors; onPress: () => void; testID: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.swipeAction, { backgroundColor: theme.colors[color] }]}
    >
      <Text variant="caption" tone="onAccent">{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // space-y-1 between rows.
  outer: { marginBottom: 4, overflow: 'hidden' },
  swipeAction: { width: 84, alignItems: 'center', justifyContent: 'center' },
});
