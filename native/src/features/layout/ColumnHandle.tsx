import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTheme } from '@/theme';

export interface ColumnHandleProps {
  /** Where the column's edge is, from the frame's left. */
  left: number;
  /** The column's width now, and how far it can go. */
  width: number;
  min: number;
  max: number;
  onResize(width: number): void;
  onReset(): void;
}

/** The touch target, centered on the column's edge. */
const HIT_WIDTH = 24;
/** How far each screen reader adjustment moves the edge. */
const ADJUST_STEP = 24;

/**
 * The grab handle on Home's column edge. Dragging moves a line to the new edge and the column takes
 * that width on release, so the open screen (a terminal resizing its computer's PTY) lays out once.
 * A tick at either limit; a double tap goes back to the default width.
 */
export function ColumnHandle({ left, width, min, max, onResize, onReset }: ColumnHandleProps) {
  const theme = useTheme();
  const edge = useSharedValue(width);
  const dragging = useSharedValue(false);
  const atLimit = useSharedValue(false);
  // Follow the column between drags; after a drag the edge already sits where the column lands.
  useEffect(() => {
    edge.value = width;
  }, [edge, width]);

  const pan = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .onStart(() => {
      dragging.value = true;
    })
    .onUpdate(event => {
      const wanted = width + event.translationX;
      const next = Math.min(max, Math.max(min, wanted));
      const limited = next !== wanted;
      if (limited && !atLimit.value) scheduleOnRN(tick);
      atLimit.value = limited;
      edge.value = next;
    })
    .onEnd((_event, success) => {
      // A pan the system cancelled (onFinalize puts the edge back) never resizes the column.
      if (success) scheduleOnRN(onResize, Math.round(edge.value));
    })
    .onFinalize((_event, success) => {
      // A drag the system cancelled leaves the column as it was.
      if (!success) edge.value = width;
      dragging.value = false;
      atLimit.value = false;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => scheduleOnRN(onReset));

  const handleStyle = useAnimatedStyle(() => ({ transform: [{ translateX: edge.value - width }] }));
  const guideStyle = useAnimatedStyle(() => ({ opacity: dragging.value ? 1 : 0 }));
  const gripStyle = useAnimatedStyle(() => ({
    backgroundColor: dragging.value ? theme.colors.accent : theme.colors.textMuted,
    opacity: dragging.value ? 1 : 0.7,
  }));

  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, doubleTap)}>
      <Animated.View
        testID="home-column-handle"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Home width"
        accessibilityHint="Swipe up or down to resize Home"
        accessibilityValue={{ min, max, now: width }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => {
          const step = event.nativeEvent.actionName === 'increment' ? ADJUST_STEP : -ADJUST_STEP;
          onResize(Math.min(max, Math.max(min, width + step)));
        }}
        style={[styles.handle, { left: left - HIT_WIDTH / 2 }, handleStyle]}
      >
        <Animated.View style={[styles.guide, { backgroundColor: theme.colors.accent }, guideStyle]} />
        <Animated.View style={[styles.grip, gripStyle]} />
      </Animated.View>
    </GestureDetector>
  );
}

function tick() {
  void Haptics.selectionAsync();
}

const styles = StyleSheet.create({
  handle: { position: 'absolute', top: 0, bottom: 0, width: HIT_WIDTH, alignItems: 'center', justifyContent: 'center' },
  guide: { position: 'absolute', top: 0, bottom: 0, width: 2 },
  grip: { width: 5, height: 44, borderRadius: 2.5 },
});
