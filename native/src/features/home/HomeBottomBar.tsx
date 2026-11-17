import { router } from 'expo-router';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

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
 * Home's bottom bar, in thumb reach: Search panes, and + for a new Session or Pane. It rides up with
 * the keyboard, and fades the list out under it.
 */
export function HomeBottomBar({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: -Math.max(0, keyboard.height.value - insets.bottom) }] }));
  return (
    <Animated.View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }, lift]}>
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
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
          style={[theme.typography.body, styles.input, { color: theme.colors.text }]}
        />
        {query ? (
          <IconButton label="Clear search" testID="panes-search-clear" size={30} onPress={() => onQuery('')}>
            <Icon ios="xmark.circle.fill" android="cancel" size={17} />
          </IconButton>
        ) : null}
      </View>
      <Pressable
        testID="home-new"
        accessibilityRole="button"
        accessibilityLabel="New"
        accessibilityHint="Starts a Session or a Pane"
        onPress={() => router.push('/new')}
        style={({ pressed }) => [styles.new, { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 }]}
      >
        <Icon ios="plus" android="add" size={22} color={theme.colors.onAccent} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: PADDING_TOP },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: CONTROL, borderRadius: CONTROL / 2, paddingLeft: 16, paddingRight: 7 },
  input: { flex: 1, paddingVertical: 0 },
  new: { width: CONTROL, height: CONTROL, borderRadius: CONTROL / 2, alignItems: 'center', justifyContent: 'center' },
});
