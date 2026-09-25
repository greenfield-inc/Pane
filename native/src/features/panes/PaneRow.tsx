import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';

import { useTheme, type ThemeColors } from '@/theme';
import { Icon, Text } from '@/ui';

import type { PaneListEntry } from './paneList';
import { IconButton } from './PaneKit';
import { StatusBadge, statusPresentation } from './StatusBadge';

export interface PaneRowProps {
  pane: PaneListEntry;
  /** The pane name, or "project/pane" in the Pinned section. */
  label: string;
  onOpen: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}

/** The PWA drawer's pane row, with the live agent status as a dot and swipe actions as an extra. */
export function PaneRow({ pane, label, onOpen, onTogglePinned, onArchive }: PaneRowProps) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  const agent = AGENT_LAUNCH_PRESETS.find(preset => preset.id === pane.agent)?.title;
  const status = [statusPresentation[pane.status].label, agent].filter(Boolean).join(' · ');
  const pinLabel = pane.isFavorite ? 'Unpin pane' : 'Pin pane';

  return (
    <View style={[styles.outer, { borderRadius: theme.radius.md }]}>
      <ReanimatedSwipeable
        friction={2}
        overshootFriction={8}
        leftThreshold={48}
        rightThreshold={48}
        renderLeftActions={(_progress, _translation, swipe) => (
          <SwipeAction
            testID={`pane-swipe-pin-${pane.id}`}
            label={pane.isFavorite ? 'Unpin' : 'Pin'}
            color="accent"
            onPress={() => { swipe.close(); onTogglePinned(); }}
          />
        )}
        renderRightActions={(_progress, _translation, swipe) => (
          <SwipeAction
            testID={`pane-swipe-archive-${pane.id}`}
            label="Archive"
            color="danger"
            onPress={() => { swipe.close(); onArchive(); }}
          />
        )}
        onSwipeableWillOpen={() => void Haptics.selectionAsync()}
      >
        <View style={[styles.row, { backgroundColor: pressed ? theme.colors.selected : theme.colors.background }]}>
          <Pressable
            testID={`pane-row-${pane.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${status}`}
            onPress={onOpen}
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            style={styles.open}
          >
            <StatusBadge status={pane.status} />
            <Text variant="callout" numberOfLines={1} style={[styles.name, { color: pressed ? theme.colors.text : theme.colors.textSecondary }]}>
              {label}
            </Text>
          </Pressable>
          <View style={styles.actions}>
            <IconButton testID={`pane-pin-${pane.id}`} label={pinLabel} onPress={onTogglePinned}>
              <View style={styles.pinTilt}>
                <Icon ios="pin" android="keep" size={14} color={pane.isFavorite ? theme.colors.textSecondary : theme.colors.textMuted} />
              </View>
            </IconButton>
            <IconButton testID={`pane-archive-${pane.id}`} label="Archive pane" onPress={onArchive}>
              <Icon ios="archivebox" android="archive" size={14} />
            </IconButton>
          </View>
        </View>
      </ReanimatedSwipeable>
    </View>
  );
}

function SwipeAction({ label, color, onPress, testID }: { label: string; color: keyof ThemeColors; onPress: () => void; testID: string }) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.swipeAction, { backgroundColor: theme.colors[color] }]}
    >
      <Text variant="caption" tone="onAccent">{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // space-y-1 between rows.
  outer: { marginBottom: 4, overflow: 'hidden' },
  // rounded-md px-3 py-3 gap-2; the open target spans the row's full height.
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 12, gap: 8 },
  open: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingVertical: 12 },
  name: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  // Lucide's Pin drawn `rotate-45`.
  pinTilt: { transform: [{ rotate: '45deg' }] },
  swipeAction: { width: 84, alignItems: 'center', justifyContent: 'center' },
});
