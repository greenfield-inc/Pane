import { useHostsStore } from '@/auth/hostsStore';
import { isDemoProfile } from '@/features/demo/demoHost';
import { NotificationSettings } from '@/features/notifications/NotificationSettings';
import { Screen, Text } from '@/ui';

/** Settings › Notifications: the phone-wide switches, and whether each saved machine can alert this phone. */
export default function NotificationsSettingsScreen() {
  const saved = useHostsStore(state => state.profiles).some(profile => !isDemoProfile(profile));
  return (
    <Screen scroll grouped testID="notifications-settings">
      {saved
        ? <NotificationSettings />
        : <Text variant="subhead" tone="secondary">Alerts come from the computers saved on this phone. The demo has none.</Text>}
    </Screen>
  );
}
