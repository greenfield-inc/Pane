import * as Haptics from 'expo-haptics';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTheme } from '@/theme';
import { Icon } from '@/ui';

import { JOYSTICK_TRAVEL, joystickLinesPerSecond } from './joystick';

const THUMB = 32;

/**
 * Hold and drag the thumb up or down to scroll the terminal; the further it
 * goes, the faster it scrolls. It springs back to center when released.
 */
export function ScrollJoystick({ onScroll }: { onScroll: (lines: number) => void }) {
  const theme = useTheme();
  const offset = useSharedValue(0);
  const loop = useRef<number | null>(null);

  const startScrolling = () => {
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      carry += (joystickLinesPerSecond(offset.value) * (now - last)) / 1000;
      last = now;
      const lines = Math.trunc(carry);
      if (lines !== 0) {
        carry -= lines;
        onScroll(lines);
      }
      loop.current = requestAnimationFrame(step);
    };
    void Haptics.selectionAsync();
    loop.current = requestAnimationFrame(step);
  };
  const stopScrolling = () => {
    if (loop.current !== null) cancelAnimationFrame(loop.current);
    loop.current = null;
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => scheduleOnRN(startScrolling))
    .onUpdate(event => {
      offset.value = Math.max(-JOYSTICK_TRAVEL, Math.min(JOYSTICK_TRAVEL, event.translationY));
    })
    .onFinalize(() => {
      offset.value = withSpring(0, { damping: 18, stiffness: 260 });
      scheduleOnRN(stopScrolling);
    });

  const thumbStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));

  return (
    <GestureDetector gesture={pan}>
      <View
        testID="terminal-scroll-joystick"
        accessibilityRole="adjustable"
        accessibilityLabel="Scroll terminal"
        accessibilityHint="Drag up or down to scroll"
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => onScroll(event.nativeEvent.actionName === 'increment' ? -10 : 10)}
        style={[styles.track, { borderColor: theme.colors.border }]}
      >
        <View style={[StyleSheet.absoluteFill, styles.trackFill, { backgroundColor: theme.colors.surfaceRaised }]} />
        <Animated.View style={[styles.thumb, { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border }, thumbStyle]}>
          <Icon ios="arrow.up.and.down" android="unfold_more" size={16} color={theme.colors.textSecondary} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  track: {
    width: THUMB + 8,
    height: THUMB + JOYSTICK_TRAVEL * 2 + 8,
    borderRadius: (THUMB + 8) / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackFill: { borderRadius: 999, opacity: 0.45 },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
