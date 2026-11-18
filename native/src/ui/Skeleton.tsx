import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  makeMutable,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/theme';

import { SKELETON_REVEAL_MS, skeletonState } from './skeletonTiming';

/**
 * One breathe for every bone in the app, so all skeletons on screen step together: opacity
 * 1 → 0.5 → 1 over 2 s in five steps each way, about five repaints a second, on the UI thread.
 */
const breathe = makeMutable(1);
let breathing = false;
function startBreathing() {
  if (breathing) return;
  breathing = true;
  const step = { duration: 1_000, easing: Easing.steps(5) };
  breathe.value = withRepeat(withSequence(withTiming(0.5, step), withTiming(1, step)), -1);
}

/** False for the first 150 ms of a load: the skeleton keeps the screen's shape, blank. */
const BonesShown = createContext(true);

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/** A placeholder bone in the footprint of what loads. It holds still under Reduce Motion. */
export function Skeleton({ width = '100%', height = 16, radius, style }: SkeletonProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const shown = use(BonesShown);
  useEffect(() => {
    if (!reduceMotion) startBreathing();
  }, [reduceMotion]);
  const pulse = useAnimatedStyle(() => ({ opacity: shown ? (reduceMotion ? 1 : breathe.value) : 0 }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius ?? theme.radius.sm, backgroundColor: theme.colors.skeleton }, style, pulse]}
    />
  );
}

/** Whether a skeleton is up, its bones show, and the content that replaces it fades in. */
function useSkeletonHold(loading: boolean) {
  const [span, setSpan] = useState<{ started: number; ended: number | null } | null>(() => (loading ? { started: Date.now(), ended: null } : null));
  const [, rerender] = useState(0);
  if (loading && (span === null || span.ended !== null)) setSpan({ started: Date.now(), ended: null });
  if (!loading && span !== null && span.ended === null) setSpan({ started: span.started, ended: Date.now() });
  const state = span ? skeletonState(span.started, span.ended, Date.now()) : null;
  const changeAt = state?.changeAt ?? null;
  useEffect(() => {
    if (changeAt === null) return undefined;
    const timer = setTimeout(() => rerender(count => count + 1), Math.max(0, changeAt - Date.now()));
    return () => clearTimeout(timer);
  }, [changeAt]);
  return state ?? { skeleton: false, bones: false, reveal: false };
}

/**
 * The one way to swap a skeleton for what it stands in for, as on the desktop: the skeleton's
 * bones wait 150 ms, a shown skeleton stays 300 ms, and the content then fades in. Pass `loading`
 * only while there is nothing to show: content the screen already has never gets a skeleton.
 * `style` lays out the content's wrapper (`{ flex: 1 }` for a screen body).
 */
export function SkeletonSwap({ loading, skeleton, children, style }: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const hold = useSkeletonHold(loading);
  if (hold.skeleton) return <BonesShown value={hold.bones}>{skeleton}</BonesShown>;
  return (
    <Animated.View style={style} entering={hold.reveal ? FadeIn.duration(SKELETON_REVEAL_MS) : undefined}>
      {children}
    </Animated.View>
  );
}
