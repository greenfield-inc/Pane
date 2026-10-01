import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import {
  formatSetupRemoteHostResult as formatSetupRemoteHostResultImpl,
  setupRemoteHost as setupRemoteHostImpl,
} from './setupRemoteHost';
import {
  ensureTailscaleInstalledInteractive as ensureTailscaleInstalledInteractiveImpl,
  runTailscaleUpInteractive as runTailscaleUpInteractiveImpl,
} from './tailscaleSetup';
import { runRemoteSetupCli, type RemoteSetupCliDependencies } from './setupRemoteHostCli';
import { repairRemoteDaemonService as repairRemoteDaemonServiceImpl } from './remoteDaemonService';

const formatSetupRemoteHostResult = vi.fn<typeof formatSetupRemoteHostResultImpl>()
  .mockReturnValue('formatted remote setup result');
const setupRemoteHost = vi.fn<typeof setupRemoteHostImpl>();
const repairRemoteDaemonService = vi.fn<typeof repairRemoteDaemonServiceImpl>();
const ensureTailscaleInstalledInteractive = vi.fn<typeof ensureTailscaleInstalledInteractiveImpl>();
const runTailscaleUpInteractive = vi.fn<typeof runTailscaleUpInteractiveImpl>();
const dependencies: RemoteSetupCliDependencies = {
  ensureTailscaleInstalledInteractive,
  formatSetupRemoteHostResult,
  repairRemoteDaemonService,
  runTailscaleUpInteractive,
  setupRemoteHost,
};

describe('runRemoteSetupCli', () => {
  afterEach(() => {
    vi.mocked(formatSetupRemoteHostResult).mockClear();
    vi.mocked(setupRemoteHost).mockReset();
    vi.mocked(ensureTailscaleInstalledInteractive).mockReset();
    vi.mocked(runTailscaleUpInteractive).mockReset();
    vi.mocked(repairRemoteDaemonService).mockReset();
  });

  it('installs and authenticates Tailscale before running remote setup in interactive mode', async () => {
    const tailscaleCommand = {
      command: 'tailscale',
      displayCommand: 'tailscale',
    };
    vi.mocked(ensureTailscaleInstalledInteractive).mockReturnValue(tailscaleCommand);
    vi.mocked(setupRemoteHost).mockResolvedValue({
      paneDir: '/tmp/pane',
      configPath: '/tmp/pane/config.json',
      label: 'Windows WSL Smoke',
      listenPort: 42139,
      channel: 'stable',
      connectionCode: 'pane-remote://encoded',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42139',
        note: 'Available through Tailscale Serve.',
      },
      fallbackTunnelCommands: [],
      service: {
        strategy: 'manual',
        installed: false,
        started: false,
        message: 'Service installation disabled',
      },
      manualDaemonCommand: 'pane --daemon-headless',
      wroteConfig: true,
    });

    const exitCode = await runRemoteSetupCli([
      '--interactive-tailscale-setup',
      '--pane-dir',
      '/tmp/pane',
      '--label',
      'Windows WSL Smoke',
      '--listen-port',
      '42139',
      '--prefer-tunnel',
      'tailscale',
      '--no-install-service',
    ], dependencies);

    expect(exitCode).toBe(0);
    expect(ensureTailscaleInstalledInteractive).toHaveBeenCalledOnce();
    expect(runTailscaleUpInteractive).toHaveBeenCalledWith(tailscaleCommand);
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({
      paneDir: '/tmp/pane',
      label: 'Windows WSL Smoke',
      listenPort: 42139,
      preferTunnel: 'tailscale',
      installService: false,
      interactiveTailscaleSetup: true,
    }));
    expect(formatSetupRemoteHostResult).toHaveBeenCalledOnce();
  });

  it('passes --client-scope coordinator through and refuses any other scope', async () => {
    vi.mocked(setupRemoteHost).mockRejectedValue(new Error('stop after parsing'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runRemoteSetupCli(['--client-scope', 'coordinator', '--no-install-service'], dependencies);
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({ clientScope: 'coordinator' }));

    vi.mocked(setupRemoteHost).mockClear();
    expect(await runRemoteSetupCli(['--client-scope', 'admin'], dependencies)).toBe(1);
    expect(setupRemoteHost).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith('--client-scope must be "coordinator"');
    errors.mockRestore();
  });

  it('repairs only service assets when routed through remote setup', async () => {
    vi.mocked(repairRemoteDaemonService).mockResolvedValue({
      ok: true,
      changed: true,
      paneDir: '/tmp/pane-remote',
      strategy: 'systemd-user',
      launcherPath: '/tmp/pane-remote/remote-daemon/start.sh',
      before: {
        launcherPath: '/tmp/pane-remote/remote-daemon/start.sh',
        launcherExists: true,
        launcherCurrent: false,
        savedExecutablePath: '/opt/Pane/Pane',
        savedExecutableExists: false,
        resolvedExecutablePath: '/opt/Pane/pane',
        restartStatus: 'ready',
      },
      after: {
        launcherPath: '/tmp/pane-remote/remote-daemon/start.sh',
        launcherExists: true,
        launcherCurrent: true,
        savedExecutablePath: null,
        savedExecutableExists: null,
        resolvedExecutablePath: '/opt/Pane/pane',
        restartStatus: 'ready',
      },
      message: 'Repaired and restarted the user systemd service.',
    });

    const exitCode = await runRemoteSetupCli([
      '--remote-setup',
      '--remote-repair-service',
      '--pane-dir',
      '/tmp/pane-remote',
      '--json',
    ], dependencies);

    expect(exitCode).toBe(0);
    expect(repairRemoteDaemonService).toHaveBeenCalledWith(path.resolve('/tmp/pane-remote'));
    expect(setupRemoteHost).not.toHaveBeenCalled();
    expect(ensureTailscaleInstalledInteractive).not.toHaveBeenCalled();
  });
});
