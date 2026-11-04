import { describe, expect, it } from 'vitest';
import { getRemoteExecutableHealthPresentation } from './remoteRuntimePresentation';
import type { RemoteDaemonExecutableHealth } from '../../../shared/types/remoteDaemon';

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
