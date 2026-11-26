import { useEffect, useRef, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme } from '@/theme';

import { useControllerState } from './controllerState';
import { controllerFocus } from './runtime';

/** One motion period for the ring on every surface. */
const MOVE_MS = 120;
/** While shown, the ring re-measures this often, so it follows a scrolling list. */
const FOLLOW_MS = 100;
const PAD = 3;

/**
 * The controller's focus ring for the controls of focus scope `scope`. It
 * fills its parent without taking touches, and draws only after a controller
 * press, on the focused control, positioned against its own frame so it also
 * works inside a sheet.
 */
export function FocusRing({ scope }: { scope: string }) {
  const theme = useTheme();
  const shown = useControllerState(state => state.ringShown);
  const focusedId = useSyncExternalStore(controllerFocus.subscribe, () => controllerFocus.focused()?.id ?? null);
  const active = useSyncExternalStore(controllerFocus.subscribe, () => controllerFocus.activeScope() === scope);
  const visible = shown && active && focusedId !== null;
  const frame = useRef<View>(null);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (!visible) {
      opacity.value = 0;
      return;
    }
    let first = opacity.value === 0;
    const place = () => {
      const rect = controllerFocus.rect();
      const origin = frame.current?.getBoundingClientRect?.();
      if (!rect || !origin) return;
      const to = { x: rect.x - origin.x - PAD, y: rect.y - origin.y - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 };
      const move = (value: typeof x, target: number) => {
        value.value = first ? target : withTiming(target, { duration: MOVE_MS });
      };
      move(x, to.x);
      move(y, to.y);
      move(width, to.width);
      move(height, to.height);
      opacity.value = withTiming(1, { duration: MOVE_MS });
      first = false;
    };
    place();
    const timer = setInterval(place, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [visible, focusedId, x, y, width, height, opacity]);

  const ring = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: x.value }, { translateY: y.value }],
    width: width.value,
    height: height.value,
  }));

  return (
    <View ref={frame} pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View
        testID={visible ? 'controller-focus-ring' : undefined}
        style={[styles.ring, { borderColor: theme.colors.accent }, ring]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    position: 'absolute',
    left: 0,
    top: 0,
    borderWidth: 3,
    borderRadius: 12,
  },
});
