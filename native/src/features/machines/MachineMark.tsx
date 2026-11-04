import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { cancelAnimation, Easing, makeMutable, useAnimatedStyle, useReducedMotion, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import type { TailnetMachine } from '@shared/types/workspaceAccess';

import { OS_LOGO_PATHS } from '@/features/computers/OsLogo';
import { useTheme, withAlpha } from '@/theme';

import type { MachineState } from './machines';

/** One rhythm for every pulsing mark on screen. */
const PULSE_MS = 1600;
const PULSE_LOW = 0.28;
const DIMMED = 0.38;
/** A pulsing mark under Reduce Motion holds here instead. */
const STILL_PULSE = 0.6;

// A monitor, for a machine whose OS Pane doesn't know (paired with a code, not on Tailscale).
const COMPUTER_PATH = 'M3 4h18a1 1 0 011 1v11a1 1 0 01-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 01-1-1V5a1 1 0 011-1zm1 2v9h16V6z';

// Shared by every mark, so two pulsing marks never drift out of phase. Runs while any is mounted.
const pulse = makeMutable(1);
let pulsing = 0;

function usePulse(active: boolean) {
  useEffect(() => {
    if (!active) return;
    pulsing += 1;
    if (pulsing === 1) {
      pulse.value = 1;
      pulse.value = withRepeat(withTiming(PULSE_LOW, { duration: PULSE_MS / 2, easing: Easing.inOut(Easing.ease) }), -1, true);
    }
    return () => {
      pulsing -= 1;
      if (pulsing === 0) {
        cancelAnimation(pulse);
        pulse.value = 1;
      }
    };
  }, [active]);
}

export interface MachineMarkProps {
  os: TailnetMachine['os'] | null;
  slot: number;
  state: MachineState;
  /** `glyph` is the logo alone (chips); `tile` sits it on a tinted rounded square (lists, cards). */
  variant?: 'glyph' | 'tile';
  size?: number;
  /** Draws the logo in this color instead of the machine's, e.g. on a filled chip. */
  color?: string;
}

/** A machine's OS logo in its palette color, solid, pulsing or dimmed. */
export function MachineMark({ os, slot, state, variant = 'glyph', size = 14, color }: MachineMarkProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const animate = state === 'pulsing' && !reduceMotion;
  usePulse(animate);
  const opacity = state === 'dimmed' ? DIMMED : state === 'pulsing' ? STILL_PULSE : 1;
  const animated = useAnimatedStyle(() => ({ opacity: animate ? pulse.value : opacity }));
  const tint = theme.machine[slot % theme.machine.length];
  const glyphSize = variant === 'tile' ? Math.round(size * 0.56) : size;

  const glyph = (
    <Svg width={glyphSize} height={glyphSize} viewBox="0 0 24 24">
      <Path d={os ? OS_LOGO_PATHS[os] : COMPUTER_PATH} fill={color ?? tint} fillRule={os ? undefined : 'evenodd'} />
    </Svg>
  );

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        variant === 'tile' && [styles.tile, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: withAlpha(tint, 0.15) }],
        animated,
      ]}
    >
      {glyph}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center' },
});
