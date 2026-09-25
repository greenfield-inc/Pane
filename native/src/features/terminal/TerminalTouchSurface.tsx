import { useEffect, type ReactNode } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { cancelAnimation, useAnimatedReaction, useSharedValue, withDecay } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

export interface TerminalTouchSurfaceProps {
  /** Terminal rows on screen; the row height turns drag distance into lines. */
  rows: number;
  onScrollLines: (lines: number) => void;
  children: ReactNode;
}

/**
 * Owns touch over the terminal, which only renders. Vertical drags scroll it
 * line by line and coast after a flick; a tap puts the keyboard away.
 * Horizontal drags fail here, so the screen's swipe-back still works.
 */
export function TerminalTouchSurface({ rows, onScrollLines, children }: TerminalTouchSurfaceProps) {
  const height = useSharedValue(0);
  const rowCount = useSharedValue(rows);
  useEffect(() => {
    rowCount.value = rows;
  }, [rowCount, rows]);
  const carry = useSharedValue(0);
  const lastTranslation = useSharedValue(0);
  const momentum = useSharedValue(0);

  const scrollByPixels = (pixels: number) => {
    'worklet';
    if (rowCount.value <= 0 || height.value <= 0) return;
    const rowHeight = height.value / rowCount.value;
    carry.value += pixels;
    const lines = Math.trunc(carry.value / rowHeight);
    if (lines === 0) return;
    carry.value -= lines * rowHeight;
    scheduleOnRN(onScrollLines, lines);
  };

  useAnimatedReaction(() => momentum.value, (current, previous) => {
    if (previous !== null) scrollByPixels(current - previous);
  });

  const pan = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .failOffsetX([-12, 12])
    .onStart(() => {
      cancelAnimation(momentum);
      carry.value = 0;
      lastTranslation.value = 0;
    })
    .onUpdate(event => {
      // Dragging up reveals newer lines, like any scroll view.
      scrollByPixels(lastTranslation.value - event.translationY);
      lastTranslation.value = event.translationY;
    })
    .onEnd(event => {
      momentum.value = withDecay({ velocity: -event.velocityY, deceleration: 0.997 });
    });

  const tap = Gesture.Tap()
    .onStart(() => cancelAnimation(momentum))
    .onEnd(() => scheduleOnRN(dismissKeyboard));

  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View style={styles.fill} onLayout={event => { height.value = event.nativeEvent.layout.height; }}>
        <View style={styles.fill} pointerEvents="none">{children}</View>
      </View>
    </GestureDetector>
  );
}

// Worklets can call back into plain functions, not native module objects.
function dismissKeyboard() {
  Keyboard.dismiss();
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
