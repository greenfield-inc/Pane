import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import * as Haptics from 'expo-haptics';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';

import { useTheme, withAlpha } from '@/theme';
import { Icon, Text } from '@/ui';

import type { ControllerLayout } from './controllerLayout';
import { KEYS } from './keys';
import { ScrollJoystick } from './ScrollJoystick';

const REST_OPACITY = 0.18;
const AWAKE_MS = 3000;
const FADE_MS = 600;
const WAKE_MS = 120;
const CELL = 36;
const SIDE_KEY = 32;

export interface FloatingControllerProps {
  /** Sends a key's bytes to the terminal. */
  onKey: (data: string) => void;
  onScroll: (lines: number) => void;
  /** Where the joystick and D-pad sit (see `controllerLayout`). */
  layout: ControllerLayout;
}

/**
 * Controls floating over the terminal's right edge: the scroll joystick on
 * top, a D-pad below with Enter in its center, Esc and Tab to its left. They
 * rest faint so the terminal reads through them. Touching any one makes all
 * of them opaque; 3 s after the last touch they fade back together, on one
 * shared timer.
 */
export function FloatingController({ onKey, onScroll, layout }: FloatingControllerProps) {
  const { joystickTop, padBottom } = layout;
  const opacity = useSharedValue(REST_OPACITY);
  // Worklets, so the joystick's gesture can call them on the UI thread too.
  const wake = () => {
    'worklet';
    opacity.value = withTiming(1, { duration: WAKE_MS });
  };
  const rest = () => {
    'worklet';
    opacity.value = withDelay(AWAKE_MS, withTiming(REST_OPACITY, { duration: FADE_MS }));
  };
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const key = { onKey, wake, rest };

  return (
    <View style={styles.layer} pointerEvents="box-none">
      <Animated.View style={[styles.joystick, { top: joystickTop }, fade]}>
        <ScrollJoystick onScroll={onScroll} onTouchStart={wake} onTouchEnd={rest} />
      </Animated.View>
      {padBottom === null ? null : (
      <Animated.View style={[styles.cluster, { bottom: padBottom }, fade]} testID="terminal-controller">
        <View style={styles.sideKeys}>
          <SideKey label="Esc" data={KEYS.esc} {...key} />
          <SideKey label="Tab" data={KEYS.tab} {...key} />
        </View>
        <View style={styles.pad}>
          <PadKey id="up" label="Up arrow" data={KEYS.up} ios="arrowtriangle.up.fill" android="arrow_drop_up" area={styles.up} {...key} />
          <PadKey id="left" label="Left arrow" data={KEYS.left} ios="arrowtriangle.left.fill" android="arrow_left" area={styles.left} {...key} />
          <PadKey id="enter" label="Enter" data={KEYS.enter} ios="return.left" android="keyboard_return" area={styles.center} center {...key} />
          <PadKey id="right" label="Right arrow" data={KEYS.right} ios="arrowtriangle.right.fill" android="arrow_right" area={styles.right} {...key} />
          <PadKey id="down" label="Down arrow" data={KEYS.down} ios="arrowtriangle.down.fill" android="arrow_drop_down" area={styles.down} {...key} />
        </View>
      </Animated.View>
      )}
    </View>
  );
}

interface KeyHandlers {
  onKey: (data: string) => void;
  wake: () => void;
  rest: () => void;
}

/** The terminal is dark in both themes, so the keys are drawn from its palette. */
function useKeyColors() {
  const theme = useTheme();
  const { foreground } = theme.terminal;
  return {
    background: withAlpha(foreground, 0.1),
    border: withAlpha(foreground, 0.18),
    label: theme.terminal.white,
    accent: theme.colors.accent,
    onAccent: theme.colors.onAccent,
  };
}

/**
 * One controller key: wakes the controls on touch and sends `data`. `lit`
 * (pressed, or Enter's resting fill) draws it in the accent.
 */
function ControllerKey({ id, label, data, shape, filled = false, children, onKey, wake, rest }: KeyHandlers & {
  id: string;
  label: string;
  data: string;
  shape: StyleProp<ViewStyle>;
  filled?: boolean;
  children: (tint: string) => ReactNode;
}) {
  const colors = useKeyColors();
  return (
    <Pressable
      testID={`terminal-key-${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPressIn={wake}
      onPressOut={rest}
      onPress={() => {
        void Haptics.selectionAsync();
        onKey(data);
      }}
      style={({ pressed }) => [
        shape,
        {
          borderColor: pressed ? colors.accent : colors.border,
          backgroundColor: pressed || filled ? colors.accent : colors.background,
        },
      ]}
    >
      {({ pressed }) => children(pressed || filled ? colors.onAccent : colors.label)}
    </Pressable>
  );
}

function PadKey({ ios, android, area, center = false, ...key }: KeyHandlers & {
  id: string;
  label: string;
  data: string;
  ios: SFSymbol;
  android: AndroidSymbol;
  area: ViewStyle;
  /** Enter, in the middle: filled with the accent. */
  center?: boolean;
}) {
  return (
    <ControllerKey {...key} shape={[styles.cell, area]} filled={center}>
      {tint => <Icon ios={ios} android={android} size={center ? 15 : 13} color={tint} />}
    </ControllerKey>
  );
}

function SideKey({ label, ...key }: KeyHandlers & { label: string; data: string }) {
  return (
    <ControllerKey {...key} id={label.toLowerCase()} label={label} shape={styles.side}>
      {tint => <Text variant="footnote" style={[styles.sideLabel, { color: tint }]}>{label}</Text>}
    </ControllerKey>
  );
}

const PAD = CELL * 3;

const styles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFill },
  joystick: { position: 'absolute', right: 8 },
  cluster: { position: 'absolute', right: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  sideKeys: { gap: 10 },
  side: {
    width: SIDE_KEY,
    height: SIDE_KEY,
    borderRadius: SIDE_KEY / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sideLabel: { fontSize: 10.5, lineHeight: 13, fontWeight: '600' },
  pad: { width: PAD, height: PAD },
  cell: { position: 'absolute', width: CELL, height: CELL, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  up: { left: CELL, top: 0, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomWidth: 0 },
  left: { left: 0, top: CELL, borderTopLeftRadius: 8, borderBottomLeftRadius: 8, borderRightWidth: 0 },
  center: { left: CELL, top: CELL, borderLeftWidth: 0, borderRightWidth: 0 },
  right: { left: CELL * 2, top: CELL, borderTopRightRadius: 8, borderBottomRightRadius: 8, borderLeftWidth: 0 },
  down: { left: CELL, top: CELL * 2, borderBottomLeftRadius: 8, borderBottomRightRadius: 8, borderTopWidth: 0 },
});
