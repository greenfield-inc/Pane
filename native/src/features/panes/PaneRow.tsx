import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { AGENT_LAUNCH_PRESETS } from '@shared/constants/agentLaunchPresets';

import { useTheme } from '@/theme';
import { NewBadge } from '@/features/approvals/NewBadge';
import { Text } from '@/ui';

import type { PaneListEntry } from './paneList';
import { PausedBadge, StatusBadge, statusPresentation } from './StatusBadge';
import { SwipeRow, useSwipeRowAccessibility } from './SwipeRow';

export interface PaneRowProps {
  pane: PaneListEntry;
  /** The pane name, or "project/pane" in the Pinned section. */
  label: string;
  onOpen: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  onTogglePaused: () => void;
  /** Muted text at the row's end, such as its repository under Pinned. */
  detail?: string;
  /** What the row sits on, so its swipe actions stay hidden: the page, or a card. */
  background?: string;
  /** What waits on you in this Pane that the phone hasn't shown you yet: "+N" at the row's end. */
  fresh?: number;
}

/**
 * A one-line pane row, 44 pt tall, with the live agent status as a dot; a paused Pane is grayed out with
 * a pause glyph in the dot's place. Swipe right pins; swipe left pauses or resumes, and archives.
 */
export function PaneRow({ pane, label, onOpen, onTogglePinned, onArchive, onTogglePaused, detail, background, fresh = 0 }: PaneRowProps) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  const paused = Boolean(pane.paused);
  const agent = AGENT_LAUNCH_PRESETS.find(preset => preset.id === pane.agent)?.title;
  const status = [paused ? 'Paused' : statusPresentation[pane.status].label, agent].filter(Boolean).join(' · ');
  const actions = { pinned: pane.isFavorite, onTogglePinned, onArchive, pause: { paused, onToggle: onTogglePaused } };
  const accessibility = useSwipeRowAccessibility(actions);

  return (
    <SwipeRow testIDPrefix="pane" id={pane.id} {...actions}>
      <Pressable
        testID={`pane-row-${pane.id}`}
        accessibilityRole="button"
        accessibilityLabel={[label, status, detail, fresh > 0 ? `${fresh} new` : undefined].filter(Boolean).join(', ')}
        {...accessibility}
        onPress={onOpen}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        style={[styles.open, { backgroundColor: pressed ? theme.colors.selected : background ?? theme.colors.background }]}
      >
        {paused ? <PausedBadge /> : <StatusBadge status={pane.status} />}
        <Text variant="rowValue" numberOfLines={1} style={[styles.name, { color: pressed ? theme.colors.text : paused ? theme.colors.textMuted : theme.colors.textSecondary }]}>
          {label}
        </Text>
        {detail ? <Text variant="rowDetail" tone="muted" numberOfLines={1} style={styles.detail}>{detail}</Text> : null}
        <NewBadge count={fresh} testID={`pane-new-${pane.id}`} />
      </Pressable>
    </SwipeRow>
  );
}

const styles = StyleSheet.create({
  open: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  name: { flex: 1 },
  detail: { flexShrink: 1, maxWidth: '45%' },
});
