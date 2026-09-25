import { router } from 'expo-router';
import { Alert } from 'react-native';

import { useHostsStore } from '@/auth/hostsStore';
import { useDaemon } from '@/daemon';
import { ConnectionStatus } from '@/features/hosts/ConnectionStatus';
import { useTheme } from '@/theme';
import { Icon, ListRow, ListSection, Screen } from '@/ui';

export default function SettingsScreen() {
  const theme = useTheme();
  const { profile, connection } = useDaemon();
  const profiles = useHostsStore(state => state.profiles);
  const setActive = useHostsStore(state => state.setActive);
  const remove = useHostsStore(state => state.remove);

  const confirmSignOut = () => {
    Alert.alert(
      `Sign out of ${profile.label}?`,
      'The connection code is deleted from this phone. Pair again to reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign Out', style: 'destructive', onPress: () => void remove(profile.id) },
      ],
    );
  };

  return (
    <Screen scroll testID="settings-screen">
      <ListSection title="Current host" footer={connection.lastError ?? undefined}>
        <ListRow
          testID="settings-current-host"
          title={profile.label}
          subtitle={profile.baseUrl}
          trailing={<ConnectionStatus status={connection.status} />}
        />
        <ListRow testID="settings-sign-out" title="Sign Out" destructive onPress={confirmSignOut} />
      </ListSection>

      <ListSection title="Hosts" footer="Pane keeps each host's connection code in the iOS Keychain or Android Keystore.">
        {profiles.map(host => (
          <ListRow
            key={host.id}
            testID={`settings-host-${host.label}`}
            title={host.label}
            subtitle={host.baseUrl}
            onPress={host.id === profile.id ? undefined : () => void setActive(host.id)}
            trailing={host.id === profile.id
              ? <Icon ios="checkmark" android="check" size={16} color={theme.colors.accentText} />
              : undefined}
          />
        ))}
        <ListRow
          testID="settings-add-host"
          title="Add Host"
          leading={<Icon ios="plus.circle.fill" android="add_circle" size={20} color={theme.colors.accentText} />}
          onPress={() => router.push('/hosts/add')}
        />
      </ListSection>
    </Screen>
  );
}
