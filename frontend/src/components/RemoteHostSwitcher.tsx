import { useState, type ReactElement } from 'react';
import { Copy, Laptop, Plug, Radio, Server } from 'lucide-react';
import { Dropdown, DropdownMenuItem, type DropdownItem, type DropdownProps } from './ui/Dropdown';
import { API } from '../utils/api';
import { useConfigStore } from '../stores/configStore';
import { useErrorStore } from '../stores/errorStore';
import { getCloudSwitchFailure, getCopyWakeCommandFailure, LOCAL_RUNTIME_ID, type RemoteHostSwitcherModel } from '../utils/remoteRuntimePresentation';
import { copyTerminalText } from '../utils/terminalClipboard';
import type { RemotePaneConnectionProfile, RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';

interface RemoteHostSwitcherProps {
  trigger: ReactElement;
  position: DropdownProps['position'];
  model: RemoteHostSwitcherModel;
  profiles: RemotePaneConnectionProfile[];
  connectionState: RemotePaneConnectionState;
  onManageConnections: () => void;
  onOpenHosting: () => void;
}

/** Picks which machine runs agents: a saved remote host or this computer. */
export function RemoteHostSwitcher({
  trigger,
  position,
  model,
  profiles,
  connectionState,
  onManageConnections,
  onOpenHosting,
}: RemoteHostSwitcherProps) {
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const showError = useErrorStore((state) => state.showError);
  // Main does not serialize client transitions, so one switch at a time.
  const [switching, setSwitching] = useState(false);
  const remote = connectionState.mode === 'remote';
  const activeStatusText = connectionState.status === 'connected'
    ? 'Connected'
    : connectionState.status === 'error' ? 'Connection failed' : 'Connecting';

  const switchTo = async (profileId: string) => {
    // Picking the current host again retries it after a failed connection.
    if (switching || (profileId === model.selectedId && connectionState.status !== 'error')) return;
    const updates = profileId === LOCAL_RUNTIME_ID
      ? { activeProfileId: null, mode: 'local' as const }
      : { activeProfileId: profileId, mode: 'remote' as const };
    // A failed switch still lands in the pushed connection state, which the
    // trigger's dot reports; the log keeps the reason. A cloud host that fails
    // leaves Pane on this computer, so the error dialog names its wake command.
    setSwitching(true);
    try {
      const response = await API.remoteDaemon.updateClientState(updates);
      if (!response.success) {
        console.error('Failed to switch remote host:', response.error);
        const cloudFailure = getCloudSwitchFailure(
          profiles.find((profile) => profile.id === profileId),
          response.error ?? 'The host did not answer.',
        );
        if (cloudFailure) showError(cloudFailure);
      }
      await fetchConfig().catch(() => undefined);
    } finally {
      setSwitching(false);
    }
  };

  const items: DropdownItem[] = [
    ...profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      description: remote && profile.id === model.selectedId
        ? (model.cloudWakeCommand ? `Asleep? Run ${model.cloudWakeCommand}` : `${activeStatusText} · ${profile.baseUrl}`)
        : profile.baseUrl,
      icon: Server,
      disabled: switching,
      onClick: () => void switchTo(profile.id),
    })),
    {
      id: LOCAL_RUNTIME_ID,
      label: 'This computer',
      description: remote ? 'Disconnect and use the local runtime' : 'Using the local runtime',
      icon: Laptop,
      disabled: switching,
      onClick: () => void switchTo(LOCAL_RUNTIME_ID),
    },
  ];

  return (
    <Dropdown
      trigger={trigger}
      items={items}
      selectedId={model.selectedId}
      position={position}
      width="lg"
      footer={({ close }) => (
        <>
          {model.cloudWakeCommand && (
            <DropdownMenuItem
              icon={Copy}
              label="Copy wake command"
              onClick={() => {
                close();
                const command = model.cloudWakeCommand ?? '';
                void copyTerminalText(command).catch((cause: unknown) => showError(getCopyWakeCommandFailure(command, cause)));
              }}
            />
          )}
          {model.hostingSummary && (
            <DropdownMenuItem icon={Radio} label={model.hostingSummary} onClick={() => { close(); onOpenHosting(); }} />
          )}
          <DropdownMenuItem icon={Plug} label="Manage connections…" onClick={() => { close(); onManageConnections(); }} />
        </>
      )}
    />
  );
}
