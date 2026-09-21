import { useState } from 'react';
import { Download, MessageSquareText, RefreshCw } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import { ImmediateToggle } from '../SettingsControls';
import type { SettingsPersistence } from '../useSettingsPersistence';
import type { VersionInfo } from '../../../types/session';
import { API } from '../../../utils/api';

interface GeneralSettingsProps {
  persistence: SettingsPersistence;
  onUpdate: (versionInfo: VersionInfo) => void;
  onSendFeedback: () => void;
}

export function GeneralSettings({ persistence, onUpdate, onSendFeedback }: GeneralSettingsProps) {
  const config = persistence.config!;
  const [updateInfo, setUpdateInfo] = useState<VersionInfo | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    setUpdateInfo(null);
    setUpdateResult(null);
    try {
      const response = await API.checkForUpdates();
      if (!response.success || !response.data) throw new Error(response.error || 'Failed to check for updates');
      setUpdateInfo(response.data);
      setUpdateResult(response.data.hasUpdate
        ? `Pane v${response.data.latest} is available. You are currently using v${response.data.current}.`
        : `Pane v${response.data.current} is up to date.`);
    } catch (error) {
      setUpdateResult(error instanceof Error ? error.message : 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingsPage title="General" description="Application startup, update, and feedback behavior.">
      <SettingsSection title="Updates" description="Keep Pane current with release checks from GitHub.">
        <SettingRow
          settingId="automatic-updates"
          label="Check for updates automatically"
          description="Pane checks for a new release every 24 hours. Installation remains manual."
          saveState={persistence.saveStates['automatic-updates']}
        >
          <ImmediateToggle
            label="Check for updates automatically"
            value={config.autoCheckUpdates !== false}
            onSave={(value) => persistence.saveConfig('automatic-updates', { autoCheckUpdates: value })}
          />
        </SettingRow>
        <SettingRow
          settingId="check-updates-now"
          label={updateInfo?.hasUpdate ? 'Update available' : 'Check now'}
          description={updateResult ?? 'Request the latest release status now.'}
        >
          <Button
            type="button"
            variant={updateInfo?.hasUpdate ? 'primary' : 'secondary'}
            size="sm"
            icon={updateInfo?.hasUpdate
              ? <Download className="h-4 w-4" />
              : <RefreshCw className="h-4 w-4" />}
            loading={checking}
            loadingText="Checking"
            onClick={updateInfo?.hasUpdate ? () => onUpdate(updateInfo) : checkNow}
          >
            {updateInfo?.hasUpdate ? 'Update Pane' : updateInfo ? 'Check Again' : 'Check Now'}
          </Button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Feedback" description="Tell the Pane maintainers what is working and what is not.">
        <SettingRow
          settingId="send-feedback"
          label="Send feedback"
          description="Report a bug, request a feature, or share general feedback. Pane files a public GitHub issue in greenfield-inc/Pane with your GitHub CLI account."
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<MessageSquareText className="h-4 w-4" />}
            onClick={onSendFeedback}
          >
            Send Feedback
          </Button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Startup" description="Application-wide login behavior.">
        <SettingRow
          settingId="start-on-login"
          label="Start Pane when you log in"
          description="Ask the operating system to open Pane automatically after sign-in."
          saveState={persistence.saveStates['start-on-login']}
        >
          <ImmediateToggle
            label="Start Pane when you log in"
            value={config.autoStartOnBoot !== false}
            onSave={(value) => persistence.saveConfig('start-on-login', { autoStartOnBoot: value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Power" description="System sleep behavior while sessions are active.">
        <SettingRow
          settingId="keep-awake"
          label="Keep computer awake while sessions are active"
          description="Prevents the system from idle-sleeping while any session is active. The display can still turn off; closing the lid or choosing Sleep still sleeps the machine."
          saveState={persistence.saveStates['keep-awake']}
        >
          <ImmediateToggle
            label="Keep computer awake while sessions are active"
            value={config.keepAwakeWhileSessionsActive !== false}
            onSave={(value) => persistence.saveConfig('keep-awake', { keepAwakeWhileSessionsActive: value })}
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
