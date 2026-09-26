import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultRemoteDaemonConfig,
  decodePaneRemoteConnection,
  encodePaneRemoteConnection,
  type RemoteDaemonConfig,
  type RemoteHostSetupResult,
} from '../../../shared/types/remoteDaemon';
import { authenticateRemoteDaemonBearerToken } from '../daemon/auth';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { remoteHostRuntimeStateStore } from '../daemon/remoteHostRuntimeState';
import { disconnectActiveRemoteHostClients as disconnectActiveRemoteHostClientsImpl } from '../daemon/remoteTransportController';
import {
  readConfiguredTailscaleServeAccess as readConfiguredTailscaleServeAccessImpl,
  setupRemoteHost as setupRemoteHostImpl,
} from '../daemon/setupRemoteHost';
import { registerRemoteDaemonHandlers as registerRemoteDaemonHandlersImpl } from './remoteDaemon';
import type { PaneCommandValue } from '../daemon/commandRegistry';

const readConfiguredTailscaleServeAccess = vi.fn<typeof readConfiguredTailscaleServeAccessImpl>();
const setupRemoteHost = vi.fn<typeof setupRemoteHostImpl>();
const disconnectActiveRemoteHostClients = vi.fn<typeof disconnectActiveRemoteHostClientsImpl>()
  .mockReturnValue(0);

function registerTestRemoteDaemonHandlers(
  ipcMain: Parameters<typeof registerRemoteDaemonHandlersImpl>[0],
  services: Omit<Parameters<typeof registerRemoteDaemonHandlersImpl>[1], 'dependencies'>,
): void {
  registerRemoteDaemonHandlersImpl(ipcMain, {
    ...services,
    dependencies: {
      disconnectActiveRemoteHostClients,
      readConfiguredTailscaleServeAccess,
      setupRemoteHost,
    },
  });
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

interface IpcMainStub {
  handlers: Map<string, (_event: { readonly sender: object }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>;
  handle(channel: string, listener: (_event: { readonly sender: object }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>): void;
}

interface ConfigManagerStub {
  getConfig(): { remoteDaemon?: RemoteDaemonConfig };
  updateConfig(updates: { remoteDaemon?: RemoteDaemonConfig }): Promise<{ remoteDaemon?: RemoteDaemonConfig }>;
}

function createIpcMainStub(): IpcMainStub {
  const handlers = new Map<string, (_event: { readonly sender: object }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>();

  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

function createConfigManagerStub(initialConfig?: RemoteDaemonConfig): ConfigManagerStub {
  let remoteDaemon = initialConfig;

  return {
    getConfig() {
      return { remoteDaemon };
    },
    async updateConfig(updates) {
      remoteDaemon = updates.remoteDaemon;
      return { remoteDaemon };
    },
  };
}

function createClientDroppingConfigManagerStub(initialConfig: RemoteDaemonConfig): ConfigManagerStub {
  let remoteDaemon: RemoteDaemonConfig | undefined = initialConfig;

  return {
    getConfig() {
      return { remoteDaemon };
    },
    async updateConfig(updates) {
      remoteDaemon = updates.remoteDaemon
        ? {
            ...updates.remoteDaemon,
            host: {
              ...updates.remoteDaemon.host,
              clients: [],
            },
          }
        : undefined;
      return { remoteDaemon };
    },
  };
}

function expectConnectionCodeAuthenticates(configManager: ConfigManagerStub, connectionCode: string | undefined): void {
  const payload = decodePaneRemoteConnection(connectionCode ?? '');
  const clients = configManager.getConfig().remoteDaemon?.host.clients ?? [];

  expect(authenticateRemoteDaemonBearerToken(`Bearer ${payload.token}`, clients)).toMatchObject({
    ok: true,
  });
}

function expectConnectionCodeForbidden(configManager: ConfigManagerStub, connectionCode: string | undefined): void {
  const payload = decodePaneRemoteConnection(connectionCode ?? '');
  const clients = configManager.getConfig().remoteDaemon?.host.clients ?? [];

  expect(authenticateRemoteDaemonBearerToken(`Bearer ${payload.token}`, clients)).toMatchObject({
    ok: false,
    statusCode: 403,
  });
}

describe('remote daemon IPC', () => {
  afterEach(() => {
    vi.mocked(setupRemoteHost).mockReset();
    vi.mocked(readConfiguredTailscaleServeAccess).mockReset();
    vi.mocked(disconnectActiveRemoteHostClients).mockReset();
    vi.mocked(disconnectActiveRemoteHostClients).mockReturnValue(0);
    vi.restoreAllMocks();
    remoteHostRuntimeStateStore.resetForTests();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  function createSetupResult(overrides: Partial<RemoteHostSetupResult> = {}): Omit<RemoteHostSetupResult, 'dataDirectoryMode'> {
    return {
      paneDir: '/tmp/pane',
      configPath: '/tmp/pane/config.json',
      label: 'Office Mac mini',
      listenPort: 42137,
      channel: 'stable',
      connectionCode: 'pane-remote://encoded',
      tunnel: {
        kind: 'manual',
        selected: true,
        note: 'Use your tunnel before connecting.',
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
      ...overrides,
    };
  }

  it('returns normalized remote daemon defaults when config is missing', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:get-config')?.({})).resolves.toEqual({
      success: true,
      data: createDefaultRemoteDaemonConfig(),
    });
  });

  it('persists connection profiles and client state through dedicated handlers', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const send = vi.fn();

    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    });

    const upsertProfile = ipcMain.handlers.get('remote-daemon:upsert-connection-profile');
    const updateClientState = ipcMain.handlers.get('remote-daemon:update-client-state');
    const getConfig = ipcMain.handlers.get('remote-daemon:get-config');
    vi.spyOn(remotePaneClientController, 'activateProfile').mockResolvedValue({
      mode: 'remote',
      status: 'connected',
      activeProfileId: 'profile-1',
      activeProfileLabel: 'Mac mini',
      activeBaseUrl: 'http://127.0.0.1:42137',
      lastError: null,
    });

    await expect(upsertProfile?.({}, {
      id: 'profile-1',
      label: 'Mac mini',
      baseUrl: 'http://127.0.0.1:42137',
      token: 'secret-token',
      transport: 'http+sse',
    })).resolves.toEqual({
      success: true,
      data: [{
        id: 'profile-1',
        label: 'Mac mini',
        baseUrl: 'http://127.0.0.1:42137',
        token: 'secret-token',
        transport: 'http+sse',
      }],
    });

    await expect(updateClientState?.({}, {
      activeProfileId: 'profile-1',
      mode: 'remote',
    })).resolves.toEqual({
      success: true,
      data: {
        profiles: [{
          id: 'profile-1',
          label: 'Mac mini',
          baseUrl: 'http://127.0.0.1:42137',
          token: 'secret-token',
          transport: 'http+sse',
        }],
        activeProfileId: 'profile-1',
        mode: 'remote',
      },
    });
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required');

    await expect(getConfig?.({})).resolves.toEqual({
      success: true,
      data: {
        host: {
          config: createDefaultRemoteDaemonConfig().host.config,
          clients: [],
          mobilePush: { registrations: [], attentionSequence: 0, panelStates: {} },
        },
        client: {
          profiles: [{
            id: 'profile-1',
            label: 'Mac mini',
            baseUrl: 'http://127.0.0.1:42137',
            token: 'secret-token',
            transport: 'http+sse',
          }],
          activeProfileId: 'profile-1',
          mode: 'remote',
        },
      },
    });
  });

  it('returns the current remote daemon connection state', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.spyOn(remotePaneClientController, 'getConnectionState').mockReturnValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:get-connection-state')?.({})).resolves.toEqual({
      success: true,
      data: {
        mode: 'local',
        status: 'local',
        activeProfileId: null,
        activeProfileLabel: null,
        activeBaseUrl: null,
        lastError: null,
      },
    });
  });

  it('returns the current remote daemon host runtime state', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const hostConfig = {
      ...createDefaultRemoteDaemonConfig().host.config,
      enabled: true,
      listenPort: 42138,
    };
    remoteHostRuntimeStateStore.setLive(hostConfig, {
      host: '127.0.0.1',
      port: 42138,
    });

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:get-host-state')?.({})).resolves.toMatchObject({
      success: true,
      data: {
        enabled: true,
        status: 'live',
        listenHost: '127.0.0.1',
        listenPort: 42138,
        lastError: null,
      },
    });
  });

  it('sets up a remote host with the current Pane data directory by default', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.mocked(setupRemoteHost).mockImplementation(async (options) => {
      await options.writeConfig?.({
        remoteDaemon: createDefaultRemoteDaemonConfig(),
      });
      return createSetupResult({
        paneDir: options.paneDir ?? '/tmp/pane',
        label: options.label ?? 'Office Mac mini',
        listenPort: options.listenPort ?? 42137,
      });
    });

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const setupHost = ipcMain.handlers.get('remote-daemon:setup-host');
    const response = await setupHost?.({}, {
      label: 'Office Mac mini',
      listenPort: 42137,
      preferTunnel: 'ssh',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        dataDirectoryMode: 'current',
        label: 'Office Mac mini',
        listenPort: 42137,
        connectionCode: 'pane-remote://encoded',
      },
    });
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Office Mac mini',
      listenPort: 42137,
      preferTunnel: 'ssh',
      autoSelectListenPort: true,
      installService: false,
      existingConfig: expect.any(Object),
      writeConfig: expect.any(Function),
    }));
    expect(configManager.getConfig().remoteDaemon).toEqual(createDefaultRemoteDaemonConfig());
  });

  it('builds an interactive Tailscale setup command for the current Pane data directory', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager, app: { isPackaged: false } });

    const getCommand = ipcMain.handlers.get('remote-daemon:get-interactive-setup-command');
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const response = await getCommand?.({}, {
      label: 'Windows WSL Smoke',
      listenPort: 42139,
      preferTunnel: 'tailscale',
    }) as { success?: boolean; data?: { command?: string } };

    expect(response).toMatchObject({
      success: true,
      data: {
        command: expect.stringContaining('pane-remote-setup.js'),
      },
    });
    expect(response.data?.command).toContain('--interactive-tailscale-setup');
    expect(response.data?.command).toContain('--auto-listen-port');
    expect(response.data?.command).toContain('--prefer-tunnel');
    expect(response.data?.command).toContain('--pane-dir');
    expect(response.data?.command).toContain('--label');
    expect(response.data?.command).toContain('--listen-port');
    expect(response.data?.command).toContain('--no-install-service');
    expect(response.data?.command).toContain('Windows WSL Smoke');
  });

  it('builds an interactive Tailscale client setup command', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const getCommand = ipcMain.handlers.get('remote-daemon:get-interactive-client-setup-command');
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const response = await getCommand?.({}) as { success?: boolean; data?: { command?: string } };

    expect(response).toMatchObject({
      success: true,
      data: {
        command: expect.stringContaining('sudo tailscale up'),
      },
    });
    expect(response.data?.command).toContain('tailscale.com/install.sh');
    expect(response.data?.command).not.toContain('serve --bg');
  });

  it('uses the macOS Tailscale CLI or installs the Homebrew formula when needed', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const getCommand = ipcMain.handlers.get('remote-daemon:get-interactive-client-setup-command');
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const response = await getCommand?.({}) as { success?: boolean; data?: { command?: string } };

    expect(response).toMatchObject({
      success: true,
      data: {
        command: expect.stringContaining('brew install tailscale'),
      },
    });
    expect(response.data?.command).toContain('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    expect(response.data?.command).toContain('brew services start tailscale');
    expect(response.data?.command).toContain('TAILSCALE_BE_CLI=1');
    expect(response.data?.command).not.toContain('brew install --cask tailscale');
    expect(response.data?.command).not.toContain('serve --bg');
  });

  it('preserves Tailscale tunnel metadata when importing a connection code', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const connectionCode = encodePaneRemoteConnection({
      v: 1,
      label: 'WSL',
      baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      token: 'secret-token',
      transport: 'http+sse',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
        tailscaleIp: '100.127.116.52',
      },
    });

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const importCode = ipcMain.handlers.get('remote-daemon:import-connection-code');
    const response = await importCode?.({}, {
      code: connectionCode,
      connect: false,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        profile: {
          label: 'WSL',
          baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
          tunnel: {
            kind: 'tailscale',
            selected: true,
            tailscaleIp: '100.127.116.52',
          },
        },
        connected: false,
      },
    });
    expect(configManager.getConfig().remoteDaemon?.client.profiles[0]).toMatchObject({
      label: 'WSL',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        tailscaleIp: '100.127.116.52',
      },
    });
  });

  it('saves an imported profile without switching runtime when import connection activation fails', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const send = vi.fn();
    const connectionCode = encodePaneRemoteConnection({
      v: 1,
      label: 'WSL',
      baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      token: 'secret-token',
      transport: 'http+sse',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
        tailscaleIp: '100.127.116.52',
      },
    });
    vi.spyOn(remotePaneClientController, 'activateProfile').mockRejectedValue(new Error('Remote daemon not ready yet'));

    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    });

    const importCode = ipcMain.handlers.get('remote-daemon:import-connection-code');

    await expect(importCode?.({}, {
      code: connectionCode,
      connect: true,
    })).resolves.toMatchObject({
      success: true,
      data: {
        profile: {
          label: 'WSL',
          baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
        },
        connected: false,
        connectionError: 'Remote daemon not ready yet',
      },
    });

    expect(send).not.toHaveBeenCalledWith('remote-daemon:resync-required');
    expect(configManager.getConfig().remoteDaemon?.client).toMatchObject({
      activeProfileId: null,
      mode: 'local',
      profiles: [{
        label: 'WSL',
        baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      }],
    });
  });

  it('updates an existing imported profile instead of duplicating the same connection code', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const connectionCode = encodePaneRemoteConnection({
      v: 1,
      label: 'PARSA-SL7 Pane daemon',
      baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      token: 'secret-token',
      transport: 'http+sse',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg http://127.0.0.1:42137',
        tailscaleIp: '100.127.116.52',
      },
    });

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const importCode = ipcMain.handlers.get('remote-daemon:import-connection-code');
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const firstResponse = await importCode?.({}, {
      code: connectionCode,
      connect: false,
    }) as { success?: boolean; data?: { profile?: { id?: string } } };
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const secondResponse = await importCode?.({}, {
      code: connectionCode,
      connect: false,
    }) as { success?: boolean; data?: { profile?: { id?: string } } };

    expect(firstResponse.success).toBe(true);
    expect(secondResponse.success).toBe(true);
    expect(secondResponse.data?.profile?.id).toBe(firstResponse.data?.profile?.id);
    expect(configManager.getConfig().remoteDaemon?.client.profiles).toHaveLength(1);
    expect(configManager.getConfig().remoteDaemon?.client.profiles[0]).toMatchObject({
      id: firstResponse.data?.profile?.id,
      label: 'PARSA-SL7 Pane daemon',
      baseUrl: 'https://parsa-sl7.taila5e94c.ts.net',
      token: 'secret-token',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        tailscaleIp: '100.127.116.52',
      },
    });
  });

  it('allows isolated remote host setup with service install enabled', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.mocked(setupRemoteHost).mockResolvedValue(createSetupResult({
      paneDir: '/tmp/pane-remote',
      service: {
        strategy: 'launch-agent',
        installed: true,
        started: true,
        message: 'Installed and started a LaunchAgent.',
      },
    }));

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const setupHost = ipcMain.handlers.get('remote-daemon:setup-host');
    const response = await setupHost?.({}, {
      dataDirectoryMode: 'isolated',
      paneDir: '/tmp/pane-remote',
      installService: true,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        dataDirectoryMode: 'isolated',
        paneDir: '/tmp/pane-remote',
        service: {
          strategy: 'launch-agent',
          installed: true,
          started: true,
        },
      },
    });
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({
      paneDir: '/tmp/pane-remote',
      installService: true,
      existingConfig: undefined,
      writeConfig: undefined,
    }));
  });

  it('accepts explicitly undefined optional setup fields from the Remote Access UI', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.mocked(setupRemoteHost).mockResolvedValue(createSetupResult());

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const setupHost = ipcMain.handlers.get('remote-daemon:setup-host');
    const response = await setupHost?.({}, {
      dataDirectoryMode: 'current',
      paneDir: undefined,
      preferTunnel: 'auto',
      baseUrl: undefined,
    });

    expect(response).toMatchObject({ success: true });
    expect(setupRemoteHost).toHaveBeenCalledWith(expect.objectContaining({
      preferTunnel: 'auto',
    }));
  });

  it('rejects non-loopback HTTP manual setup URLs', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const setupHost = ipcMain.handlers.get('remote-daemon:setup-host');

    await expect(setupHost?.({}, {
      preferTunnel: 'manual',
      baseUrl: 'http://192.168.1.50:42137',
    })).resolves.toEqual({
      success: false,
      error: 'HTTP remote base URLs must use a loopback host; use HTTPS for Tailscale or reverse-proxy endpoints',
    });
    expect(setupRemoteHost).not.toHaveBeenCalled();
  });

  it('falls back to local mode when deleting the active connection profile', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = {
      profiles: [{
        id: 'profile-1',
        label: 'Workstation',
        baseUrl: 'http://127.0.0.1:42137',
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-1',
      mode: 'remote',
    };

    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);
    const send = vi.fn();
    vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockResolvedValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    });

    const deleteProfile = ipcMain.handlers.get('remote-daemon:delete-connection-profile');

    await expect(deleteProfile?.({}, 'profile-1')).resolves.toEqual({
      success: true,
      data: {
        profiles: [],
        activeProfileId: null,
        mode: 'local',
      },
    });
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required');
  });

  it('does not resync or switch runtime when deleting an inactive connection profile', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = {
      profiles: [{
        id: 'profile-1',
        label: 'Workstation',
        baseUrl: 'http://127.0.0.1:42137',
        token: 'secret-token',
        transport: 'http+sse',
      }, {
        id: 'profile-2',
        label: 'Old workstation',
        baseUrl: 'http://127.0.0.1:42138',
        token: 'old-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-1',
      mode: 'remote',
    };

    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);
    const send = vi.fn();
    const switchToLocalMode = vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockResolvedValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    });

    const deleteProfile = ipcMain.handlers.get('remote-daemon:delete-connection-profile');

    await expect(deleteProfile?.({}, 'profile-2')).resolves.toEqual({
      success: true,
      data: {
        profiles: [{
          id: 'profile-1',
          label: 'Workstation',
          baseUrl: 'http://127.0.0.1:42137',
          token: 'secret-token',
          transport: 'http+sse',
        }],
        activeProfileId: 'profile-1',
        mode: 'remote',
      },
    });
    expect(switchToLocalMode).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('remote-daemon:resync-required');
  });

  it('switches to local runtime through client state update and resyncs the renderer', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = {
      profiles: [{
        id: 'profile-1',
        label: 'Workstation',
        baseUrl: 'http://127.0.0.1:42137',
        token: 'secret-token',
        transport: 'http+sse',
      }],
      activeProfileId: 'profile-1',
      mode: 'remote',
    };

    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);
    const send = vi.fn();
    const switchToLocalMode = vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockResolvedValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });

    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    });

    const updateClientState = ipcMain.handlers.get('remote-daemon:update-client-state');

    await expect(updateClientState?.({}, {
      activeProfileId: null,
      mode: 'local',
    })).resolves.toEqual({
      success: true,
      data: {
        profiles: [{
          id: 'profile-1',
          label: 'Workstation',
          baseUrl: 'http://127.0.0.1:42137',
          token: 'secret-token',
          transport: 'http+sse',
        }],
        activeProfileId: null,
        mode: 'local',
      },
    });
    expect(switchToLocalMode).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required');
    expect(configManager.getConfig().remoteDaemon?.client).toMatchObject({
      activeProfileId: null,
      mode: 'local',
    });
  });

  it('creates a paired host client record and saved connection profile together', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const createPair = ipcMain.handlers.get('remote-daemon:create-connection-pair');
    const response = await createPair?.({}, {
      label: 'Office Mac mini',
      baseUrl: 'http://127.0.0.1:42137',
    });

    expect(response?.success).toBe(true);
    expect(response?.data?.client.label).toBe('Office Mac mini');
    expect(response?.data?.profile.label).toBe('Office Mac mini');
    expect(response?.data?.profile.baseUrl).toBe('http://127.0.0.1:42137');
    expect(response?.data?.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('creates a host connection code from cached host access without running setup', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.host.config.enabled = true;
    initialConfig.host.access = {
      baseUrl: 'https://office-mac.tailnet.ts.net',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
        tailscaleIp: '100.127.116.52',
      },
      updatedAt: '2026-05-18T20:00:00.000Z',
    };
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const createCode = ipcMain.handlers.get('remote-daemon:create-host-connection-code');
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const response = await createCode?.({}, { label: 'Office Mac mini' }) as {
      success?: boolean;
      data?: { connectionCode?: string };
    };

    expect(response.success).toBe(true);
    expect(setupRemoteHost).not.toHaveBeenCalled();
    expect(readConfiguredTailscaleServeAccess).not.toHaveBeenCalled();
    expect(response.data?.connectionCode).toContain('pane-remote://');

    const payload = decodePaneRemoteConnection(response.data?.connectionCode ?? '');
    expect(payload).toMatchObject({
      label: 'Office Mac mini',
      baseUrl: 'https://office-mac.tailnet.ts.net',
      tunnel: {
        kind: 'tailscale',
        tailscaleIp: '100.127.116.52',
      },
    });
    expect(configManager.getConfig().remoteDaemon?.host.clients).toHaveLength(1);
    expectConnectionCodeAuthenticates(configManager, response.data?.connectionCode);
    expect(configManager.getConfig().remoteDaemon?.client.profiles).toHaveLength(0);
  });

  it('discovers existing Tailscale Serve access when cached host access is missing', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.host.config.enabled = true;
    initialConfig.host.config.listenPort = 42138;
    vi.mocked(readConfiguredTailscaleServeAccess).mockResolvedValue({
      baseUrl: 'https://wsl.tailnet.ts.net',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42138',
        tailscaleIp: '100.75.154.34',
      },
      updatedAt: '2026-05-18T20:01:00.000Z',
    });
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const createCode = ipcMain.handlers.get('remote-daemon:create-host-connection-code');
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const response = await createCode?.({}, {}) as {
      success?: boolean;
      data?: { connectionCode?: string };
    };

    expect(response.success).toBe(true);
    expect(readConfiguredTailscaleServeAccess).toHaveBeenCalledWith(42138);
    const payload = decodePaneRemoteConnection(response.data?.connectionCode ?? '');
    expect(payload.baseUrl).toBe('https://wsl.tailnet.ts.net');
    expect(configManager.getConfig().remoteDaemon?.host.access?.baseUrl).toBe('https://wsl.tailnet.ts.net');
  });

  it('creates a fresh host connection code after forgetting the previous code', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.host.config.enabled = true;
    initialConfig.host.config.listenPort = 42138;
    vi.mocked(readConfiguredTailscaleServeAccess).mockResolvedValue({
      baseUrl: 'https://wsl.tailnet.ts.net',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42138',
        tailscaleIp: '100.75.154.34',
      },
      updatedAt: '2026-05-18T20:01:00.000Z',
    });
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const createCode = ipcMain.handlers.get('remote-daemon:create-host-connection-code');
    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const firstResponse = await createCode?.({}, { label: 'Office Mac mini' }) as {
      success?: boolean;
      data?: { connectionCode?: string };
    };

    expect(firstResponse.success).toBe(true);
    expect(configManager.getConfig().remoteDaemon?.host.clients).toHaveLength(1);
    expectConnectionCodeAuthenticates(configManager, firstResponse.data?.connectionCode);

    const clearCode = ipcMain.handlers.get('remote-daemon:clear-host-access');
    await expect(clearCode?.({})).resolves.toMatchObject({
      success: true,
      data: {
        clients: [],
      },
    });
    expectConnectionCodeForbidden(configManager, firstResponse.data?.connectionCode);

    // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
    const secondResponse = await createCode?.({}, { label: 'Office Mac mini' }) as {
      success?: boolean;
      data?: { connectionCode?: string };
    };

    expect(secondResponse.success).toBe(true);
    expect(secondResponse.data?.connectionCode).toContain('pane-remote://');
    expect(secondResponse.data?.connectionCode).not.toBe(firstResponse.data?.connectionCode);
    expect(decodePaneRemoteConnection(secondResponse.data?.connectionCode ?? '').token)
      .not.toBe(decodePaneRemoteConnection(firstResponse.data?.connectionCode ?? '').token);
    expect(configManager.getConfig().remoteDaemon?.host.clients).toHaveLength(1);
    expectConnectionCodeForbidden(configManager, firstResponse.data?.connectionCode);
    expectConnectionCodeAuthenticates(configManager, secondResponse.data?.connectionCode);
  });

  it('fails host connection code creation when the generated client is not persisted', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.host.config.enabled = true;
    initialConfig.host.access = {
      baseUrl: 'https://office-mac.tailnet.ts.net',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
        tailscaleIp: '100.127.116.52',
      },
      updatedAt: '2026-05-18T20:00:00.000Z',
    };
    const ipcMain = createIpcMainStub();
    const configManager = createClientDroppingConfigManagerStub(initialConfig);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const createCode = ipcMain.handlers.get('remote-daemon:create-host-connection-code');
    await expect(createCode?.({}, { label: 'Office Mac mini' })).resolves.toEqual({
      success: false,
      error: 'Created remote connection code was not saved. Try again before sharing this code.',
    });
    expect(configManager.getConfig().remoteDaemon?.host.clients).toHaveLength(0);
  });

  it('normalizes stale remote mode back to local when no active profile remains', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = {
      profiles: [],
      activeProfileId: null,
      mode: 'remote',
    };

    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:get-config')?.({})).resolves.toEqual({
      success: true,
      data: createDefaultRemoteDaemonConfig(),
    });
  });

  it('rejects connection profiles with empty auth or endpoint fields', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const upsertProfile = ipcMain.handlers.get('remote-daemon:upsert-connection-profile');

    await expect(upsertProfile?.({}, {
      id: 'profile-1',
      label: 'Broken profile',
      baseUrl: '   ',
      token: '',
      transport: 'http+sse',
    })).resolves.toEqual({
      success: false,
      error: 'Remote daemon connection profile is invalid',
    });
  });

  it('keeps the saved client mode local when remote activation fails', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const upsertProfile = ipcMain.handlers.get('remote-daemon:upsert-connection-profile');
    const updateClientState = ipcMain.handlers.get('remote-daemon:update-client-state');
    const getConfig = ipcMain.handlers.get('remote-daemon:get-config');

    vi.spyOn(remotePaneClientController, 'activateProfile').mockRejectedValue(new Error('Remote daemon not ready yet'));

    await upsertProfile?.({}, {
      id: 'profile-1',
      label: 'Mac mini',
      baseUrl: 'http://127.0.0.1:42137',
      token: 'secret-token',
      transport: 'http+sse',
    });

    await expect(updateClientState?.({}, {
      activeProfileId: 'profile-1',
      mode: 'remote',
    })).resolves.toEqual({
      success: false,
      error: 'Remote daemon not ready yet',
    });

    await expect(getConfig?.({})).resolves.toEqual({
      success: true,
      data: {
        host: {
          config: createDefaultRemoteDaemonConfig().host.config,
          clients: [],
          mobilePush: { registrations: [], attentionSequence: 0, panelStates: {} },
        },
        client: {
          profiles: [{
            id: 'profile-1',
            label: 'Mac mini',
            baseUrl: 'http://127.0.0.1:42137',
            token: 'secret-token',
            transport: 'http+sse',
          }],
          activeProfileId: null,
          mode: 'local',
        },
      },
    });
  });

  it('rejects enabling direct HTTP on a non-loopback listen host', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const updateHostConfig = ipcMain.handlers.get('remote-daemon:update-host-config');

    await expect(updateHostConfig?.({}, {
      enabled: true,
      listenHost: '0.0.0.0',
      listenPort: 42137,
    })).resolves.toEqual({
      success: false,
      error: 'Remote daemon direct HTTP only supports loopback listen hosts; keep listenHost on 127.0.0.1, ::1, or localhost and expose it through an SSH tunnel, Tailscale/VPN, or a reverse proxy.',
    });
  });

  it('persists disabled host config when stopping the remote host', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.host.config = {
      ...initialConfig.host.config,
      enabled: true,
      listenPort: 42138,
    };
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    const updateHostConfig = ipcMain.handlers.get('remote-daemon:update-host-config');

    await expect(updateHostConfig?.({}, {
      enabled: false,
    })).resolves.toEqual({
      success: true,
      data: {
        ...initialConfig.host.config,
        enabled: false,
      },
    });
    expect(configManager.getConfig().remoteDaemon?.host.config).toMatchObject({
      enabled: false,
      listenPort: 42138,
    });
  });

  it('clears cached remote host access and revokes existing host clients without disabling the host', async () => {
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.host.config = {
      ...initialConfig.host.config,
      enabled: true,
      listenPort: 42138,
    };
    initialConfig.host.clients = [
      {
        id: 'client-1',
        label: 'Old phone',
        tokenHash: 'old-token-hash',
        createdAt: '2026-05-20T18:00:00.000Z',
      },
    ];
    initialConfig.host.access = {
      baseUrl: 'https://stale.tailnet.ts.net',
      tunnel: {
        kind: 'tailscale',
        selected: true,
        command: 'tailscale serve --bg http://127.0.0.1:42138',
        tailscaleIp: '100.75.154.34',
      },
      updatedAt: '2026-05-20T18:07:28.787Z',
    };
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(initialConfig);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:clear-host-access')?.({})).resolves.toEqual({
      success: true,
      data: {
        config: initialConfig.host.config,
        clients: [],
        mobilePush: { registrations: [], attentionSequence: 0, panelStates: {} },
      },
    });
    expect(configManager.getConfig().remoteDaemon?.host.access).toBeUndefined();
    expect(configManager.getConfig().remoteDaemon?.host.clients).toEqual([]);
    expect(configManager.getConfig().remoteDaemon?.host.config).toMatchObject({
      enabled: true,
      listenPort: 42138,
    });
    expect(disconnectActiveRemoteHostClients).toHaveBeenCalledWith();
  });

  it('disconnects live remote host clients through IPC', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    vi.mocked(disconnectActiveRemoteHostClients).mockReturnValue(2);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:disconnect-host-clients')?.({}, ['client-1'])).resolves.toEqual({
      success: true,
      data: { disconnectedCount: 2 },
    });
    expect(disconnectActiveRemoteHostClients).toHaveBeenCalledWith(['client-1']);
  });

  it('drops a live remote host client when access is revoked', async () => {
    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{
      id: 'client-1',
      label: 'Mac mini',
      createdAt: '2026-05-18T00:00:00.000Z',
      tokenHash: 'hashed-token',
    }];
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub(config);

    registerTestRemoteDaemonHandlers(ipcMain, { configManager });

    await expect(ipcMain.handlers.get('remote-daemon:delete-client-record')?.({}, 'client-1')).resolves.toEqual({
      success: true,
      data: [],
    });
    expect(disconnectActiveRemoteHostClients).toHaveBeenCalledWith(['client-1']);
  });
});
