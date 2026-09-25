import * as Haptics from 'expo-haptics';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';

import { useTheme, type ThemeColors } from '@/theme';
import { Icon, Text } from '@/ui';

import type { PaneListEntry, RowPosition } from './paneList';
import { StatusBadge, statusPresentation } from './StatusBadge';

export interface PaneRowProps {
  pane: PaneListEntry;
  position: RowPosition;
  /** Favorites mix projects, so their rows name the project. */
  showProject: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onArchive: () => void;
}

export function PaneRow({ pane, position, showProject, onOpen, onToggleFavorite, onArchive }: PaneRowProps) {
  const theme = useTheme();
  const agent = AGENT_LAUNCH_PRESETS.find(preset => preset.id === pane.agent)?.title;
  const subtitle = [
    statusPresentation[pane.status].label,
    agent,
    showProject ? pane.projectName : pane.baseBranch,
  ].filter(Boolean).join(' · ');
  const favoriteTitle = pane.isFavorite ? 'Unfavorite' : 'Favorite';
  const rounded = {
    borderTopLeftRadius: position === 'first' || position === 'only' ? theme.radius.md : 0,
    borderTopRightRadius: position === 'first' || position === 'only' ? theme.radius.md : 0,
    borderBottomLeftRadius: position === 'last' || position === 'only' ? theme.radius.md : 0,
    borderBottomRightRadius: position === 'last' || position === 'only' ? theme.radius.md : 0,
  };

  return (
    <View style={[styles.outer, rounded]}>
      <ReanimatedSwipeable
        friction={2}
        overshootFriction={8}
        leftThreshold={48}
        rightThreshold={48}
        renderLeftActions={(_progress, _translation, swipe) => (
          <SwipeAction
            testID={`pane-favorite-${pane.id}`}
            label={favoriteTitle}
            color="warning"
            ios={pane.isFavorite ? 'star.slash.fill' : 'star.fill'}
            android="star"
            onPress={() => { swipe.close(); onToggleFavorite(); }}
          />
        )}
        renderRightActions={(_progress, _translation, swipe) => (
          <SwipeAction
            testID={`pane-archive-${pane.id}`}
            label="Archive"
            color="danger"
            ios="archivebox.fill"
            android="archive"
            onPress={() => { swipe.close(); onArchive(); }}
          />
        )}
        onSwipeableWillOpen={() => void Haptics.selectionAsync()}
      >
        <Link href={{ pathname: '/pane/[paneId]', params: { paneId: pane.id } }} asChild onPress={onOpen}>
          <Link.Trigger>
            <Pressable
              testID={`pane-row-${pane.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${pane.name}, ${subtitle}${pane.isFavorite ? ', favorite' : ''}`}
              accessibilityActions={[{ name: 'favorite', label: favoriteTitle }, { name: 'archive', label: 'Archive' }]}
              onAccessibilityAction={event => (event.nativeEvent.actionName === 'archive' ? onArchive() : onToggleFavorite())}
              style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surface }]}
            >
              <StatusBadge status={pane.status} />
              <View style={[styles.body, position !== 'first' && position !== 'only' && { borderTopColor: theme.colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
                <View style={styles.text}>
                  <Text variant="body" numberOfLines={1}>{pane.name}</Text>
                  <Text variant="footnote" tone="muted" numberOfLines={1}>{subtitle}</Text>
                </View>
                {pane.isFavorite ? <Icon ios="star.fill" android="star" size={14} color={theme.colors.warning} /> : null}
                <Icon ios="chevron.right" android="chevron_right" size={14} />
              </View>
            </Pressable>
          </Link.Trigger>
          <Link.Menu>
            <Link.MenuAction icon={pane.isFavorite ? 'star.slash' : 'star'} onPress={onToggleFavorite}>{favoriteTitle}</Link.MenuAction>
            <Link.MenuAction icon="archivebox" destructive onPress={onArchive}>Archive</Link.MenuAction>
          </Link.Menu>
        </Link>
      </ReanimatedSwipeable>
    </View>
  );
}

interface SwipeActionProps {
  label: string;
  color: keyof ThemeColors;
  ios: 'star.fill' | 'star.slash.fill' | 'archivebox.fill';
  android: 'star' | 'archive';
  onPress: () => void;
  testID: string;
}

function SwipeAction({ label, color, ios, android, onPress, testID }: SwipeActionProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.action, { backgroundColor: theme.colors[color] }]}
    >
      <Icon ios={ios} android={android} size={20} color={theme.colors.onAccent} />
      <Text variant="caption" tone="onAccent">{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: { marginHorizontal: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, gap: 12 },
  body: { flex: 1, minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 16, paddingVertical: 10 },
  text: { flex: 1, gap: 2 },
  action: { width: 84, alignItems: 'center', justifyContent: 'center', gap: 4 },
});
