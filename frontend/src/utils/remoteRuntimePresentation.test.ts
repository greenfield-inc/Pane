import { describe, expect, it } from 'vitest';
import {
  getCloudSwitchFailure,
  getCloudWakeCommand,
  getCopyWakeCommandFailure,
  getRemoteExecutableHealthPresentation,
  getRemoteFooterStatus,
  getRemoteHostSwitcherModel,
  LOCAL_RUNTIME_ID,
} from './remoteRuntimePresentation';
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

describe('cloud host asleep hint', () => {
  const cloudProfile: RemotePaneConnectionProfile = {
    id: 'cloud-abc',
    label: 'Checkout',
    baseUrl: 'https://rp-abc12345.example.ts.net',
    token: 'synthetic',
    transport: 'http+sse',
    cloud: { provider: 'boat', sandboxId: 'bx_1', sessionId: 'abc12345xy', nodeId: 'n1', hostname: 'rp-abc12345', version: 1 },
  };
  const plainProfile: RemotePaneConnectionProfile = {
    id: 'mac', label: 'Mac', baseUrl: 'https://mac.example.ts.net', token: 'synthetic', transport: 'http+sse',
  };
  const idleHost = createDefaultRemoteDaemonHostRuntimeState();
  const failed = (profile: RemotePaneConnectionProfile): RemotePaneConnectionState => ({
    ...createDefaultRemotePaneConnectionState(),
    mode: 'remote',
    status: 'error',
    activeProfileId: profile.id,
    activeProfileLabel: profile.label,
    activeBaseUrl: profile.baseUrl,
    lastError: 'fetch failed',
  });

  it('names the wake command only for profiles runpane cloud created', () => {
    expect(getCloudWakeCommand(cloudProfile)).toBe('runpane cloud wake rp-abc12345');
    expect(getCloudWakeCommand(plainProfile)).toBeNull();
    expect(getCloudWakeCommand(undefined)).toBeNull();
  });

  it('tells the user to wake a cloud host whose connection failed', () => {
    const status = getRemoteFooterStatus(failed(cloudProfile), idleHost, [cloudProfile, plainProfile]);
    expect(status.title).toBe('Cloud host asleep or unreachable');
    expect(status.description).toContain('`runpane cloud wake rp-abc12345`');
    expect(getRemoteHostSwitcherModel(failed(cloudProfile), idleHost, [cloudProfile]).cloudWakeCommand)
      .toBe('runpane cloud wake rp-abc12345');
  });

  it('keeps the generic failure for other hosts and for a connected cloud host', () => {
    expect(getRemoteFooterStatus(failed(plainProfile), idleHost, [cloudProfile, plainProfile]).title).toBe('Remote connection failed');
    const connected = { ...failed(cloudProfile), status: 'connected' as const };
    expect(getRemoteFooterStatus(connected, idleHost, [cloudProfile]).title).toBe('Connected to Checkout');
    expect(getRemoteHostSwitcherModel(connected, idleHost, [cloudProfile]).cloudWakeCommand).toBeNull();
  });

  // A desktop reopened on a sleeping host retries 5 times (~90 s) before 'error'; seen live.
  it('names the wake command once the first attempt to reach a cloud host has failed', () => {
    const retrying = { ...failed(cloudProfile), status: 'reconnecting' as const };
    expect(getRemoteHostSwitcherModel(retrying, idleHost, [cloudProfile]).cloudWakeCommand).toBe('runpane cloud wake rp-abc12345');
    expect(getRemoteFooterStatus(retrying, idleHost, [cloudProfile]).title).toBe('Cloud host asleep or unreachable');

    const firstAttempt = { ...failed(cloudProfile), status: 'connecting' as const, lastError: null };
    expect(getRemoteHostSwitcherModel(firstAttempt, idleHost, [cloudProfile]).cloudWakeCommand).toBeNull();
    const retryingPlain = { ...failed(plainProfile), status: 'reconnecting' as const };
    expect(getRemoteHostSwitcherModel(retryingPlain, idleHost, [plainProfile]).cloudWakeCommand).toBeNull();
  });

  // Picking a sleeping host from the switcher fails after one attempt and Pane goes back to this
  // computer, so the connection state no longer names the host; seen live.
  it('explains a failed switch to a cloud host with the wake command', () => {
    expect(getCloudSwitchFailure(cloudProfile, 'Timed out waiting for remote daemon ready event after 10000ms')).toEqual({
      title: 'Cloud host asleep or unreachable',
      error: 'Checkout did not answer, so Pane stayed on this computer. A cloud Session that is asleep has to be woken first: run this, then pick Checkout again.',
      command: 'runpane cloud wake rp-abc12345',
      details: 'Timed out waiting for remote daemon ready event after 10000ms',
    });
    expect(getCloudSwitchFailure(plainProfile, 'fetch failed')).toBeNull();
    expect(getCloudSwitchFailure(undefined, 'fetch failed')).toBeNull();
  });

  it('shows the wake command to copy by hand when the clipboard refuses it', () => {
    expect(getCopyWakeCommandFailure('runpane cloud wake rp-abc12345', new Error('Clipboard access is unavailable'))).toEqual({
      title: 'Could not copy the wake command',
      error: 'The clipboard refused it. Run this command in a terminal to wake the cloud Session.',
      command: 'runpane cloud wake rp-abc12345',
      details: 'Clipboard access is unavailable',
    });
  });
});
