import { useState, type ReactElement } from 'react';
import { Laptop, Plug, Radio, Server } from 'lucide-react';
import { Dropdown, DropdownMenuItem, type DropdownItem, type DropdownProps } from './ui/Dropdown';
import { API } from '../utils/api';
import { useConfigStore } from '../stores/configStore';
import { LOCAL_RUNTIME_ID, type RemoteHostSwitcherModel } from '../utils/remoteRuntimePresentation';
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
    // trigger's dot reports; the log keeps the reason.
    setSwitching(true);
    try {
      const response = await API.remoteDaemon.updateClientState(updates);
      if (!response.success) console.error('Failed to switch remote host:', response.error);
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
        ? `${activeStatusText} · ${profile.baseUrl}`
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
          {model.hostingSummary && (
            <DropdownMenuItem icon={Radio} label={model.hostingSummary} onClick={() => { close(); onOpenHosting(); }} />
          )}
          <DropdownMenuItem icon={Plug} label="Manage connections…" onClick={() => { close(); onManageConnections(); }} />
        </>
      )}
    />
  );
}
