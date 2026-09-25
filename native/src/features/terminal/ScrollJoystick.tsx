import * as Haptics from 'expo-haptics';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { useTheme } from '@/theme';
import { Icon } from '@/ui';

import { JOYSTICK_TRAVEL, joystickLinesPerSecond } from './joystick';

const THUMB = 40;

/**
 * Hold and drag the thumb up or down to scroll the terminal; the further it
 * goes, the faster it scrolls. It springs back to center when released.
 * Styled as the web app's vertical pill: a track with a center line and a round thumb.
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
  // The terminal is dark in both themes, so the control is drawn from its palette.
  const { foreground, background } = theme.terminal;

  return (
    <GestureDetector gesture={pan}>
      <View
        testID="terminal-scroll-joystick"
        accessibilityRole="adjustable"
        accessibilityLabel="Scroll terminal"
        accessibilityHint="Drag up or down to scroll"
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => onScroll(event.nativeEvent.actionName === 'increment' ? -10 : 10)}
        style={[styles.track, { borderColor: withAlpha(foreground, 0.1), backgroundColor: withAlpha(background, 0.45) }]}
      >
        <View style={[styles.line, { backgroundColor: withAlpha(foreground, 0.15) }]} />
        <Animated.View style={[styles.thumb, { backgroundColor: background, borderColor: withAlpha(foreground, 0.15) }, thumbStyle]}>
          <Icon ios="chevron.up.chevron.down" android="unfold_more" size={20} color={theme.terminal.brightBlack} />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

/** `#rrggbb` at `alpha` opacity. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

// The web app's track: 44 wide, 160 tall, a 40 pt thumb.
const TRACK_WIDTH = 44;

const styles = StyleSheet.create({
  track: {
    width: TRACK_WIDTH,
    height: THUMB + JOYSTICK_TRAVEL * 2,
    borderRadius: TRACK_WIDTH / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { position: 'absolute', top: 16, bottom: 16, width: 1 },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
