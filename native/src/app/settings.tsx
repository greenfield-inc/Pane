import { router } from 'expo-router';
import { Alert } from 'react-native';

import { useHostsStore } from '@/auth/hostsStore';
import { useDaemon } from '@/daemon';
import { ConnectionStatus } from '@/features/hosts/ConnectionStatus';
import { NotificationSettings } from '@/features/notifications/NotificationSettings';
import { revokePush } from '@/features/notifications/usePushSetup';
import { useTheme } from '@/theme';
import { Icon, ListRow, ListSection, Screen } from '@/ui';

export default function SettingsScreen() {
  const theme = useTheme();
  const { client, profile, connection } = useDaemon();
  const profiles = useHostsStore(state => state.profiles);
  const setActive = useHostsStore(state => state.setActive);
  const remove = useHostsStore(state => state.remove);

  const confirmSignOut = () => {
    Alert.alert(
      `Sign out of ${profile.label}?`,
      'Pane forgets this computer on this phone. Connect again to use it.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign Out', style: 'destructive', onPress: () => void (profile.tailnetMachine ? remove(profile.id) : revokePush(client, profile.id).then(() => remove(profile.id))) },
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

      <ListSection title="Composer" footer={`Saved on ${profile.label}, so desktop sees the same settings.`}>
        <ListRow testID="settings-shortcuts" title="Shortcuts" subtitle="Text you insert with one tap" trailing="chevron" onPress={() => router.push('/settings/shortcuts')} />
        <ListRow testID="settings-voice" title="Voice" subtitle="Keys for dictation" trailing="chevron" onPress={() => router.push('/settings/voice')} />
      </ListSection>

      {profile.tailnetMachine ? (
        <ListSection title="Notifications">
          <ListRow testID="notifications-code-required" title="Connect with a Code" subtitle="Pair this phone to receive alerts" trailing="chevron" onPress={() => router.push('/hosts/add')} />
        </ListSection>
      ) : <NotificationSettings />}

      <ListSection title="Hosts" footer="Saved in the iOS Keychain or Android Keystore.">
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
          testID="settings-computers"
          title="Your Computers"
          subtitle="Connect over Tailscale"
          leading={<Icon ios="desktopcomputer" android="desktop_windows" size={20} color={theme.colors.accentText} />}
          trailing="chevron"
          onPress={() => router.push('/computers')}
        />
        <ListRow
          testID="settings-add-host"
          title="Add with a Code"
          leading={<Icon ios="plus.circle.fill" android="add_circle" size={20} color={theme.colors.accentText} />}
          onPress={() => router.push('/hosts/add')}
        />
      </ListSection>
    </Screen>
  );
}
