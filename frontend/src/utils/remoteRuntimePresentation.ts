import type {
  RemoteDaemonConnectedClient,
  RemoteDaemonExecutableHealth,
  RemoteDaemonHostRuntimeState,
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
  health: RemoteDaemonExecutableHealth | undefined,
): RemoteExecutableHealthPresentation | null {
  if (!health) return null;
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

export function getRemoteFooterStatus(
  connectionState: RemotePaneConnectionState,
  hostState: RemoteDaemonHostRuntimeState,
): RemoteFooterStatus {
  const lastSeenText = formatRemoteLastSeen(connectionState.lastSeenAt, 'inline');

  if (connectionState.mode === 'remote') {
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
        dotClassName: 'bg-interactive',
        title: `Connected to ${connectionState.activeProfileLabel ?? 'remote runtime'}`,
        description: connectionState.activeBaseUrl
          ? `Worktrees and terminals run on ${connectionState.activeBaseUrl}.${lastSeenText ? ` ${lastSeenText}.` : ''}`
          : `Worktrees and terminals run on the selected remote host.${lastSeenText ? ` ${lastSeenText}.` : ''}`,
        ariaLabel: 'Connected to remote runtime',
      };
    }

    return {
      dotClassName: 'bg-interactive animate-pulse',
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
