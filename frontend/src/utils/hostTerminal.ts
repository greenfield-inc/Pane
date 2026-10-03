import { API } from './api';
import { describeHost, type HostIcon } from './hostKind';
import { useHostTerminalStore } from '../stores/hostTerminalStore';
import { useNavigationStore } from '../stores/navigationStore';
import type { RemotePaneConnectionProfile, RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';

interface HostTerminalPresentation {
  hostName: string;
  icon: HostIcon;
  /** The terminal's name, e.g. "Terminal on devbox". */
  name: string;
  /** Main-area tab title, e.g. "devbox · Terminal". */
  tabTitle: string;
  /** Accessible name of every control that opens it. */
  openLabel: string;
}

/** How a host's terminal is labeled; `hostName` is the saved host's label. */
export function getHostTerminalPresentation(
  profile: Pick<RemotePaneConnectionProfile, 'label' | 'hostKind'> | null | undefined,
): HostTerminalPresentation {
  const host = describeHost(profile);
  return {
    hostName: host.name,
    icon: host.icon,
    name: `Terminal on ${host.name}`,
    tabTitle: `${host.name} · Terminal`,
    openLabel: `Open terminal on ${host.name}`,
  };
}

/** The saved profile of the remote host this window is using; null on this computer. */
export function getActiveRemoteProfile(
  connectionState: Pick<RemotePaneConnectionState, 'mode' | 'activeProfileId' | 'activeProfileLabel'>,
  profiles: RemotePaneConnectionProfile[],
): Pick<RemotePaneConnectionProfile, 'label' | 'hostKind'> | null {
  if (connectionState.mode !== 'remote') return null;
  return profiles.find((profile) => profile.id === connectionState.activeProfileId)
    ?? { label: connectionState.activeProfileLabel ?? 'Remote host' };
}

/**
 * Open the active host's terminal in the main area. `input` is typed at its
 * prompt without pressing Enter, so the user reviews it before running it.
 */
export async function openHostTerminal(options: { input?: string } = {}): Promise<void> {
  const response = await API.hostTerminal.open(options.input === undefined ? undefined : { input: options.input });
  if (!response.success || !response.data) {
    throw new Error(response.error ?? 'Could not open the host terminal');
  }
  useHostTerminalStore.getState().setTerminal(response.data);
  useNavigationStore.getState().navigateToHostTerminal();
}
