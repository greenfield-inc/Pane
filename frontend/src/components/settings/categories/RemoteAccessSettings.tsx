import { ExternalLink, Server } from 'lucide-react';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { SettingRow, SettingsPage } from '../SettingRow';
import type { RemoteAccessSubviewId } from '../../../types/settings';
import type { RemoteAccessController } from '../useRemoteAccessSettings';

interface RemoteAccessSettingsProps {
  controller: RemoteAccessController;
  onOpenSubview: (subview: RemoteAccessSubviewId) => void;
}

export function RemoteAccessSettings({ controller, onOpenSubview }: RemoteAccessSettingsProps) {
  const remoteStatus = controller.connectionState.status === 'connected'
    ? `Connected to ${controller.connectionState.activeProfileLabel ?? 'remote Pane'}`
    : controller.connectionState.mode === 'remote'
      ? `Remote mode: ${controller.connectionState.status}`
      : 'Using local runtime';

  return (
    <SettingsPage title="Remote Access" description="Connect Pane to another machine.">
      {controller.loading && (
        <p className="text-sm text-text-tertiary" aria-live="polite">Loading Remote Pane status...</p>
      )}
      {controller.error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-status-error" role="alert">
          <span>{controller.error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => void controller.reload()}>Retry</Button>
        </div>
      )}
      <SettingsSection title="Remote Pane">
        <SettingRow
          settingId="remote-pane"
          label={remoteStatus}
          description={controller.connectionState.activeBaseUrl ?? 'Worktrees, terminals, and agent commands can run on a remote host.'}
          align="start"
        >
          <div className="flex max-w-md flex-wrap justify-end gap-2">
            <Button type="button" size="sm" icon={<Server className="h-4 w-4" />} onClick={() => onOpenSubview('host-setup')}>
              Set Up Host
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => onOpenSubview('connections')}>
              Connections
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenSubview('advanced-host')}>
              Advanced
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<ExternalLink className="h-4 w-4" />}
              onClick={() => window.electronAPI.openExternal('https://runpane.com/docs/remote-daemon')}
            >
              Docs
            </Button>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
