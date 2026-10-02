import { describe, expect, it } from 'vitest';
import { getRemoteExecutableHealthPresentation, getRemoteHostSwitcherModel, LOCAL_RUNTIME_ID } from './remoteRuntimePresentation';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemoteDaemonExecutableHealth,
  type RemoteDaemonHostRuntimeState,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';

function health(
  processStatus: RemoteDaemonExecutableHealth['processImage']['status'],
  restartStatus: RemoteDaemonExecutableHealth['restart']['status'],
): RemoteDaemonExecutableHealth {
  return {
    processImage: {
      status: processStatus,
      runtimePath: '/opt/Pane/Pane',
      installedPath: '/opt/Pane/pane',
      evidence: 'process evidence',
    },
    restart: {
      status: restartStatus,
      launcherPath: '/home/test/.pane_remote/remote-daemon/start.sh',
      evidence: 'launcher evidence',
    },
    checkedAt: new Date(0).toISOString(),
    recoveryCommand: 'runpane daemon repair --pane-dir ~/.pane_remote',
  };
}

describe('getRemoteExecutableHealthPresentation', () => {
  it('shows the fatal warning only for a deleted process with a broken launcher', () => {
    const presentation = getRemoteExecutableHealthPresentation({
      ...health('deleted', 'broken'),
      diagnosticCode: 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED',
    });
    expect(presentation?.code).toBe('PANE_REMOTE_DAEMON_EXECUTABLE_DELETED');
    expect(presentation?.message).toContain('will not return after reboot or service restart');
  });

  it('does not use the doomed wording without legacy-launcher evidence', () => {
    const presentation = getRemoteExecutableHealthPresentation({
      ...health('deleted', 'broken'),
      diagnosticCode: 'PANE_REMOTE_DAEMON_UPDATE_PENDING',
    });
    expect(presentation?.code).toBe('PANE_REMOTE_DAEMON_UPDATE_PENDING');
    expect(presentation?.message).not.toContain('will not return');
  });

  it('describes a deleted process with a ready launcher as update pending', () => {
    const presentation = getRemoteExecutableHealthPresentation(health('deleted', 'ready'));
    expect(presentation?.severity).toBe('warning');
    expect(presentation?.message).toContain('restart-ready');
  });

  it('does not warn for current or unknown health', () => {
    expect(getRemoteExecutableHealthPresentation(health('current', 'ready'))).toBeNull();
    expect(getRemoteExecutableHealthPresentation(health('unknown', 'unknown'))).toBeNull();
  });
});

describe('getRemoteHostSwitcherModel', () => {
  const profile: RemotePaneConnectionProfile = {
    id: 'mac',
    label: 'parsas mac pro',
    baseUrl: 'https://parsas-macbook-pro.example.ts.net',
    token: 'synthetic',
    transport: 'http+sse',
  };
  const local = createDefaultRemotePaneConnectionState();
  const idleHost = createDefaultRemoteDaemonHostRuntimeState();
  const connected: RemotePaneConnectionState = {
    ...local,
    mode: 'remote',
    status: 'connected',
    activeProfileId: 'mac',
    activeProfileLabel: 'parsas mac pro',
    activeBaseUrl: profile.baseUrl,
  };

  it('stays hidden on a local runtime with no saved hosts', () => {
    expect(getRemoteHostSwitcherModel(local, idleHost, []).visible).toBe(false);
  });

  it('offers this computer as the current host once a host is saved', () => {
    expect(getRemoteHostSwitcherModel(local, idleHost, [profile])).toMatchObject({
      visible: true,
      label: 'This computer',
      dotClassName: null,
      selectedId: LOCAL_RUNTIME_ID,
    });
  });

  it('names the connected host with a success dot', () => {
    expect(getRemoteHostSwitcherModel(connected, idleHost, [profile])).toMatchObject({
      visible: true,
      label: 'parsas mac pro',
      dotClassName: 'bg-status-success',
      selectedId: 'mac',
    });
  });

  it('shows while connected even before the saved profiles have loaded', () => {
    expect(getRemoteHostSwitcherModel(connected, idleHost, []).visible).toBe(true);
  });

  it('marks a reconnecting host with a warning dot and a failed one with an error dot', () => {
    expect(getRemoteHostSwitcherModel({ ...connected, status: 'reconnecting' }, idleHost, [profile]).dotClassName)
      .toContain('bg-status-warning');
    expect(getRemoteHostSwitcherModel({ ...connected, status: 'error' }, idleHost, [profile]).dotClassName)
      .toBe('bg-status-error');
  });

  it('summarizes hosting when this machine also serves remote clients', () => {
    const hosting: RemoteDaemonHostRuntimeState = {
      ...idleHost,
      enabled: true,
      status: 'live',
      connectedClients: [{
        id: 'phone', clientId: null, label: null, deviceLabel: 'iPhone', remoteAddress: null,
        connectedAt: new Date(0).toISOString(), lastSeenAt: new Date(0).toISOString(),
      }],
    };
    expect(getRemoteHostSwitcherModel(local, hosting, [profile]).hostingSummary).toBe('Hosting · 1 client connected');
    expect(getRemoteHostSwitcherModel(local, idleHost, [profile]).hostingSummary).toBeNull();
  });
});
