import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { buildAllMachinesList, recentlyOpened } from '@/features/allMachines/allMachinesList';
import { offlineAlert, openRecentRow, RecentRowView } from '@/features/allMachines/AllMachinesRows';
import { sessionKey } from '@/features/approvals/approvals';
import { sessionWaiting } from '@/features/home/statusBoard';
import { useHomeFeeds } from '@/features/home/useHomeData';
import { usePaneActions } from '@/features/panes/usePaneActions';
import { useTheme } from '@/theme';
import { Sheet, Text } from '@/ui';

import { FocusScope } from './FocusScope';

/**
 * A controller's − : the Panes and Sessions last opened on any device, as
 * Home's Recent lists them, to pick with the stick and A. B closes it.
 */
export function RecentSheet() {
  const theme = useTheme();
  const { here, all, feeds, chipMachines } = useHomeFeeds({ active: true });
  const actions = usePaneActions();
  const board = buildAllMachinesList(feeds, '');
  const rows = recentlyOpened(board.recent);
  const waiting = sessionWaiting(board);
  const sayOffline = offlineAlert(feeds, chipMachines);
  const close = () => router.back();
  return (
    <FocusScope bare onBack={close}>
      <Sheet title="Recent" testID="recent-sheet">
        {rows.length === 0 ? <Text variant="body" tone="secondary">Panes and Sessions you open show here.</Text> : (
          <View style={[styles.card, { borderRadius: theme.radius.card, backgroundColor: theme.colors.surfaceRaised }]}>
            {rows.map((row, index) => (
              <RecentRowView
                key={row.key}
                idPrefix="recent-sheet"
                card={{ divided: index > 0 }}
                row={row}
                at={row.openedAt}
                waiting={row.type === 'session' ? waiting.get(sessionKey(row.machineKey, row.session.id)) ?? 0 : 0}
                machine={all ? chipMachines.find(machine => machine.key === row.machineKey) : undefined}
                currentKey={here.profile.id}
                actions={actions}
                onOpen={() => {
                  close();
                  openRecentRow(row, here.profile.id, actions, sayOffline);
                }}
              />
            ))}
          </View>
        )}
      </Sheet>
    </FocusScope>
  );
}

const styles = StyleSheet.create({
  card: { overflow: 'hidden' },
});
