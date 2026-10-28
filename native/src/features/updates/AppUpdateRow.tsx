import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

import { useTheme } from '@/theme';
import { Icon, ListRow } from '@/ui';

import { describeUpdateRow } from './updateRow';

// Tapping the row checks for an update now, which answers "did my merge reach
// this phone yet?". A downloaded update applies at the next cold start, or
// right away through Restart to update.
// The dev client reports expo-updates as enabled, but Metro serves the
// JavaScript there.
const updatesEnabled = Updates.isEnabled && !__DEV__;

export function AppUpdateRow() {
  const theme = useTheme();
  const { currentlyRunning, isChecking, isDownloading, isUpdatePending, checkError, downloadError } = Updates.useUpdates();
  const row = describeUpdateRow({
    version: Constants.expoConfig?.version ?? '?',
    updatesEnabled,
    isEmbeddedLaunch: currentlyRunning.isEmbeddedLaunch,
    updateId: currentlyRunning.updateId,
    createdAt: currentlyRunning.createdAt,
    isChecking,
    isDownloading,
    isUpdatePending,
    failed: Boolean(checkError ?? downloadError),
  });

  const checkNow = async () => {
    // Failures land in checkError and downloadError, which the row shows.
    const check = await Updates.checkForUpdateAsync().catch(() => null);
    if (check?.isAvailable) await Updates.fetchUpdateAsync().catch(() => null);
  };

  if (row.kind === 'restart') {
    return (
      <ListRow
        testID="settings-app-restart"
        title={row.title}
        subtitle={row.subtitle}
        leading={<Icon ios="arrow.clockwise.circle.fill" android="refresh" size={20} color={theme.colors.accentText} />}
        onPress={() => void Updates.reloadAsync()}
      />
    );
  }
  return (
    <ListRow
      testID="settings-app-version"
      title={row.title}
      subtitle={row.kind === 'version' ? row.subtitle : undefined}
      onPress={updatesEnabled && row.kind === 'version' ? () => void checkNow() : undefined}
    />
  );
}
