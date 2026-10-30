import { useEffect, useState } from 'react';
import { Bell, BellOff, Shield } from 'lucide-react';
import { Button } from './ui/Button';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { SettingsSection } from './ui/SettingsSection';
import { SettingRow, SettingsPage } from './settings/SettingRow';
import { ImmediateToggle } from './settings/SettingsControls';
import type { SettingsPersistence } from './settings/useSettingsPersistence';
import type { TestNotificationResult } from '../../../shared/types/notifications';

export function NotificationSettings({ persistence }: { persistence: SettingsPersistence }) {
  const config = persistence.config!;
  const notifications = config.notifications ?? { playSound: false, enabled: true };
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission | 'unsupported'>('default');
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [offerSettings, setOfferSettings] = useState(false);
  const [testing, setTesting] = useState(false);

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

  const testNotification = async () => {
    setOfferSettings(false);
    setTesting(true);
    let result: TestNotificationResult;
    try {
      result = await window.electronAPI.notifications.test();
    } catch (error) {
      setActionResult(`Pane couldn't send the test notification (${ipcErrorMessage(error, 'unknown error')}). Check Pane in your system's notification settings, then test again.`);
      return;
    } finally {
      setTesting(false);
    }
    if (result.status === 'shown') setActionResult('Test notification sent.');
    else if (result.status === 'unsupported') setActionResult('Desktop notifications are not supported in this environment.');
    else {
      setActionResult(result.status === 'blocked'
        ? "macOS is blocking Pane's notifications. Allow Pane in System Settings → Notifications, then test again."
        : result.status === 'failed'
          ? `The system didn't show the test notification (${result.error}). Check Pane in your system's notification settings.`
          : "Pane sent the test, but the system didn't confirm it. If nothing appeared, allow Pane in your system's notification settings.");
      setOfferSettings(result.canOpenSettings);
    }
  };

  const openNotificationSettings = async () => {
    try {
      await window.electronAPI.notifications.openSettings();
    } catch (error) {
      setActionResult(ipcErrorMessage(error, "Pane couldn't open your system's notification settings. Open them yourself and allow Pane."));
    }
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
            {offerSettings && (
              <Button type="button" variant="secondary" size="sm" onClick={() => void openNotificationSettings()}>
                Open notification settings
              </Button>
            )}
            {permissionStatus === 'granted' && (
              <Button type="button" variant="secondary" size="sm" loading={testing} loadingText="Testing…" onClick={() => void testNotification()}>Test</Button>
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
