import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useHostsStore } from '@/auth/hostsStore';
import { resolveOpenTarget } from '@/features/links/links';
import { useTheme } from '@/theme';
import { Button, EmptyState } from '@/ui';

/**
 * Opens a pane named by a `pane://pane/…?host=` link or a notification tap,
 * switching to its host first. It only ever connects to a saved host.
 */
export default function OpenScreen() {
  const theme = useTheme();
  const { host, paneId, panelId } = useLocalSearchParams<{ host?: string; paneId?: string; panelId?: string }>();
  const profiles = useHostsStore(state => state.profiles);
  const activeId = useHostsStore(state => state.activeId);
  const setActive = useHostsStore(state => state.setActive);
  const resolved = host ? resolveOpenTarget({ host, paneId, panelId }, { profiles, activeId }) : { type: 'unknown-host' as const };

  const hostId = resolved.type === 'open' ? resolved.hostId : null;
  const switchHost = resolved.type === 'open' && resolved.switchHost;

  useEffect(() => {
    if (!hostId) return;
    // Switching hosts remounts the signed-in stack; this screen runs again on the new host.
    if (switchHost) {
      void setActive(hostId);
      return;
    }
    // Start from the host's pane list, so Back never lands on another host's screens.
    router.dismissTo('/');
    if (paneId) router.push({ pathname: '/pane/[paneId]', params: panelId ? { paneId, panelId } : { paneId } });
  }, [hostId, switchHost, paneId, panelId, setActive]);

  if (resolved.type === 'unknown-host') {
    return (
      <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
        <EmptyState
          testID="open-unknown-host"
          title="Host not on this phone"
          message="This link or notification is for a Pane host this phone isn't connected to. Pair with that host, then try again."
          action={<Button testID="open-dismiss" title="OK" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />}
        />
      </View>
    );
  }
  return (
    <View testID="open-loading" style={[styles.fill, styles.center, { backgroundColor: theme.colors.background }]}>
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
});
