import { useEffect, useState } from 'react';
import { Bell, BellOff, Shield } from 'lucide-react';
import { Button } from './ui/Button';
import { SettingsSection } from './ui/SettingsSection';
import { SettingRow, SettingsPage } from './settings/SettingRow';
import { ImmediateToggle } from './settings/SettingsControls';
import type { SettingsPersistence } from './settings/useSettingsPersistence';

export function NotificationSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const notifications = config.notifications ?? { playSound: false, enabled: true };
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission | 'unsupported'>('default');
  const [actionResult, setActionResult] = useState<string | null>(null);

  useEffect(() => {
    setPermissionStatus('Notification' in window ? Notification.permission : 'unsupported');
  }, []);

  const requestPermission = async () => {
    if (!('Notification' in window)) {
      setActionResult('Desktop notifications are not supported in this environment.');
      return;
    }
    const permission = await Notification.requestPermission();
    setPermissionStatus(permission);
    setActionResult(permission === 'granted' ? 'Notification access enabled.' : 'Notification access was not granted.');
  };

  const testNotification = () => {
    if (Notification.permission !== 'granted') {
      setActionResult('Enable notification access before sending a test.');
      return;
    }
    new Notification('Pane is ready to ping you', {
      body: 'You will see notifications like this when a terminal panel finishes.',
      icon: '/favicon.ico',
    });
    setActionResult('Test notification sent.');
  };

  const permissionLabel = permissionStatus === 'granted'
    ? 'Enabled'
    : permissionStatus === 'denied'
      ? 'Denied by the operating system'
      : permissionStatus === 'unsupported'
        ? 'Unsupported'
        : 'Not requested';
  const PermissionIcon = permissionStatus === 'granted' ? Bell : permissionStatus === 'denied' ? BellOff : Shield;

  return (
    <SettingsPage title="Notifications" description="Application-wide desktop alerts and sound.">
      <SettingsSection title="Permission">
        <SettingRow
          settingId="notification-permission"
          label="Desktop notification access"
          description={actionResult ?? permissionLabel}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <PermissionIcon className="h-4 w-4 text-text-tertiary" />
            {permissionStatus !== 'granted' && permissionStatus !== 'unsupported' && (
              <Button type="button" size="sm" onClick={requestPermission}>Enable</Button>
            )}
            {permissionStatus === 'granted' && (
              <Button type="button" variant="secondary" size="sm" onClick={testNotification}>Test</Button>
            )}
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Alerts">
        <SettingRow
          settingId="desktop-notifications"
          label="Desktop notifications"
          description="Notify when a pane finishes while Pane is in the background. When Dictate is running, alerts show in its pill."
          saveState={persistence.saveStates['desktop-notifications']}
        >
          <ImmediateToggle
            label="Desktop notifications"
            value={notifications.enabled}
            onSave={(enabled) => persistence.saveConfig('desktop-notifications', {
              notifications: { ...notifications, enabled },
            })}
          />
        </SettingRow>
        <SettingRow
          settingId="notification-sound"
          label="Play notification sounds"
          description="Play a short sound when Pane sends a desktop notification."
          saveState={persistence.saveStates['notification-sound']}
        >
          <ImmediateToggle
            label="Play notification sounds"
            value={notifications.playSound}
            onSave={(playSound) => persistence.saveConfig('notification-sound', {
              notifications: { ...notifications, playSound },
            })}
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
