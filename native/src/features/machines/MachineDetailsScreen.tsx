import { router, Stack } from 'expo-router';
import { Alert, StyleSheet, View } from 'react-native';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import { MACHINE_COLOR_NAMES } from '@shared/utils/machineColor';

import { useHostsStore } from '@/auth/hostsStore';
import { useDaemon } from '@/daemon';
import { isDemoProfile } from '@/features/demo/demoHost';
import type { PushSetupResult } from '@/features/notifications/registration';
import { signOutPush, usePushStore } from '@/features/notifications/usePushSetup';
import { useTheme } from '@/theme';
import { ListRow, ListSection, Screen, Text } from '@/ui';

import { hostOf, type Machine } from './machines';
import { MachineMark } from './MachineMark';
import { useMachines, useSelectMachine } from './useMachines';

/** Machine details: where a machine is, how it's connected, its color, and Sign out. */
export function MachineDetailsScreen({ machineKey }: { machineKey: string }) {
  const machines = useMachines();
  const machine = machines.find(candidate => candidate.key === machineKey);
  if (!machine) {
    return (
      <Screen grouped testID="machine-details-missing">
        <Text variant="subhead" tone="secondary">This machine is no longer on this phone.</Text>
      </Screen>
    );
  }
  return <Details machine={machine} />;
}

function Details({ machine }: { machine: Machine }) {
  const theme = useTheme();
  const { connection } = useDaemon();
  const remove = useHostsStore(state => state.remove);
  const exitDemo = useHostsStore(state => state.exitDemo);
  const { select, connecting } = useSelectMachine();
  const { profile, tailnet } = machine;
  const demo = profile ? isDemoProfile(profile) : false;
  const alerts = usePushStore(state => (profile ? state.results[profile.id] : undefined));
  const how = machine.current && connection.status === 'connected'
    ? profile?.tailnetMachine ? ' over Tailscale' : ' with a code'
    : '';
  const address = profile ? hostOf(profile.baseUrl) : tailnet?.dnsName.replace(/\.$/, '') ?? '';

  const confirmSignOut = (saved: RemotePaneConnectionProfile) => {
    Alert.alert(
      `Sign out of ${saved.label}?`,
      'Pane forgets this machine on this phone. Connect again to use it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => {
            // Signing out of the current machine switches to another and remounts every screen.
            if (!machine.current) router.back();
            void signOutPush(saved, () => void remove(saved.id));
          },
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: machine.name }} />
      <Screen scroll grouped testID="machine-details">
        <View style={styles.hero}>
          <MachineMark os={machine.os} slot={machine.slot} state={machine.state} variant="tile" size={72} />
          <Text variant="largeTitle" numberOfLines={1} style={styles.center}>{machine.name}</Text>
          <Text variant="subhead" tone="muted" style={styles.center}>{`${machine.os ?? 'Computer'} · ${machine.status}${how}`}</Text>
        </View>

        <ListSection title="Connection" footer={machine.current ? connection.lastError ?? undefined : undefined}>
          <ListRow testID="machine-address" title="Address" subtitle={address} />
          <ListRow testID="machine-status" title="Status" subtitle={machine.status} />
        </ListSection>

        <ListSection title="On this phone" footer="Every saved machine can alert this phone. The color marks this machine everywhere in Pane.">
          <ListRow
            testID="machine-notifications"
            title="Notifications"
            value={demo ? 'Not in the demo' : profile ? alertText(alerts) : 'After you connect'}
            trailing={profile && !demo ? 'chevron' : undefined}
            onPress={profile && !demo ? () => router.push('/settings/notifications') : undefined}
          />
          <ListRow
            testID="machine-color"
            title="Color"
            value={MACHINE_COLOR_NAMES[machine.slot]}
            trailing={<View style={[styles.swatch, { backgroundColor: theme.machine[machine.slot] }]} />}
          />
        </ListSection>

        <ListSection>
          {demo ? (
            <ListRow testID="settings-exit-demo" title="Exit Demo" subtitle="Sample data only. Nothing here is real." destructive onPress={exitDemo} />
          ) : profile ? (
            <ListRow testID="machine-sign-out" title={`Sign out of ${machine.name}`} destructive onPress={() => confirmSignOut(profile)} />
          ) : (
            <ListRow
              testID="machine-connect"
              title={connecting === tailnet?.name ? 'Connecting…' : `Connect to ${machine.name}`}
              accent
              onPress={machine.selectable && !connecting ? () => select(machine) : undefined}
            />
          )}
        </ListSection>
      </Screen>
    </>
  );
}

/** One word for the Notifications row; the Notifications screen explains anything else. */
function alertText(result: PushSetupResult | undefined): string {
  if (!result) return 'Checking…';
  return result.state === 'registered' ? 'On' : 'Not set up';
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 6, paddingTop: 8 },
  center: { textAlign: 'center' },
  swatch: { width: 14, height: 14, borderRadius: 7 },
});
