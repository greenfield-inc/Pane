import type {
  RemoteDaemonConnectedClient,
  RemoteDaemonExecutableHealth,
  RemoteDaemonHostRuntimeState,
  RemotePaneConnectionProfile,
  RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';

interface RemoteHostRuntimePresentation {
  dotClassName: string;
  borderClassName: string;
  title: string;
  description: string;
}

export interface RemoteExecutableHealthPresentation {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  recoveryCommand?: string;
}

export function getRemoteExecutableHealthPresentation(
  health: RemoteDaemonExecutableHealth,
): RemoteExecutableHealthPresentation | null {
  if (
    health.diagnosticCode === 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED'
    && health.processImage.status === 'deleted'
    && health.restart.status === 'broken'
  ) {
    const runtimePath = health.processImage.runtimePath ?? 'the previous Pane executable';
    const installedPath = health.processImage.installedPath ?? 'the current Pane executable';
    return {
      severity: 'error',
      code: 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED',
      message: `Remote daemon is reachable but unsafe to restart. It is running ${runtimePath} from a deleted inode; Pane is now installed at ${installedPath}, and the saved launcher cannot resolve an executable. The daemon will not return after reboot or service restart.`,
      recoveryCommand: health.recoveryCommand,
    };
  }
  if (health.restart.status === 'broken') {
    return {
      severity: 'error',
      code: health.diagnosticCode ?? 'PANE_REMOTE_DAEMON_LAUNCHER_STALE',
      message: health.restart.evidence,
      recoveryCommand: health.recoveryCommand,
    };
  }
  if (health.processImage.status === 'replaced' || health.processImage.status === 'deleted') {
    return {
      severity: 'warning',
      code: health.diagnosticCode ?? 'PANE_REMOTE_DAEMON_UPDATE_PENDING',
      message: 'Pane was updated while this remote daemon was running. Its launcher is restart-ready, but restart it when convenient to run the installed version.',
      recoveryCommand: health.recoveryCommand,
    };
  }
  return null;
}

export interface RemoteFooterStatus {
  dotClassName: string;
  title: string;
  description: string;
  ariaLabel: string;
}

function formatRemoteLastSeen(lastSeenAt: string | null, style: 'sentence' | 'inline' = 'sentence'): string | null {
  if (!lastSeenAt) {
    return null;
  }

  const seenAtMs = Date.parse(lastSeenAt);
  if (Number.isNaN(seenAtMs)) {
    return null;
  }

  const prefix = style === 'sentence' ? 'Last seen' : 'last seen';
  const suffix = style === 'sentence' ? '.' : '';
  const ageSeconds = Math.max(0, Math.floor((Date.now() - seenAtMs) / 1000));
  if (ageSeconds < 10) {
    return `${prefix} just now${suffix}`;
  }
  if (ageSeconds < 60) {
    return `${prefix} ${ageSeconds}s ago${suffix}`;
  }

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${prefix} ${ageMinutes}m ago${suffix}`;
  }

  return `${prefix} ${new Date(seenAtMs).toLocaleString()}${suffix}`;
}

function getRemoteClientDisplayLabel(client: RemoteDaemonConnectedClient): string | null {
  return client.deviceLabel ?? client.remoteAddress;
}

function formatRemoteHostClients(state: RemoteDaemonHostRuntimeState): string {
  if (state.connectedClients.length === 0) {
    return 'No remote clients are connected.';
  }

  const displayLabels = state.connectedClients
    .map(getRemoteClientDisplayLabel)
    .filter((label): label is string => Boolean(label))
    .slice(0, 3);
  const clientNoun = state.connectedClients.length === 1 ? 'client is' : 'clients are';
  if (displayLabels.length === 0) {
    return `${state.connectedClients.length} remote ${clientNoun} connected.`;
  }

  const labels = displayLabels.join(', ');
  const remaining = state.connectedClients.length - displayLabels.length;
  return `${state.connectedClients.length} remote ${clientNoun} connected: ${labels}${remaining > 0 ? `, +${remaining} more` : ''}.`;
}

function getRemoteHostRuntimePresentation(
  state: RemoteDaemonHostRuntimeState,
  surface: 'settings' | 'sidebar' = 'settings',
): RemoteHostRuntimePresentation {
  if (state.status === 'live') {
    const verb = surface === 'settings' ? 'accepting' : 'serving';
    const currentDataNote = surface === 'settings' ? ' Keep Pane open for Current Pane Data connections.' : '';
    return {
      dotClassName: 'bg-status-success',
      borderClassName: 'bg-status-success/10 border-status-success/30',
      title: 'Remote host live',
      description: state.listenHost && state.listenPort
        ? `This Pane app is ${verb} remote connections on ${state.listenHost}:${state.listenPort}. ${formatRemoteHostClients(state)}${currentDataNote}`
        : `This Pane app is ${verb} remote connections. ${formatRemoteHostClients(state)}${currentDataNote}`,
    };
  }

  if (state.status === 'error') {
    return {
      dotClassName: 'bg-status-error',
      borderClassName: 'bg-status-error/10 border-status-error/30',
      title: 'Remote host offline',
      description: state.lastError ?? 'Pane could not start the remote listener on this machine.',
    };
  }

  const inactiveTitle = surface === 'settings'
    ? (state.enabled ? 'Remote host configured, not live' : 'Remote host inactive')
    : 'Remote inactive';

  return {
    dotClassName: 'bg-text-tertiary',
    borderClassName: 'bg-surface-secondary border-border-secondary',
    title: inactiveTitle,
    description: surface === 'settings'
      ? 'Run setup or reopen Pane on this machine to make existing remote profiles connect.'
      : 'Remote hosting is not active on this Pane app.',
  };
}

/**
 * The command that wakes a saved cloud host (a profile `runpane cloud` wrote). A
 * sleeping cloud Session's tailnet node is offline, so connecting fails like any unreachable host;
 * the desktop only names the CLI command and never wakes or manages the machine itself (#695).
 */
export function getCloudWakeCommand(profile: RemotePaneConnectionProfile | undefined): string | null {
  return profile?.cloud ? `runpane cloud wake ${profile.cloud.hostname}` : null;
}

/**
 * The wake command once connecting to the active cloud host has failed. That includes retrying
 * after a failed attempt: a desktop reopened on a sleeping host retries for about 90 s before it
 * reports 'error'.
 */
function getFailedCloudWakeCommand(
  connectionState: RemotePaneConnectionState,
  profiles: RemotePaneConnectionProfile[],
): string | null {
  if (connectionState.mode !== 'remote') return null;
  const failed = connectionState.status === 'error'
    || (connectionState.status === 'reconnecting' && Boolean(connectionState.lastError));
  if (!failed) return null;
  return getCloudWakeCommand(profiles.find((profile) => profile.id === connectionState.activeProfileId));
}

export interface CloudSwitchFailure {
  title: string;
  error: string;
  command: string;
  details: string;
}

/**
 * What to tell the user when picking a cloud host fails. Pane goes back to this computer after one
 * failed attempt, so the connection state no longer names the host; this explains it and names the
 * wake command. Display only: the desktop never wakes the machine itself (#695).
 */
export function getCloudSwitchFailure(
  profile: RemotePaneConnectionProfile | undefined,
  errorMessage: string,
): CloudSwitchFailure | null {
  const command = getCloudWakeCommand(profile);
  if (!profile || !command) return null;
  return {
    title: 'Cloud host asleep or unreachable',
    error: `${profile.label} did not answer, so Pane stayed on this computer. A cloud Session that is asleep has to be woken first: run this, then pick ${profile.label} again.`,
    command,
    details: errorMessage,
  };
}

export function getRemoteFooterStatus(
  connectionState: RemotePaneConnectionState,
  hostState: RemoteDaemonHostRuntimeState,
  profiles: RemotePaneConnectionProfile[] = [],
): RemoteFooterStatus {
  const lastSeenText = formatRemoteLastSeen(connectionState.lastSeenAt, 'inline');

  if (connectionState.mode === 'remote') {
    const wakeCommand = getFailedCloudWakeCommand(connectionState, profiles);
    if (wakeCommand) {
      return {
        dotClassName: 'bg-status-error',
        title: 'Cloud host asleep or unreachable',
        description: [
          `${connectionState.activeProfileLabel ?? 'This cloud host'} may be asleep. Run \`${wakeCommand}\`, then pick it again.`,
          lastSeenText ? `Remote was ${lastSeenText}.` : null,
        ].filter(Boolean).join(' '),
        ariaLabel: 'Cloud host asleep or unreachable',
      };
    }
    if (connectionState.status === 'error') {
      return {
        dotClassName: 'bg-status-error',
        title: 'Remote connection failed',
        description: [
          connectionState.lastError ?? 'Pane could not connect to the selected remote profile.',
          lastSeenText ? `Remote was ${lastSeenText}.` : null,
        ].filter(Boolean).join(' '),
        ariaLabel: 'Remote connection failed',
      };
    }

    if (connectionState.status === 'connected') {
      return {
        dotClassName: getRemoteConnectionDotClassName(connectionState),
        title: `Connected to ${connectionState.activeProfileLabel ?? 'remote runtime'}`,
        description: connectionState.activeBaseUrl
          ? `Worktrees and terminals run on ${connectionState.activeBaseUrl}.${lastSeenText ? ` ${lastSeenText}.` : ''}`
          : `Worktrees and terminals run on the selected remote host.${lastSeenText ? ` ${lastSeenText}.` : ''}`,
        ariaLabel: 'Connected to remote runtime',
      };
    }

    return {
      dotClassName: getRemoteConnectionDotClassName(connectionState),
      title: 'Connecting to remote runtime',
      description: [
        connectionState.activeBaseUrl ?? 'Pane is trying to connect to the selected remote profile.',
        lastSeenText ? `Remote was ${lastSeenText}.` : null,
      ].filter(Boolean).join(' '),
      ariaLabel: 'Connecting to remote runtime',
    };
  }

  if (hostState.status === 'live' || hostState.status === 'error') {
    const hostPresentation = getRemoteHostRuntimePresentation(hostState, 'sidebar');
    return {
      dotClassName: hostPresentation.dotClassName,
      title: hostPresentation.title,
      description: hostPresentation.description,
      ariaLabel: hostPresentation.title,
    };
  }

  return {
    dotClassName: 'bg-text-tertiary',
    title: 'Remote inactive',
    description: 'Remote hosting is not active on this Pane app.',
    ariaLabel: 'Remote inactive',
  };
}

/** Dropdown id for "This computer": the local runtime, next to saved host profile ids. */
export const LOCAL_RUNTIME_ID = 'local';

export interface RemoteHostSwitcherModel {
  /** Shown while connected, or whenever a host is saved to switch to. */
  visible: boolean;
  label: string;
  /** Status dot for a remote host; null means the local runtime. */
  dotClassName: string | null;
  selectedId: string;
  /** Set when this machine is also hosting, so the switcher can link to it. */
  hostingSummary: string | null;
  /** Set when the selected cloud host failed to connect: the CLI command that wakes it. */
  cloudWakeCommand: string | null;
}

function getRemoteConnectionDotClassName(state: RemotePaneConnectionState): string {
  if (state.status === 'connected') return 'bg-status-success';
  if (state.status === 'error') return 'bg-status-error';
  return 'bg-status-warning animate-pulse';
}

export function getRemoteHostSwitcherModel(
  connectionState: RemotePaneConnectionState,
  hostState: RemoteDaemonHostRuntimeState,
  profiles: RemotePaneConnectionProfile[],
): RemoteHostSwitcherModel {
  const remote = connectionState.mode === 'remote';
  const clientCount = hostState.connectedClients.length;
  const hostingSummary = hostState.status === 'live'
    ? `Hosting · ${clientCount} ${clientCount === 1 ? 'client' : 'clients'} connected`
    : hostState.status === 'error' ? 'Hosting offline' : null;

  return {
    visible: remote || profiles.length > 0,
    label: remote ? connectionState.activeProfileLabel ?? 'Remote host' : 'This computer',
    dotClassName: remote ? getRemoteConnectionDotClassName(connectionState) : null,
    selectedId: remote ? connectionState.activeProfileId ?? LOCAL_RUNTIME_ID : LOCAL_RUNTIME_ID,
    hostingSummary,
    cloudWakeCommand: getFailedCloudWakeCommand(connectionState, profiles),
  };
}
