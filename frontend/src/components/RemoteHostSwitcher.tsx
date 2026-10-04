import { useState, type ReactElement } from 'react';
import { Laptop, Plug, Radio, SquareTerminal } from 'lucide-react';
import { Dropdown, DropdownMenuItem, type DropdownItem, type DropdownProps } from './ui/Dropdown';
import { API } from '../utils/api';
import { useConfigStore } from '../stores/configStore';
import { useErrorStore } from '../stores/errorStore';
import { LOCAL_RUNTIME_ID, type RemoteHostSwitcherModel } from '../utils/remoteRuntimePresentation';
import { getCloudHostSwitcherEntry } from '../utils/cloudSandboxPresentation';
import { HOST_ICONS, describeHost } from '../utils/hostKind';
import { getHostTerminalPresentation, openHostTerminal } from '../utils/hostTerminal';
import type { RemotePaneConnectionProfile, RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';
import type { CloudSandboxView } from '../../../shared/types/cloudSandboxes';

interface RemoteHostSwitcherProps {
  trigger: ReactElement;
  position: DropdownProps['position'];
  model: RemoteHostSwitcherModel;
  profiles: RemotePaneConnectionProfile[];
  connectionState: RemotePaneConnectionState;
  /** Cloud sandboxes behind saved hosts, so a stopped one offers Start instead of a dead connection. */
  cloudSandboxes: CloudSandboxView[];
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
  cloudSandboxes,
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

  // A stopped sandbox has no daemon to connect to: start it first, then switch to it.
  const startAndSwitchTo = async (sandbox: CloudSandboxView, profileId: string) => {
    if (switching) return;
    setSwitching(true);
    try {
      const response = await API.remoteDaemon.startCloudSandbox(sandbox.id);
      const started = response.data?.sandboxes.find((candidate) => candidate.id === sandbox.id);
      if (!response.success || started?.state !== 'running' || started.error) {
        // The sandbox row carries the failure; the switcher shows it next time it opens.
        console.error('Failed to start cloud sandbox:', response.error ?? started?.error);
        return;
      }
    } finally {
      setSwitching(false);
    }
    await switchTo(profileId);
  };

  const openTerminal = async (hostName: string) => {
    try {
      await openHostTerminal();
    } catch (error) {
      showError({
        title: `Could not open the terminal on ${hostName}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const items: DropdownItem[] = [
    ...profiles.map((profile) => {
      const sandbox = cloudSandboxes.find((candidate) => candidate.profileId === profile.id);
      const cloudEntry = getCloudHostSwitcherEntry(sandbox);
      const active = remote && profile.id === model.selectedId;
      const description = cloudEntry?.description ?? (active
        ? `${activeStatusText} · ${profile.baseUrl}`
        : profile.baseUrl);
      return {
        id: profile.id,
        label: profile.label,
        description,
        icon: HOST_ICONS[describeHost(profile).icon],
        disabled: switching || cloudEntry?.action === 'wait',
        onClick: () => {
          if (sandbox && cloudEntry?.action === 'start') void startAndSwitchTo(sandbox, profile.id);
          else void switchTo(profile.id);
        },
        // Only the active host's terminal can open: the window talks to one host at a time.
        // A sandbox that is not running has no shell to open.
        action: active && !cloudEntry ? {
          label: getHostTerminalPresentation(profile).openLabel,
          icon: SquareTerminal,
          onClick: () => void openTerminal(profile.label),
        } : undefined,
      };
    }),
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
