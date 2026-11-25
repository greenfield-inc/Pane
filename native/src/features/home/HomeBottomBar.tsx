import { router } from 'expo-router';
import { use, useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { InColumn, useWideLayout } from '@/features/layout/wideLayout';
import { IconButton } from '@/features/panes/PaneKit';
import { useTheme } from '@/theme';
import { Icon } from '@/ui';

const CONTROL = 44;
const PADDING_TOP = 10;

/** How much of the list's end the bar covers: lists pad their end by this. */
export function bottomBarHeight(insetBottom: number): number {
  return PADDING_TOP + CONTROL + Math.max(insetBottom, 12) + 8;
}

/**
 * Home's bottom bar, in thumb reach: Search panes, and + for a new Session or Pane
 * (none when no machine takes one, `canCreate`). It rides up with
 * the keyboard, and fades the list out under it. Docked beside an open screen, it rises only for
 * its own keyboard, not one the screen beside it opens.
 */
export function HomeBottomBar({ query, onQuery, canCreate }: { query: string; onQuery: (query: string) => void; canCreate: boolean }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const keyboard = useAnimatedKeyboard();
  const returns = useReturnsToForeground();
  const inColumn = use(InColumn);
  const [typing, setTyping] = useState(false);
  const setSearching = useWideLayout(state => state.setSearching);
  const follows = !inColumn || typing;
  // A fold that moves Home out of the column takes its keyboard along.
  useEffect(() => () => {
    if (inColumn) setSearching(false);
  }, [inColumn, setSearching]);
  const onFocusChange = (focused: boolean) => {
    setTyping(focused);
    if (inColumn) setSearching(focused);
  };
  // The keyboard closes while the app is in the background, and that last update never reaches
  // the screen; reading it again on each return puts the bar back on the bottom edge. Listing
  // deps replaces Reanimated's own, so the inset is listed too (a rotation changes it).
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: follows ? -Math.max(0, keyboard.height.value - insets.bottom) : 0 }] }), [returns, insets.bottom, follows]);
  return (
    <Animated.View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }, lift]}>
      {/* Keyed by its size: an Svg keeps drawing at its first one when a foldable opens or closes. */}
      <Svg key={`${width}:${insets.bottom}`} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <LinearGradient id="home-bar-fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={theme.colors.background} stopOpacity={0} />
            <Stop offset="0.3" stopColor={theme.colors.background} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#home-bar-fade)" />
      </Svg>
      <View style={[styles.search, { backgroundColor: theme.colors.surfaceRaised }]}>
        <Icon ios="magnifyingglass" android="search" size={16} />
        <TextInput
          testID="panes-search"
          accessibilityLabel="Search panes"
          placeholder="Search panes"
          placeholderTextColor={theme.colors.textMuted}
          selectionColor={theme.colors.accent}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          value={query}
          onChangeText={onQuery}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          style={[theme.typography.body, styles.input, { color: theme.colors.text }]}
        />
        {query ? (
          <IconButton label="Clear search" testID="panes-search-clear" size={30} onPress={() => onQuery('')}>
            <Icon ios="xmark.circle.fill" android="cancel" size={17} />
          </IconButton>
        ) : null}
      </View>
      {canCreate ? <Pressable
        testID="home-new"
        accessibilityRole="button"
        accessibilityLabel="New"
        accessibilityHint="Starts a Session or a Pane"
        onPress={() => router.push('/new')}
        style={({ pressed }) => [styles.new, { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 }]}
      >
        <Icon ios="plus" android="add" size={22} color={theme.colors.onAccent} />
      </Pressable> : null}
    </Animated.View>
  );
}

/** Counts returns from the background. */
function useReturnsToForeground(): number {
  const [returns, setReturns] = useState(0);
  useEffect(() => {
    let backgrounded = false;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') backgrounded = true;
      else if (state === 'active' && backgrounded) {
        backgrounded = false;
        setReturns(count => count + 1);
      }
    });
    return () => subscription.remove();
  }, []);
  return returns;
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: PADDING_TOP },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: CONTROL, borderRadius: CONTROL / 2, paddingLeft: 16, paddingRight: 7 },
  input: { flex: 1, paddingVertical: 0 },
  new: { width: CONTROL, height: CONTROL, borderRadius: CONTROL / 2, alignItems: 'center', justifyContent: 'center' },
});
