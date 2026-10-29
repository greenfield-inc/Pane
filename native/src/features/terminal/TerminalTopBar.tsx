import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useDaemon } from '@/daemon';
import { useTheme } from '@/theme';
import { Icon, ListRow, Text } from '@/ui';

import { ComposerSheet, useAfterSheetCloses } from '../composer/ComposerSheet';
import { ConnectionBar, presenceLabel } from '../hosts/ConnectionStatus';
import { useConnectionPresence } from '../hosts/useConnectionPresence';
import { MachineMark } from '../machines/MachineMark';
import { shortMachineName } from '../machines/machines';
import { useMachines } from '../machines/useMachines';

/**
 * The web app's status bar, drawn below the top safe area: back, the machine
 * dot and name, the pane name, and a "…" menu with host settings and, when a
 * terminal is open, Clear scrollback. Once the grace window passes, the
 * connection bar sits under it.
 */
export function TerminalTopBar({ paneName, onClearScrollback }: { paneName: string; onClearScrollback?: () => void }) {
  const theme = useTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const { profile } = useDaemon();
  const { presence, notice, retry } = useConnectionPresence();
  const current = useMachines().find(machine => machine.current);
  const [menuOpen, setMenuOpen] = useState(false);
  const { afterClose, onDismiss } = useAfterSheetCloses();
  const choose = (action: () => void) => {
    afterClose(action);
    setMenuOpen(false);
  };

  return (
    <>
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: 1 }}>
        <View style={styles.row}>
          <View style={styles.leading}>
            <Pressable
              testID="terminal-back"
              accessibilityRole="button"
              accessibilityLabel={paneName ? `Back from ${paneName}` : 'Back'}
              hitSlop={4}
              onPress={() => router.back()}
              style={({ pressed }) => [
                styles.back,
                { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' },
              ]}
            >
              <Icon ios="chevron.left" android="arrow_back" size={20} color={colors.textSecondary} />
            </Pressable>
            {/* The machine's own mark, as on home and in Settings: it pulses and dims with the connection. */}
            <View style={styles.mark}>{current ? <MachineMark os={current.os} slot={current.slot} state={current.state} /> : null}</View>
            <View style={styles.text}>
              <View style={styles.titleRow}>
                <Text
                  variant="subhead"
                  style={[styles.semibold, styles.shrink]}
                  numberOfLines={1}
                  accessibilityLabel={presenceLabel(presence, profile.label)}
                >
                  {shortMachineName(profile.label, 5)}
                </Text>
                {paneName ? (
                  <>
                    <Text variant="subhead" tone="muted" importantForAccessibility="no" accessibilityElementsHidden>›</Text>
                    <Text variant="subhead" tone="secondary" style={styles.pane} numberOfLines={1}>{paneName}</Text>
                  </>
                ) : null}
              </View>
            </View>
          </View>
          <Pressable
            testID="terminal-more"
            accessibilityRole="button"
            accessibilityLabel="More"
            hitSlop={4}
            onPress={() => setMenuOpen(true)}
            style={({ pressed }) => [
              styles.more,
              { borderRadius: theme.radius.md, backgroundColor: pressed ? colors.surfacePressed : 'transparent' },
            ]}
          >
            <Icon ios="ellipsis" android="more_horiz" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
        <ComposerSheet
          visible={menuOpen}
          onClose={() => setMenuOpen(false)}
          onDismiss={onDismiss}
          testID="terminal-menu"
        >
          {onClearScrollback ? (
            <ListRow
              testID="terminal-menu-clear"
              title="Clear scrollback"
              subtitle="Clears this terminal's history here and on the host"
              leading={<Icon ios="clear" android="clear_all" size={18} color={colors.textSecondary} />}
              onPress={() => choose(onClearScrollback)}
            />
          ) : null}
          <ListRow
            testID="terminal-menu-settings"
            title="Settings"
            leading={<Icon ios="gearshape" android="settings" size={18} color={colors.textSecondary} />}
            onPress={() => choose(() => router.push('/settings'))}
          />
        </ComposerSheet>
      </View>
      <ConnectionBar notice={notice} onRetry={retry} />
    </>
  );
}

const styles = StyleSheet.create({
  // One fixed box, so the title doesn't shift while the machine list loads.
  mark: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  leading: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  semibold: { fontWeight: '600' },
  shrink: { flexShrink: 1 },
  pane: { flexShrink: 2 },
  more: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
