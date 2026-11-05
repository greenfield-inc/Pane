import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';

import { useTheme } from '@/theme';
import { Text } from '@/ui';

import type { PaneListEntry } from './paneList';
import { PausedBadge, StatusBadge, statusPresentation } from './StatusBadge';
import { SwipeRow, swipeRowAccessibility } from './SwipeRow';

export interface PaneRowProps {
  pane: PaneListEntry;
  /** The pane name, or "project/pane" in the Pinned section. */
  label: string;
  onOpen: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  onTogglePaused: () => void;
}

/**
 * The PWA drawer's pane row, with the live agent status as a dot; a paused Pane is grayed out with
 * a pause glyph in the dot's place. Swipe right pins; swipe left pauses or resumes, and archives.
 */
export function PaneRow({ pane, label, onOpen, onTogglePinned, onArchive, onTogglePaused }: PaneRowProps) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  const paused = Boolean(pane.paused);
  const agent = AGENT_LAUNCH_PRESETS.find(preset => preset.id === pane.agent)?.title;
  const status = [paused ? 'Paused' : statusPresentation[pane.status].label, agent].filter(Boolean).join(' · ');
  const actions = { pinned: pane.isFavorite, onTogglePinned, onArchive, pause: { paused, onToggle: onTogglePaused } };

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
        {paused ? <PausedBadge /> : <StatusBadge status={pane.status} />}
        <Text variant="callout" numberOfLines={1} style={[styles.name, { color: pressed ? theme.colors.text : paused ? theme.colors.textMuted : theme.colors.textSecondary }]}>
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
