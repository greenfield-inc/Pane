import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
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
import { CloudSandboxesUnavailableError, type CloudSandboxLibrary } from '../services/cloudSandboxes';
import type { CloudSandboxInfo, LocalStartEnv } from '../../../packages/runpane/src/cloud/api';
import type { SavedRemoteHosts } from '../../../packages/runpane/src/cloud/savedHosts';
import type { PaneCommandValue } from '../daemon/commandRegistry';

const readConfiguredTailscaleServeAccess = vi.fn<typeof readConfiguredTailscaleServeAccessImpl>();
const setupRemoteHost = vi.fn<typeof setupRemoteHostImpl>();
const disconnectActiveRemoteHostClients = vi.fn<typeof disconnectActiveRemoteHostClientsImpl>()
  .mockReturnValue(0);

type RemoteDaemonTestDependencies = NonNullable<Parameters<typeof registerRemoteDaemonHandlersImpl>[1]['dependencies']>;

function registerTestRemoteDaemonHandlers(
  ipcMain: Parameters<typeof registerRemoteDaemonHandlersImpl>[0],
  services: Omit<Parameters<typeof registerRemoteDaemonHandlersImpl>[1], 'dependencies'>,
  cloudDependencies: Partial<Pick<RemoteDaemonTestDependencies, 'loadCloudSandboxLibrary' | 'readCloudDaemonVersion' | 'resolvePaneReleaseDeb' | 'readDefaultClaudeModel' | 'watchClaudeSettings' | 'createCloudStartupScriptFile' | 'createCloudLocalStartScriptFile' | 'runLocalStartScript'>> = {},
): void {
  registerRemoteDaemonHandlersImpl(ipcMain, {
    ...services,
    dependencies: {
      disconnectActiveRemoteHostClients,
      readConfiguredTailscaleServeAccess,
      setupRemoteHost,
      loadCloudSandboxLibrary: () => Promise.reject(new CloudSandboxesUnavailableError()),
      readCloudDaemonVersion: async () => undefined,
      readDefaultClaudeModel: async () => null,
      resolvePaneReleaseDeb: async () => { throw new Error('no releases in tests'); },
      watchClaudeSettings: () => () => undefined,
      createCloudStartupScriptFile: () => ({ read: async () => '', write: async () => undefined }),
      createCloudLocalStartScriptFile: () => ({ read: async () => ({ shell: 'sh', script: '' }), write: async () => undefined }),
      runLocalStartScript: async () => { throw new Error('no local start script in tests'); },
      ...cloudDependencies,
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
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required', { hostChanged: true });

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

    registerTestRemoteDaemonHandlers(ipcMain, { configManager, app: { isPackaged: false, getVersion: () => '2.4.146' } });

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

    expect(send).not.toHaveBeenCalledWith('remote-daemon:resync-required', { hostChanged: true });
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
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required', { hostChanged: true });
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
    expect(send).not.toHaveBeenCalledWith('remote-daemon:resync-required', { hostChanged: true });
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
    expect(send).toHaveBeenCalledWith('remote-daemon:resync-required', { hostChanged: true });
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

describe('cloud sandbox IPC', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cloudProfile = {
    id: 'profile-alpha',
    label: 'alpha',
    baseUrl: 'https://rp-alpha.tail1234.ts.net',
    token: 'synthetic-token',
    transport: 'http+sse' as const,
    cloud: {
      provider: 'boat' as const,
      sandboxId: 'sbx-1',
      sessionId: 'session-alpha',
      nodeId: 'node-1',
      hostname: 'rp-alpha',
      version: 1,
    },
  };

  // What the desktop keeps: a sandbox profile always reads with the cloud host kind and a no-browser terminal.
  const savedCloudProfile = {
    ...cloudProfile,
    hostKind: { label: 'cloud sandbox', icon: 'cloud' as const },
    hostTerminalEnv: [{ name: 'BROWSER', value: 'false' }, { name: 'GH_BROWSER', value: 'false' }],
    githubSignIn: 'settings' as const,
    ghInsecureStorage: true,
  };

  const alpha: CloudSandboxInfo = {
    hostname: 'rp-alpha',
    label: 'alpha',
    profileId: 'profile-alpha',
    sessionId: 'session-alpha',
    sandboxId: 'sbx-1',
    state: 'running',
    providerState: 'running',
    baseUrl: 'https://rp-alpha.tail1234.ts.net',
    transport: 'https',
    size: 'default',
    createdAt: '2026-10-01T09:00:00.000Z',
  };
  const configured = { boat: { configured: true }, tailscale: { configured: true }, claude: { configured: true }, github: { configured: false }, ready: true };

  interface DesktopHostsRef {
    current?: SavedRemoteHosts;
    /** What the desktop gave the library to read the user's startup script with. */
    readStartupScript?: () => Promise<string>;
    /** What the desktop gave the library to run the local start script with. */
    readLocalStartEnv?: () => Promise<LocalStartEnv>;
  }

  function createCloudLibrary(hostsRef: DesktopHostsRef, overrides: Partial<CloudSandboxLibrary> = {}) {
    const library: CloudSandboxLibrary = {
      getCredentialsStatus: vi.fn(async () => configured),
      setup: vi.fn(async () => configured),
      create: vi.fn(async () => {
        await hostsRef.current?.upsert(cloudProfile);
        return alpha;
      }),
      list: vi.fn(async () => [alpha]),
      stop: vi.fn(async () => ({ ...alpha, state: 'stopped' as const })),
      start: vi.fn(async () => alpha),
      update: vi.fn(async () => alpha),
      remove: vi.fn(async () => {
        await hostsRef.current?.remove('session-alpha');
      }),
      syncAgentDefaults: vi.fn(async () => alpha),
      status: vi.fn(async () => alpha),
      runStartupScript: vi.fn(async () => null),
      readStartupLog: vi.fn(async () => 'MARKER\n'),
      ...overrides,
    };
    return {
      library,
      loadCloudSandboxLibrary: async ({ savedHosts, readStartupScript, readLocalStartEnv }: {
        savedHosts: SavedRemoteHosts;
        readStartupScript: () => Promise<string>;
        readLocalStartEnv: () => Promise<LocalStartEnv>;
      }) => {
        hostsRef.current = savedHosts;
        hostsRef.readStartupScript = readStartupScript;
        hostsRef.readLocalStartEnv = readLocalStartEnv;
        return library;
      },
    };
  }

  function stubSwitchToLocal() {
    return vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockResolvedValue({
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
    });
  }

  it('loads runpane\'s cloud library by default and reports an empty, unconfigured setup', async () => {
    const cloudDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-cloud-ipc-'));
    vi.stubEnv('RUNPANE_CLOUD_DIR', cloudDir);
    try {
      const ipcMain = createIpcMainStub();
      registerRemoteDaemonHandlersImpl(ipcMain, { configManager: createConfigManagerStub() });

      const result = await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});

      expect(result).toMatchObject({
        success: true,
        data: { available: true, credentials: { boat: false, tailscale: false, claude: false, github: false }, sandboxes: [] },
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(cloudDir, { recursive: true, force: true });
    }
  });

  it('reports cloud sandboxes as unavailable when the cloud library is missing', async () => {
    const ipcMain = createIpcMainStub();
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub() });

    await expect(ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({})).resolves.toMatchObject({
      success: true,
      data: { available: false, sandboxes: [] },
    });
    await expect(ipcMain.handlers.get('remote-daemon:create-cloud-sandbox')?.({}, { name: 'alpha', size: 'default' }))
      .resolves.toEqual({ success: false, error: 'Cloud sandboxes are not available in this build of Pane.' });
  });

  it('saves a created sandbox as a cloud host profile and pushes snapshots to the renderer', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const send = vi.fn();
    const cloud = createCloudLibrary({});
    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    }, cloud);

    const result = await ipcMain.handlers.get('remote-daemon:create-cloud-sandbox')?.({}, {
      name: ' alpha ',
      size: 'default',
    });

    expect(cloud.library.create).toHaveBeenCalledWith({ label: 'alpha', size: 'default' }, expect.anything());
    expect(result).toMatchObject({ success: true, data: { sandboxes: [{ id: 'rp-alpha', state: 'running' }] } });
    expect(configManager.getConfig().remoteDaemon?.client.profiles).toEqual([savedCloudProfile]);
    expect(send).toHaveBeenCalledWith('remote-daemon:cloud-sandboxes-changed', expect.objectContaining({ available: true }));
  });

  it('keeps the startup script in a local file the library reads, and runs an edit on running sandboxes', async () => {
    const ipcMain = createIpcMainStub();
    let saved = '';
    const startupScriptFile = { read: vi.fn(async () => saved), write: vi.fn(async (script: string) => { saved = script; }) };
    const hostsRef: DesktopHostsRef = {};
    const cloud = createCloudLibrary(hostsRef);
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub() }, {
      ...cloud,
      createCloudStartupScriptFile: () => startupScriptFile,
    });
    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});

    const result = await ipcMain.handlers.get('remote-daemon:save-cloud-startup-script')?.({}, 'echo MARKER\n');

    expect(result).toMatchObject({ success: true, data: { sandboxes: [{ id: 'rp-alpha' }] } });
    expect(startupScriptFile.write).toHaveBeenCalledWith('echo MARKER\n');
    await expect(ipcMain.handlers.get('remote-daemon:get-cloud-startup-script')?.({})).resolves.toEqual({ success: true, data: { script: 'echo MARKER\n' } });
    await expect(hostsRef.readStartupScript?.()).resolves.toBe('echo MARKER\n');
    await vi.waitFor(() => expect(cloud.library.runStartupScript).toHaveBeenCalledWith('rp-alpha', { onlyIfChanged: false }));
    await expect(ipcMain.handlers.get('remote-daemon:read-cloud-sandbox-startup-log')?.({}, 'rp-alpha'))
      .resolves.toEqual({ success: true, data: { log: 'MARKER\n' } });

    await expect(ipcMain.handlers.get('remote-daemon:save-cloud-startup-script')?.({}, 42)).resolves.toMatchObject({ success: false });
    await expect(ipcMain.handlers.get('remote-daemon:save-cloud-startup-script')?.({}, 'x'.repeat(256 * 1024 + 1)))
      .resolves.toEqual({ success: false, error: 'The startup script is too long (at most 256 KB).' });
    expect(startupScriptFile.write).toHaveBeenCalledTimes(1);
  });

  it('saves the local start script locally only, and runs it only when the library asks (a create or start)', async () => {
    const ipcMain = createIpcMainStub();
    let saved = { shell: 'sh' as const, script: '' };
    const file = { read: vi.fn(async () => saved), write: vi.fn(async (next: typeof saved) => { saved = next; }) };
    const runLocalStartScript = vi.fn(async () => ({
      ok: true, env: new Map([['DOPPLER_TOKEN', 'FAKE-LOCAL-ENV-ipc-SECRET']]), keys: ['DOPPLER_TOKEN'], reservedKeys: [], skippedLines: 0,
      exitCode: 0, timedOut: false, failureSummary: null,
    }));
    const hostsRef: DesktopHostsRef = {};
    const cloud = createCloudLibrary(hostsRef);
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub() }, {
      ...cloud,
      createCloudLocalStartScriptFile: () => file,
      runLocalStartScript,
    });
    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});

    const result = await ipcMain.handlers.get('remote-daemon:save-cloud-local-start-script')?.({}, { shell: 'sh', script: 'echo DOPPLER_TOKEN=x' });

    expect(result).toMatchObject({ success: true, data: { localStartScriptSet: true } });
    expect(runLocalStartScript).not.toHaveBeenCalled();
    expect(cloud.library.runStartupScript).not.toHaveBeenCalled();
    expect(cloud.library.start).not.toHaveBeenCalled();
    await expect(ipcMain.handlers.get('remote-daemon:get-cloud-local-start-script')?.({}))
      .resolves.toEqual({ success: true, data: { shell: 'sh', script: 'echo DOPPLER_TOKEN=x' } });

    const env = await hostsRef.readLocalStartEnv?.();
    expect(runLocalStartScript).toHaveBeenCalledWith('echo DOPPLER_TOKEN=x', { shell: 'sh', timeoutMs: 60_000 });
    expect(env?.status).toEqual({ state: 'ok', keys: 1, reserved: [] });
    expect(env?.envFile).toBe("export DOPPLER_TOKEN='FAKE-LOCAL-ENV-ipc-SECRET'\n");

    await expect(ipcMain.handlers.get('remote-daemon:save-cloud-local-start-script')?.({}, { shell: 'bash', script: '' }))
      .resolves.toMatchObject({ success: false });
    await expect(ipcMain.handlers.get('remote-daemon:save-cloud-local-start-script')?.({}, { shell: 'sh', script: 'x'.repeat(256 * 1024 + 1) }))
      .resolves.toEqual({ success: false, error: 'The local start script is too long (at most 256 KB).' });
  });

  it('keeps the saved profile id when the library saves the same sandbox again', async () => {
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client.profiles = [{ ...cloudProfile, id: 'desktop-id', baseUrl: 'http://rp-alpha.tail1234.ts.net:42137' }];
    const configManager = createConfigManagerStub(initialConfig);
    const hostsRef: DesktopHostsRef = {};
    registerTestRemoteDaemonHandlers(ipcMain, { configManager }, createCloudLibrary(hostsRef));

    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});
    await hostsRef.current?.upsert(cloudProfile);

    expect(configManager.getConfig().remoteDaemon?.client.profiles).toEqual([{ ...savedCloudProfile, id: 'desktop-id' }]);
  });

  it('rejects an invalid sandbox name before calling the library', async () => {
    const ipcMain = createIpcMainStub();
    const cloud = createCloudLibrary({});
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub() }, cloud);

    await expect(ipcMain.handlers.get('remote-daemon:create-cloud-sandbox')?.({}, { name: 'My Box', size: 'default' }))
      .resolves.toEqual({ success: false, error: 'Cloud sandbox name: Use lowercase letters, digits and dashes' });
    expect(cloud.library.create).not.toHaveBeenCalled();
  });

  it('passes credential updates through and answers with set/not-set only', async () => {
    const ipcMain = createIpcMainStub();
    const cloud = createCloudLibrary({});
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub() }, cloud);
    const update = { tailscale: { clientId: 'client-id', clientSecret: 'client-secret' } };

    const result = await ipcMain.handlers.get('remote-daemon:update-cloud-credentials')?.({}, update);

    expect(cloud.library.setup).toHaveBeenCalledWith(expect.objectContaining({
      tailscaleClientId: 'client-id',
      tailscaleClientSecret: 'client-secret',
    }));
    expect(result).toMatchObject({ success: true, data: { credentials: { boat: true, tailscale: true, claude: true } } });
    expect(JSON.stringify(result)).not.toContain('client-secret');
    await expect(ipcMain.handlers.get('remote-daemon:update-cloud-credentials')?.({}, {}))
      .resolves.toEqual({ success: false, error: 'Enter at least one credential to save' });
  });

  it('switches to the local runtime before stopping the connected sandbox', async () => {
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = { profiles: [cloudProfile], activeProfileId: 'profile-alpha', mode: 'remote' };
    const configManager = createConfigManagerStub(initialConfig);
    const switchToLocal = stubSwitchToLocal();
    const cloud = createCloudLibrary({});
    registerTestRemoteDaemonHandlers(ipcMain, { configManager }, cloud);
    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});

    const result = await ipcMain.handlers.get('remote-daemon:stop-cloud-sandbox')?.({}, 'rp-alpha');

    expect(switchToLocal).toHaveBeenCalledTimes(1);
    expect(switchToLocal.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(cloud.library.stop).mock.invocationCallOrder[0]);
    expect(configManager.getConfig().remoteDaemon?.client).toMatchObject({ mode: 'local', profiles: [cloudProfile] });
    expect(result).toMatchObject({ success: true, data: { sandboxes: [{ id: 'rp-alpha', state: 'stopped' }] } });
  });

  it('tells the renderer when the cloud library saves or forgets a host, so the host switcher updates', async () => {
    const ipcMain = createIpcMainStub();
    const configManager = createConfigManagerStub();
    const send = vi.fn();
    const hostsRef: DesktopHostsRef = {};
    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager,
      // SAFETY: This test fixture intentionally supplies the minimal structural substitute exercised by the unit.
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    }, createCloudLibrary(hostsRef));
    const profileEvents = () => send.mock.calls.filter(([channel]) => channel === 'remote-daemon:profiles-changed');

    await ipcMain.handlers.get('remote-daemon:create-cloud-sandbox')?.({}, { name: 'alpha', size: 'default' });
    expect(profileEvents()).toEqual([['remote-daemon:profiles-changed']]);

    // Saving the same host again changes nothing the renderer shows.
    await hostsRef.current?.upsert(cloudProfile);
    expect(profileEvents()).toHaveLength(1);

    await ipcMain.handlers.get('remote-daemon:remove-cloud-sandbox')?.({}, 'rp-alpha');
    expect(configManager.getConfig().remoteDaemon?.client.profiles).toEqual([]);
    expect(profileEvents()).toHaveLength(2);
  });

  it('forgets the saved profile and leaves remote mode when the connected sandbox is removed', async () => {
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = { profiles: [cloudProfile], activeProfileId: 'profile-alpha', mode: 'remote' };
    const configManager = createConfigManagerStub(initialConfig);
    stubSwitchToLocal();
    registerTestRemoteDaemonHandlers(ipcMain, { configManager }, createCloudLibrary({}));
    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});

    const result = await ipcMain.handlers.get('remote-daemon:remove-cloud-sandbox')?.({}, 'rp-alpha');

    expect(result).toMatchObject({ success: true, data: { sandboxes: [] } });
    expect(configManager.getConfig().remoteDaemon?.client).toEqual({ profiles: [], activeProfileId: null, mode: 'local' });
  });

  it('keeps a Remove that could not leave the connected sandbox on its row, for a renderer that missed the reply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = { profiles: [cloudProfile], activeProfileId: 'profile-alpha', mode: 'remote' };
    vi.spyOn(remotePaneClientController, 'switchToLocalMode').mockRejectedValue(new Error('local daemon did not answer'));
    const cloud = createCloudLibrary({});
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub(initialConfig) }, cloud);
    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});

    const result = await ipcMain.handlers.get('remote-daemon:remove-cloud-sandbox')?.({}, 'rp-alpha');

    const reason = "Remove didn't start: couldn't switch this window off the sandbox first (local daemon did not answer).";
    expect(result).toMatchObject({ success: false, error: reason });
    expect(cloud.library.remove).not.toHaveBeenCalled();
    // The renderer was resyncing and lost that reply; the next snapshot it asks for still says what happened.
    const fresh = await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});
    expect(fresh).toMatchObject({ success: true, data: { sandboxes: [{ id: 'rp-alpha', error: reason, failedAction: 'remove' }] } });
    expect(warn).toHaveBeenCalledWith(`[cloud] remove rp-alpha failed: ${reason}`);
  });

  it('keeps a failed Remove on its row after the window left the sandbox', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client = { profiles: [cloudProfile], activeProfileId: 'profile-alpha', mode: 'remote' };
    stubSwitchToLocal();
    const cloud = createCloudLibrary({});
    const unfinished = "Remove didn't finish: boat still lists alpha's sandbox bx_alpha (idle) 3 minutes after accepting the delete. Try Remove again.";
    vi.mocked(cloud.library.remove).mockRejectedValueOnce(new Error(unfinished));
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub(initialConfig) }, cloud);
    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});

    await ipcMain.handlers.get('remote-daemon:remove-cloud-sandbox')?.({}, 'rp-alpha');

    const fresh = await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});
    expect(fresh).toMatchObject({ success: true, data: { sandboxes: [{ id: 'rp-alpha', error: unfinished, failedAction: 'remove' }] } });
    expect(info).toHaveBeenCalledWith('[cloud] remove rp-alpha: started');
  });

  it('reads the daemon version through the saved profile and updates Pane to this app\'s version', async () => {
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client.profiles = [cloudProfile];
    const readCloudDaemonVersion = vi.fn(async () => '2.4.100');
    const resolvePaneReleaseDeb = vi.fn(async (version: string) => ({ debUrl: `https://example.test/${version}.deb`, sha256: 'f'.repeat(64) }));
    const cloud = createCloudLibrary({});
    registerTestRemoteDaemonHandlers(ipcMain, {
      configManager: createConfigManagerStub(initialConfig),
      app: { isPackaged: true, getVersion: () => '2.4.146' },
    }, { ...cloud, readCloudDaemonVersion, resolvePaneReleaseDeb });

    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});
    await vi.waitFor(() => expect(readCloudDaemonVersion).toHaveBeenCalledWith(savedCloudProfile));
    await ipcMain.handlers.get('remote-daemon:update-cloud-sandbox')?.({}, 'rp-alpha');

    expect(cloud.library.update).toHaveBeenCalledWith('rp-alpha', { debUrl: 'https://example.test/2.4.146.deb', sha256: 'f'.repeat(64) }, expect.any(Function));
  });

  it('gives a cloud sandbox the default model when the desktop connects to it, once per connect', async () => {
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client.profiles = [cloudProfile, { ...cloudProfile, id: 'plain', cloud: undefined }];
    const cloud = createCloudLibrary({});
    const readDefaultClaudeModel = vi.fn(async () => 'claude-opus-5-5');
    let libraryModelSource: (() => Promise<string | null>) | undefined;
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub(initialConfig) }, {
      loadCloudSandboxLibrary: async (options) => {
        libraryModelSource = options.localClaudeModel;
        return cloud.library;
      },
      readDefaultClaudeModel,
    });
    const connected = { mode: 'remote' as const, status: 'connected' as const, activeProfileLabel: 'alpha', activeBaseUrl: cloudProfile.baseUrl, lastError: null };
    // Loading the list gives the unsynced sandbox the default once; the connects below are what is measured.
    await ipcMain.handlers.get('remote-daemon:get-cloud-sandboxes')?.({});
    await vi.waitFor(() => expect(cloud.library.syncAgentDefaults).toHaveBeenCalledTimes(1));
    vi.mocked(cloud.library.syncAgentDefaults).mockClear();

    const listCalls = vi.mocked(cloud.library.list).mock.calls.length;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    // A host that is not a cloud sandbox never reaches the cloud library.
    remotePaneClientController.emit('state-changed', { ...connected, activeProfileId: 'plain' });
    await settle();
    expect(cloud.library.list).toHaveBeenCalledTimes(listCalls);
    expect(cloud.library.syncAgentDefaults).not.toHaveBeenCalled();

    remotePaneClientController.emit('state-changed', { ...connected, activeProfileId: 'profile-alpha' });
    await vi.waitFor(() => expect(cloud.library.syncAgentDefaults).toHaveBeenCalledTimes(1));
    expect(cloud.library.syncAgentDefaults).toHaveBeenCalledWith('rp-alpha');
    await settle();

    // Later state pushes for the same connection (heartbeats) are not a new connect.
    remotePaneClientController.emit('state-changed', { ...connected, activeProfileId: 'profile-alpha', lastSeenAt: 'later' });
    await settle();
    expect(cloud.library.syncAgentDefaults).toHaveBeenCalledTimes(1);

    // Leaving and connecting again counts as a new connect.
    remotePaneClientController.emit('state-changed', { ...connected, status: 'reconnecting' as const, activeProfileId: 'profile-alpha' });
    remotePaneClientController.emit('state-changed', { ...connected, activeProfileId: 'profile-alpha' });
    await vi.waitFor(() => expect(cloud.library.syncAgentDefaults).toHaveBeenCalledTimes(2));
    // The library reads the same source the desktop checks, so a second source plugs in in one place.
    expect(libraryModelSource).toBe(readDefaultClaudeModel);
  });

  it('follows a change of the user\'s Claude default while connected, and stops watching when it leaves', async () => {
    const ipcMain = createIpcMainStub();
    const initialConfig = createDefaultRemoteDaemonConfig();
    initialConfig.client.profiles = [cloudProfile, { ...cloudProfile, id: 'plain', cloud: undefined }];
    const cloud = createCloudLibrary({});
    let model = 'claude-opus-5-5';
    const watches: Array<{ onChange: () => void; stop: ReturnType<typeof vi.fn> }> = [];
    registerTestRemoteDaemonHandlers(ipcMain, { configManager: createConfigManagerStub(initialConfig) }, {
      loadCloudSandboxLibrary: async () => cloud.library,
      readDefaultClaudeModel: async () => model,
      watchClaudeSettings: (onChange) => {
        const stop = vi.fn();
        watches.push({ onChange, stop });
        return stop;
      },
    });
    const connected = { mode: 'remote' as const, status: 'connected' as const, activeProfileLabel: 'alpha', activeBaseUrl: cloudProfile.baseUrl, lastError: null };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    remotePaneClientController.emit('state-changed', { ...connected, activeProfileId: 'plain' });
    await settle();
    expect(watches).toHaveLength(0);

    remotePaneClientController.emit('state-changed', { ...connected, activeProfileId: 'profile-alpha' });
    await vi.waitFor(() => expect(cloud.library.syncAgentDefaults).toHaveBeenCalled());
    await settle();
    expect(watches).toHaveLength(1);
    vi.mocked(cloud.library.syncAgentDefaults).mockClear();

    // An unchanged default is not synced again; a changed one is, with no host switch or Start.
    watches[0].onChange();
    await settle();
    expect(cloud.library.syncAgentDefaults).not.toHaveBeenCalled();
    model = 'claude-sonnet-5-5';
    watches[0].onChange();
    await vi.waitFor(() => expect(cloud.library.syncAgentDefaults).toHaveBeenCalledWith('rp-alpha'));

    remotePaneClientController.emit('state-changed', { ...connected, status: 'reconnecting' as const, activeProfileId: 'profile-alpha' });
    expect(watches[0].stop).toHaveBeenCalledTimes(1);
  });
});
