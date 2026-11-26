import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';

import { useNotifyCommand } from '@/features/notify/hooks';
import { useTheme } from '@/theme';
import { Text } from '@/ui';

import { archivedLine, createArchiveHold, type HeldArchive } from './archiveHold';

type ArchiveHold = ReturnType<typeof useHeldArchives>;
const ArchiveHoldContext = createContext<ArchiveHold | null>(null);

/**
 * Holds Home's swiped archives for the host's whole signed-in frame, so Home moving between the
 * phone layout and the docked column (a fold) keeps Undo. Render it inside `DaemonProvider`.
 */
export function ArchiveHoldProvider({ children }: { children: ReactNode }) {
  return <ArchiveHoldContext value={useHeldArchives()}>{children}</ArchiveHoldContext>;
}

/**
 * Swipe-to-archive on this machine's approvals: each close is held for Undo, then sent the way the
 * card's Close sends it with no reason. What is held goes out at once when the app leaves the
 * foreground or the machine's frame closes, so an archive is never lost.
 */
export function useArchiveHold(): ArchiveHold {
  const hold = use(ArchiveHoldContext);
  if (!hold) throw new Error('useArchiveHold needs an ArchiveHoldProvider above it.');
  return hold;
}

function useHeldArchives() {
  const command = useNotifyCommand();
  const [hold] = useState(() => createArchiveHold(id => command.mutateAsync([{ type: 'close', id }])));
  const state = useSyncExternalStore(hold.subscribe, hold.snapshot);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') hold.flush();
    });
    return () => {
      subscription.remove();
      hold.flush();
    };
  }, [hold]);
  return {
    ...state,
    archive: hold.archive,
    undo: hold.undo,
    dismiss: hold.dismiss,
  };
}

/** "Archived <title> · Undo", floating `bottom` points above the screen's foot while a close is held. */
export function ArchiveUndoBar({ held, onUndo, bottom }: { held: readonly HeldArchive[]; onUndo: () => void; bottom: number }) {
  const theme = useTheme();
  if (held.length === 0) return null;
  return (
    <View
      testID="approvals-archive-toast"
      accessibilityLiveRegion="polite"
      style={[styles.bar, { bottom, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surfacePressed, borderColor: theme.colors.border }]}
    >
      <Text variant="subhead" numberOfLines={1} style={styles.line}>{archivedLine(held)}</Text>
      <Pressable testID="approvals-archive-undo" accessibilityRole="button" accessibilityLabel="Undo archive" onPress={onUndo} style={styles.undo}>
        <Text variant="subhead" tone="accent" style={styles.undoLabel}>Undo</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, borderWidth: StyleSheet.hairlineWidth },
  line: { flex: 1, minWidth: 0 },
  undo: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  undoLabel: { fontWeight: '600' },
});
