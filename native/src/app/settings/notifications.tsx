import { router } from 'expo-router';

import { useDaemon } from '@/daemon';
import { NotificationSettings } from '@/features/notifications/NotificationSettings';
import { ListRow, ListSection, Screen } from '@/ui';

/** Settings › Notifications: alerts from the current machine. */
export default function NotificationsSettingsScreen() {
  const { profile } = useDaemon();
  return (
    <Screen scroll grouped testID="notifications-settings">
      {profile.tailnetMachine ? (
        <ListSection title="Notifications" titleSuffix={`on ${profile.label}`} footer="Alerts need this phone paired with a code.">
          <ListRow testID="notifications-code-required" title="Connect with a code" subtitle="Pair this phone to receive alerts" trailing="chevron" onPress={() => router.push('/hosts/add')} />
        </ListSection>
      ) : <NotificationSettings />}
    </Screen>
  );
}
