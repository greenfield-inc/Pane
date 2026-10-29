import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import type { PaneListEntry } from './paneList';
import { StatusBadge, statusPresentation } from './StatusBadge';
import { SwipeRow, swipeRowAccessibility } from './SwipeRow';

export interface PaneRowProps {
  pane: PaneListEntry;
  /** The pane name, or "project/pane" in the Pinned section. */
  label: string;
  onOpen: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}

/** The PWA drawer's pane row, with the live agent status as a dot. Swipe right pins, swipe left archives. */
export function PaneRow({ pane, label, onOpen, onTogglePinned, onArchive }: PaneRowProps) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  const agent = AGENT_LAUNCH_PRESETS.find(preset => preset.id === pane.agent)?.title;
  const status = [statusPresentation[pane.status].label, agent].filter(Boolean).join(' · ');
  const actions = { pinned: pane.isFavorite, onTogglePinned, onArchive };

  return (
    <SwipeRow testIDPrefix="pane" id={pane.id} {...actions}>
      <Pressable
        testID={`pane-row-${pane.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${status}`}
        {...swipeRowAccessibility(actions)}
        onPress={onOpen}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={[styles.open, { backgroundColor: pressed ? theme.colors.selected : theme.colors.background }]}
      >
        <StatusBadge status={pane.status} />
        <Text variant="callout" numberOfLines={1} style={[styles.name, { color: pressed ? theme.colors.text : theme.colors.textSecondary }]}>
          {label}
        </Text>
      </Pressable>
    </SwipeRow>
  );
}

const styles = StyleSheet.create({
  // PWA row: rounded-md px-3 py-3 gap-2 around an h-8 line = 56.
  open: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 12 },
  name: { flex: 1 },
});
