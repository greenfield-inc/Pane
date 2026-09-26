import { runRemoteSetupCommand } from '../daemon/remote-setup-command';
import {
  decodePaneRemoteConnection,
  encodePaneRemoteConnection,
  getRemoteDaemonHostConfigValidationError,
  isRemoteDaemonClientRecord,
  isRemotePaneConnectionProfile,
  normalizePaneRemoteConnectionImportPayload,
  normalizeRemoteDaemonConfig,
  remoteImportPayloadToProfile,
  type PaneRemoteConnectionImportPayload,
  type RemoteDaemonClientRecord,
  type RemoteDaemonConnectionPair,
  type RemoteDaemonClientMode,
  type RemoteDaemonClientSettings,
  type RemoteDaemonConfig,
  type RemoteDaemonHostAccess,
  type RemoteDaemonHostRuntimeState,
  type RemoteHostConnectionCodeResult,
  type RemoteDaemonImportResult,
  type RemoteHostSetupRequest,
  type RemoteHostSetupResult,
  type RemoteHostSetupTerminalCommandResult,
  type RemoteSetupChannel,
  type RemoteSetupDataDirectoryMode,
  type RemoteSetupTunnelPreference,
} from '../../../shared/types/remoteDaemon';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { boundary, decodeBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';
import os from 'os';
import path from 'path';
import type { AppServices } from './types';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import {
  createPaneRemoteConnectionImportPayload,
  createRemoteDaemonConnectionPair,
} from '../daemon/remotePairing';
import { remoteHostRuntimeStateStore } from '../daemon/remoteHostRuntimeState';
import { readConfiguredTailscaleServeAccess, setupRemoteHost } from '../daemon/setupRemoteHost';
import { getAppDirectory } from '../utils/appDirectory';
import { ShellDetector } from '../utils/shellDetector';
import { disconnectActiveRemoteHostClients } from '../daemon/remoteTransportController';
import {
  getConnectedClientCountBucket,
  getRemoteFailureCategory,
  getRemoteImportProperties,
  getRemoteSetupProperties,
  getRemoteSetupResultProperties,
  trackRemotePaneEvent,
  type RemotePaneAnalyticsProperties,
} from '../services/remoteAnalytics';

interface IpcMainHandleLike {
  handle(
    channel: string,
    listener: (_event: { readonly sender: object }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>,
  ): void;
}

interface RemoteDaemonHandlerServices {
  app?: Pick<AppServices['app'], 'isPackaged'>;
  getMainWindow?: AppServices['getMainWindow'];
  analyticsManager?: AppServices['analyticsManager'];
  configManager: Pick<AppServices['configManager'], 'getConfig' | 'updateConfig'> & {
    getPreferredShell?: () => string;
  };
  dependencies?: RemoteDaemonHandlerDependencies;
}

interface RemoteDaemonHandlerDependencies {
  disconnectActiveRemoteHostClients: typeof disconnectActiveRemoteHostClients;
  readConfiguredTailscaleServeAccess: typeof readConfiguredTailscaleServeAccess;
  setupRemoteHost: typeof setupRemoteHost;
}

const defaultRemoteDaemonHandlerDependencies: RemoteDaemonHandlerDependencies = {
  disconnectActiveRemoteHostClients,
  readConfiguredTailscaleServeAccess,
  setupRemoteHost,
};

let remoteHostStateForwarder:
  | ((state: RemoteDaemonHostRuntimeState) => void)
  | null = null;

export function registerRemoteDaemonHandlers(
  ipcMain: IpcMainHandleLike,
  {
    configManager,
    app,
    getMainWindow,
    analyticsManager,
    dependencies = defaultRemoteDaemonHandlerDependencies,
  }: RemoteDaemonHandlerServices,
): void {
  attachRemoteHostStateForwarder(getMainWindow);

  function requestRendererRemoteResync(): void {
    const mainWindow = getMainWindow?.();
    if (mainWindow) {
      mainWindow.webContents.send('remote-daemon:resync-required');
    }
  }

  async function applyRemoteClientTransition(
    transition: (current: RemoteDaemonConfig) => Promise<{
      next: RemoteDaemonConfig;
      resyncRenderer: boolean;
    }> | {
      next: RemoteDaemonConfig;
      resyncRenderer: boolean;
    },
  ): Promise<RemoteDaemonConfig> {
    const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
    const result = await transition(current);
    const next = normalizeRemoteDaemonConfig(result.next);

    await configManager.updateConfig({ remoteDaemon: next });
    if (result.resyncRenderer) {
      requestRendererRemoteResync();
    }

    return next;
  }

  ipcMain.handle('remote-daemon:get-config', async () => {
    try {
      return { success: true, data: getRemoteDaemonConfig(configManager.getConfig().remoteDaemon) };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to get remote daemon config') };
    }
  });

  ipcMain.handle('remote-daemon:get-connection-state', async () => {
    try {
      return { success: true, data: remotePaneClientController.getConnectionState() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to get remote daemon connection state') };
    }
  });

  ipcMain.handle('remote-daemon:get-host-state', async () => {
    try {
      return { success: true, data: await remoteHostRuntimeStateStore.refreshExecutableHealth() };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to get remote daemon host state') };
    }
  });

  ipcMain.handle('remote-daemon:get-interactive-setup-command', async (_event, input: PaneCommandValue) => {
    try {
      const request = parseRemoteHostSetupRequest(input);
      const shellName = process.platform === 'win32'
        ? ShellDetector.getDefaultShell(configManager.getPreferredShell?.()).name
        : undefined;
      const command = buildInteractiveSetupCommand(request, app?.isPackaged === true, shellName);
      trackRemotePaneEvent(analyticsManager, 'remote_pane_setup_terminal_opened', {
        ...getRemoteSetupProperties(request),
        result: 'succeeded',
      });
      return {
        success: true,
        data: { command } satisfies RemoteHostSetupTerminalCommandResult,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to build remote setup command') };
    }
  });

  ipcMain.handle('remote-daemon:get-interactive-client-setup-command', async () => {
    try {
      const shellName = process.platform === 'win32'
        ? ShellDetector.getDefaultShell(configManager.getPreferredShell?.()).name
        : undefined;
      return {
        success: true,
        data: {
          command: buildInteractiveClientSetupCommand(shellName),
        } satisfies RemoteHostSetupTerminalCommandResult,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to build Tailscale client setup command') };
    }
  });

  ipcMain.handle('remote-daemon:setup-host', async (_event, input: PaneCommandValue) => {
    let request: RemoteHostSetupRequest | null = null;
    try {
      request = parseRemoteHostSetupRequest(input);
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_setup_started', {
        ...getRemoteSetupProperties(request),
        result: 'started',
      });
      const dataDirectoryMode = request.dataDirectoryMode ?? 'current';
      const useCurrentDataDirectory = dataDirectoryMode === 'current';
      const result = await dependencies.setupRemoteHost({
        paneDir: useCurrentDataDirectory ? getAppDirectory() : request.paneDir,
        label: request.label,
        listenPort: request.listenPort,
        channel: request.channel,
        repoRef: request.repoRef,
        installService: useCurrentDataDirectory ? false : request.installService !== false,
        exposeTailscale: request.exposeTailscale,
        preferTunnel: request.preferTunnel,
        baseUrl: request.baseUrl,
        autoSelectListenPort: true,
        asyncCommandRunner: runRemoteSetupCommand,
        existingConfig: useCurrentDataDirectory ? configManager.getConfig() : undefined,
        writeConfig: useCurrentDataDirectory
          ? async (nextConfig) => {
              await configManager.updateConfig({
                remoteDaemon: normalizeRemoteDaemonConfig(nextConfig.remoteDaemon),
              });
            }
          : undefined,
      });
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_setup_succeeded', {
        ...getRemoteSetupProperties(request),
        ...getRemoteSetupResultProperties({
          ...result,
          dataDirectoryMode,
        }),
        result: 'succeeded',
      });

      return {
        success: true,
        data: {
          ...result,
          dataDirectoryMode,
        } satisfies RemoteHostSetupResult,
      };
    } catch (error) {
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_setup_failed', {
        ...(request ? getRemoteSetupProperties(request) : { surface: 'desktop', role: 'host', flow: 'setup' }),
        result: 'failed',
        failure_stage: 'setup_host',
        failure_category: getRemoteFailureCategory(error instanceof Error ? error.message : String(error)),
      });
      return { success: false, error: getErrorMessage(error, 'Failed to set up remote daemon host') };
    }
  });

  ipcMain.handle('remote-daemon:create-connection-pair', async (_event, input: PaneCommandValue) => {
    try {
      const requestInput = decodeBoundary(input, boundary.object({
        label: boundary.string,
        baseUrl: boundary.string,
      }));
      const label = requestInput.label.trim();
      const baseUrl = requestInput.baseUrl.trim();
      if (label.length === 0) {
        throw new Error('Remote daemon connection pair label is required');
      }
      if (baseUrl.length === 0) {
        throw new Error('Remote daemon connection pair base URL is required');
      }

      const pair = createRemoteDaemonConnectionPair({
        label,
        baseUrl,
      });

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          clients: upsertById(current.host.clients, pair.client),
        },
        client: {
          ...current.client,
          profiles: upsertById(current.client.profiles, pair.profile),
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_pair_created', {
        surface: 'desktop',
        role: 'host',
        flow: 'setup',
        result: 'succeeded',
      });
      return {
        success: true,
        data: pair satisfies RemoteDaemonConnectionPair,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to create remote daemon connection pair') };
    }
  });

  ipcMain.handle('remote-daemon:create-host-connection-code', async (_event, input: PaneCommandValue) => {
    try {
      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const label = readOptionalConnectionCodeLabel(input) ?? `${os.hostname()} Pane daemon`;
      const access = await resolveCurrentHostAccess(current, dependencies.readConfiguredTailscaleServeAccess);
      const pair = createRemoteDaemonConnectionPair({
        label,
        baseUrl: access.baseUrl,
      });
      const connectionCode = encodePaneRemoteConnection(
        createPaneRemoteConnectionImportPayload(pair, access.tunnel),
      );
      const buildNextConfig = (config: RemoteDaemonConfig): RemoteDaemonConfig => normalizeRemoteDaemonConfig({
        ...config,
        host: {
          ...config.host,
          access,
          clients: upsertById(config.host.clients, pair.client),
        },
      });

      await configManager.updateConfig({ remoteDaemon: buildNextConfig(current) });
      let persisted = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);

      if (!hasPersistedRemoteHostClient(persisted, pair.client)) {
        await configManager.updateConfig({ remoteDaemon: buildNextConfig(persisted) });
        persisted = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      }

      if (!hasPersistedRemoteHostClient(persisted, pair.client)) {
        throw new Error('Created remote connection code was not saved. Try again before sharing this code.');
      }

      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_code_created', {
        surface: 'desktop',
        role: 'host',
        flow: 'setup',
        result: 'succeeded',
        tunnel_kind: access.tunnel?.kind ?? 'unknown',
      });

      return {
        success: true,
        data: {
          connectionCode,
          client: pair.client,
          access,
        } satisfies RemoteHostConnectionCodeResult,
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to create remote connection code') };
    }
  });

  ipcMain.handle('remote-daemon:import-connection-code', async (_event, input: PaneCommandValue) => {
    let payload: PaneRemoteConnectionImportPayload | null = null;
    try {
      const requestInput = decodeBoundary(input, boundary.object({
        code: boundary.string,
        connect: boundary.optional(boundary.boolean),
      }));
      const code = requestInput.code.trim();
      if (code.length === 0) {
        throw new Error('Remote daemon import code is required');
      }

      const connect = requestInput.connect !== false;
      const importPayload = decodePaneRemoteConnection(code);
      payload = importPayload;
      let profile = remoteImportPayloadToProfile(importPayload);

      let connected = false;
      let connectionError: string | undefined;
      await applyRemoteClientTransition(async (current) => {
        const existingProfile = findMatchingConnectionProfile(current.client.profiles, importPayload);
        profile = remoteImportPayloadToProfile(importPayload, existingProfile?.id);

        if (connect) {
          try {
            await remotePaneClientController.activateProfile(profile);
            connected = true;
          } catch (error) {
            connectionError = getErrorMessage(error, 'Failed to connect to imported remote daemon profile');
          }
        }

        return {
          next: {
            ...current,
            client: {
              ...current.client,
              profiles: upsertById(current.client.profiles, profile),
              activeProfileId: connected ? profile.id : current.client.activeProfileId,
              mode: connected ? 'remote' : current.client.mode,
            },
          },
          resyncRenderer: connected,
        };
      });

      const importEventProperties: RemotePaneAnalyticsProperties = {
        ...getRemoteImportProperties(payload),
        result: connectionError ? 'failed' : 'succeeded',
        connected,
      };
      if (connectionError) {
        importEventProperties.failure_stage = 'connect_imported_profile';
        importEventProperties.failure_category = getRemoteFailureCategory(connectionError);
      }
      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_code_imported', importEventProperties);

      const importResult: RemoteDaemonImportResult = { profile, connected };
      if (connectionError) importResult.connectionError = connectionError;
      return {
        success: true,
        data: importResult,
      };
    } catch (error) {
      trackRemotePaneEvent(analyticsManager, 'remote_pane_connection_code_import_failed', {
        ...(payload ? getRemoteImportProperties(payload) : { surface: 'desktop', role: 'client', flow: 'connect' }),
        result: 'failed',
        failure_stage: 'import_connection_code',
        failure_category: getRemoteFailureCategory(error instanceof Error ? error.message : String(error)),
      });
      return { success: false, error: getErrorMessage(error, 'Failed to import remote daemon connection code') };
    }
  });

  ipcMain.handle('remote-daemon:update-host-config', async (_event, updates: PaneCommandValue) => {
    try {
      const decodedUpdates = decodeBoundary(updates, boundary.jsonObject);

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          config: {
            ...current.host.config,
            ...decodedUpdates,
          },
        },
      });

      const validationError = getRemoteDaemonHostConfigValidationError(next.host.config);
      if (validationError) {
        throw new Error(validationError);
      }

      await configManager.updateConfig({ remoteDaemon: next });
      return { success: true, data: next.host.config };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to update remote daemon host config') };
    }
  });

  ipcMain.handle('remote-daemon:clear-host-access', async () => {
    try {
      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          config: current.host.config,
          clients: [],
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      dependencies.disconnectActiveRemoteHostClients();
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_access_cleared', {
        surface: 'desktop',
        role: 'host',
        flow: 'maintenance',
        result: 'succeeded',
      });
      return { success: true, data: next.host };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to clear remote host access') };
    }
  });

  ipcMain.handle('remote-daemon:disconnect-host-clients', async (_event, clientIds: PaneCommandValue) => {
    try {
      const parsedClientIds = parseOptionalClientIds(clientIds);
      const disconnectedCount = dependencies.disconnectActiveRemoteHostClients(parsedClientIds);
      trackRemotePaneEvent(analyticsManager, 'remote_pane_host_clients_disconnected', {
        surface: 'desktop',
        role: 'host',
        flow: 'maintenance',
        result: 'succeeded',
        connected_client_count_bucket: getConnectedClientCountBucket(disconnectedCount),
      });
      return { success: true, data: { disconnectedCount } };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to disconnect remote daemon clients') };
    }
  });

  ipcMain.handle('remote-daemon:upsert-client-record', async (_event, record: PaneCommandValue) => {
    try {
      if (!isRemoteDaemonClientRecord(record)) {
        throw new Error('Remote daemon client record is invalid');
      }

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const clients = upsertById(current.host.clients, record);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          clients,
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      return { success: true, data: next.host.clients };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to save remote daemon client record') };
    }
  });

  ipcMain.handle('remote-daemon:delete-client-record', async (_event, clientId: PaneCommandValue) => {
    try {
      const decodedClientId = decodeBoundary(clientId, boundary.nonEmptyString);

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        host: {
          ...current.host,
          clients: current.host.clients.filter((client) => client.id !== decodedClientId),
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      dependencies.disconnectActiveRemoteHostClients([decodedClientId]);
      return { success: true, data: next.host.clients };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to delete remote daemon client record') };
    }
  });

  ipcMain.handle('remote-daemon:upsert-connection-profile', async (_event, profile: PaneCommandValue) => {
    try {
      if (!isRemotePaneConnectionProfile(profile)) {
        throw new Error('Remote daemon connection profile is invalid');
      }

      const current = getRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
      const profiles = upsertById(current.client.profiles, profile);
      const next = normalizeRemoteDaemonConfig({
        ...current,
        client: {
          ...current.client,
          profiles,
        },
      });

      await configManager.updateConfig({ remoteDaemon: next });
      return { success: true, data: next.client.profiles };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to save remote daemon connection profile') };
    }
  });

  ipcMain.handle('remote-daemon:delete-connection-profile', async (_event, profileId: PaneCommandValue) => {
    try {
      const decodedProfileId = decodeBoundary(profileId, boundary.nonEmptyString);

      const next = await applyRemoteClientTransition(async (current) => {
        const isActiveRemoteProfile = current.client.mode === 'remote' && current.client.activeProfileId === decodedProfileId;
        const activeProfileId = current.client.activeProfileId === decodedProfileId
          ? null
          : current.client.activeProfileId;
        const mode = activeProfileId ? current.client.mode : 'local';

        if (isActiveRemoteProfile) {
          await remotePaneClientController.switchToLocalMode();
        }

        return {
          next: {
            ...current,
            client: {
              ...current.client,
          profiles: current.client.profiles.filter((profile) => profile.id !== decodedProfileId),
              activeProfileId,
              mode,
            },
          },
          resyncRenderer: isActiveRemoteProfile,
        };
      });
      trackRemotePaneEvent(analyticsManager, 'remote_pane_profile_deleted', {
        surface: 'desktop',
        role: 'client',
        flow: 'maintenance',
        result: 'succeeded',
      });
      return { success: true, data: next.client };
    } catch (error) {
      return { success: false, error: getErrorMessage(error, 'Failed to delete remote daemon connection profile') };
    }
  });

  ipcMain.handle('remote-daemon:update-client-state', async (_event, updates: PaneCommandValue) => {
    try {
      const decodedUpdates = decodeBoundary(updates, boundary.jsonObject);

      const next = await applyRemoteClientTransition(async (current) => {
        const nextState = buildNextClientState(current.client, decodedUpdates);
        const candidate = normalizeRemoteDaemonConfig({
          ...current,
          client: {
            ...current.client,
            ...nextState,
          },
        });

        if (candidate.client.mode === 'remote') {
          const activeProfile = candidate.client.profiles.find((profile) => profile.id === candidate.client.activeProfileId);
          if (!activeProfile) {
            throw new Error(`Remote daemon connection profile "${candidate.client.activeProfileId}" does not exist`);
          }

          await remotePaneClientController.activateProfile(activeProfile);
        } else {
          await remotePaneClientController.switchToLocalMode();
        }

        return {
          next: candidate,
          resyncRenderer: true,
        };
      });
      return { success: true, data: next.client };
    } catch (error) {
      trackRemotePaneEvent(analyticsManager, 'remote_pane_client_connection_failed', {
        surface: 'desktop',
        role: 'client',
        flow: 'connect',
        result: 'failed',
        failure_stage: 'update_client_state',
        failure_category: getRemoteFailureCategory(error instanceof Error ? error.message : String(error)),
        client_kind: 'desktop',
      });
      return { success: false, error: getErrorMessage(error, 'Failed to update remote daemon client state') };
    }
  });
}

function parseOptionalClientIds(value: PaneCommandValue): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const clientIds = decodeBoundary(value, boundary.array(boundary.nonEmptyString))
    .map((clientId) => clientId.trim());

  return clientIds.length > 0 ? clientIds : undefined;
}

function getRemoteDaemonConfig(value: PaneCommandValue): RemoteDaemonConfig {
  return normalizeRemoteDaemonConfig(value);
}

function readOptionalConnectionCodeLabel(input: PaneCommandValue): string | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  const requestInput = decodeBoundary(input, boundary.object({
    label: boundary.optional(boundary.nullable(boundary.string)),
  }));
  if (requestInput.label === undefined || requestInput.label === null) {
    return undefined;
  }
  const label = requestInput.label.trim();
  return label.length > 0 ? label : undefined;
}

async function resolveCurrentHostAccess(
  current: RemoteDaemonConfig,
  readTailscaleAccess: typeof readConfiguredTailscaleServeAccess,
): Promise<RemoteDaemonHostAccess> {
  if (current.host.access) {
    return current.host.access;
  }

  const discoveredTailscaleAccess = await readTailscaleAccess(current.host.config.listenPort);
  if (discoveredTailscaleAccess) {
    return discoveredTailscaleAccess;
  }

  throw new Error(
    'Pane does not have the remote host access URL for this setup yet. Run the remote setup terminal once to configure Tailscale Serve, then create a connection code again.',
  );
}

function buildNextClientState(
  current: RemoteDaemonClientSettings,
  updates: JsonObject,
): Pick<RemoteDaemonClientSettings, 'activeProfileId' | 'mode'> {
  const nextMode: RemoteDaemonClientMode =
    updates.mode === 'remote' || updates.mode === 'local'
      ? updates.mode
      : current.mode;

  let nextActiveProfileId = current.activeProfileId;
  if (updates.activeProfileId === null) {
    nextActiveProfileId = null;
  } else {
    try {
      nextActiveProfileId = decodeBoundary(updates.activeProfileId, boundary.string);
    } catch {
      // Preserve the current profile when the optional update is malformed.
    }
  }

  if (nextMode === 'remote' && !nextActiveProfileId) {
    throw new Error('Remote mode requires an active connection profile');
  }

  if (nextActiveProfileId && !current.profiles.some((profile) => profile.id === nextActiveProfileId)) {
    throw new Error(`Remote daemon connection profile "${nextActiveProfileId}" does not exist`);
  }

  return {
    mode: nextActiveProfileId ? nextMode : 'local',
    activeProfileId: nextActiveProfileId,
  };
}

function attachRemoteHostStateForwarder(getMainWindow?: AppServices['getMainWindow']): void {
  if (!getMainWindow) {
    return;
  }

  if (remoteHostStateForwarder) {
    remoteHostRuntimeStateStore.off('state-changed', remoteHostStateForwarder);
  }

  remoteHostStateForwarder = (state: RemoteDaemonHostRuntimeState) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) {
      return;
    }

    window.webContents.send('remote-daemon:host-state-changed', state);
  };

  remoteHostRuntimeStateStore.on('state-changed', remoteHostStateForwarder);
}

function parseRemoteHostSetupRequest(input: PaneCommandValue): RemoteHostSetupRequest {
  if (input === undefined || input === null) {
    return {};
  }
  const requestInput = decodeBoundary(input, boundary.object({
    dataDirectoryMode: boundary.optional(boundary.nullable(boundary.string)),
    paneDir: boundary.optional(boundary.nullable(boundary.string)),
    label: boundary.optional(boundary.nullable(boundary.string)),
    listenPort: boundary.optional(boundary.nullable(boundary.union(boundary.number, boundary.string))),
    channel: boundary.optional(boundary.nullable(boundary.string)),
    repoRef: boundary.optional(boundary.nullable(boundary.string)),
    installService: boundary.optional(boundary.nullable(boundary.boolean)),
    exposeTailscale: boundary.optional(boundary.nullable(boundary.boolean)),
    preferTunnel: boundary.optional(boundary.nullable(boundary.string)),
    baseUrl: boundary.optional(boundary.nullable(boundary.string)),
  }));

  const request: RemoteHostSetupRequest = {};
  const dataDirectoryMode = readOptionalDataDirectoryMode(requestInput.dataDirectoryMode);
  if (dataDirectoryMode) {
    request.dataDirectoryMode = dataDirectoryMode;
  }

  const paneDir = readOptionalTrimmedString(requestInput.paneDir);
  if (paneDir) {
    request.paneDir = paneDir;
  }

  const label = readOptionalTrimmedString(requestInput.label);
  if (label) {
    request.label = label;
  }

  const listenPort = readOptionalPort(requestInput.listenPort);
  if (listenPort !== undefined) {
    request.listenPort = listenPort;
  }

  const channel = readOptionalChannel(requestInput.channel);
  if (channel) {
    request.channel = channel;
  }

  const repoRef = readOptionalTrimmedString(requestInput.repoRef);
  if (repoRef) {
    request.repoRef = repoRef;
  }

  const installService = decodeOptionalBoolean(requestInput.installService);
  if (installService !== undefined) request.installService = installService;
  const exposeTailscale = decodeOptionalBoolean(requestInput.exposeTailscale);
  if (exposeTailscale !== undefined) request.exposeTailscale = exposeTailscale;

  const preferTunnel = readOptionalTunnelPreference(requestInput.preferTunnel);
  if (preferTunnel) {
    request.preferTunnel = preferTunnel;
  }

  const baseUrl = readOptionalTrimmedString(requestInput.baseUrl);
  if (baseUrl) {
    normalizePaneRemoteConnectionImportPayload({
      v: 1,
      label: 'Remote setup validation',
      baseUrl,
      token: 'remote-setup-validation-token',
      transport: 'http+sse',
    });
    request.baseUrl = baseUrl;
  }

  return request;
}

function buildInteractiveSetupCommand(
  request: RemoteHostSetupRequest,
  isPackaged: boolean,
  shellName?: string,
): string {
  const dataDirectoryMode = request.dataDirectoryMode ?? 'current';
  const useCurrentDataDirectory = dataDirectoryMode === 'current';
  const args = [
    '--interactive-tailscale-setup',
    '--auto-listen-port',
    '--prefer-tunnel',
    request.preferTunnel ?? 'tailscale',
  ];

  const paneDir = useCurrentDataDirectory ? getAppDirectory() : request.paneDir;
  if (paneDir) {
    args.push('--pane-dir', paneDir);
  }
  if (request.label) {
    args.push('--label', request.label);
  }
  if (request.listenPort !== undefined) {
    args.push('--listen-port', String(request.listenPort));
  }
  if (request.channel) {
    args.push('--channel', request.channel);
  }
  if (request.repoRef) {
    args.push('--repo-ref', request.repoRef);
  }
  if (request.baseUrl) {
    args.push('--base-url', request.baseUrl);
  }
  if (request.exposeTailscale === false) {
    args.push('--no-tailscale-serve');
  }
  if (useCurrentDataDirectory || request.installService === false) {
    args.push('--no-install-service');
  }

  const quotedArgs = args.map((arg) => quoteTerminalArg(arg, shellName)).join(' ');
  if (isPackaged) {
    const executable = quoteTerminalArg(process.execPath, shellName);
    const invokePrefix = shellName === 'powershell' || shellName === 'pwsh' ? '& ' : '';
    return `${invokePrefix}${executable} --remote-setup ${quotedArgs}`;
  }

  const setupScript = path.resolve(process.cwd(), 'scripts', 'pane-remote-setup.js');
  return `node ${quoteTerminalArg(setupScript, shellName)} ${quotedArgs}`;
}

function buildInteractiveClientSetupCommand(shellName?: string): string {
  if (process.platform === 'win32') {
    const powershellCommand = [
      "$ErrorActionPreference = 'Stop'",
      'if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) { winget install --id Tailscale.Tailscale --exact --accept-package-agreements --accept-source-agreements }',
      'tailscale up',
    ].join('; ');

    if (shellName === 'powershell' || shellName === 'pwsh') {
      return powershellCommand;
    }

    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ${quoteTerminalArg(powershellCommand, shellName)}`;
  }

  if (process.platform === 'darwin') {
    return [
      'TAILSCALE_CLI="$(command -v tailscale || true)"',
      'if [ -z "$TAILSCALE_CLI" ] && [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then TAILSCALE_CLI="/Applications/Tailscale.app/Contents/MacOS/Tailscale"; fi',
      'if [ -z "$TAILSCALE_CLI" ] && command -v brew >/dev/null 2>&1; then brew install tailscale && TAILSCALE_CLI="$(command -v tailscale || true)"; fi',
      'if [ -z "$TAILSCALE_CLI" ]; then echo "Tailscale CLI is not available. Install Tailscale from https://tailscale.com/download, enable CLI integration in the Tailscale app, then retry."; exit 1; fi',
      'if command -v brew >/dev/null 2>&1 && brew list --formula tailscale >/dev/null 2>&1; then sudo brew services start tailscale || brew services start tailscale || true; fi',
      'TAILSCALE_BE_CLI=1 "$TAILSCALE_CLI" up || sudo env TAILSCALE_BE_CLI=1 "$TAILSCALE_CLI" up',
    ].join(' && ');
  }

  if (process.platform === 'linux') {
    return '(command -v tailscale >/dev/null 2>&1 || curl -fsSL https://tailscale.com/install.sh | sh) && sudo tailscale up';
  }

  return 'echo "Install Tailscale from https://tailscale.com/download, sign in, then retry the Pane remote connection."';
}

function readOptionalTrimmedString(value: PaneCommandValue): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = decodeBoundary(value, boundary.string).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function quoteTerminalArg(value: string, shellName?: string): string {
  if (process.platform === 'win32' && shellName !== 'gitbash') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readOptionalPort(value: PaneCommandValue): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const decoded = decodeBoundary(value, boundary.union(boundary.number, boundary.string));
  const port = Number(decoded);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Remote daemon listen port must be between 1 and 65535');
  }
  return port;
}

function readOptionalDataDirectoryMode(value: PaneCommandValue): RemoteSetupDataDirectoryMode | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'current' || value === 'isolated') {
    return value;
  }
  throw new Error('Remote daemon data directory mode must be "current" or "isolated"');
}

function readOptionalChannel(value: PaneCommandValue): RemoteSetupChannel | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'stable' || value === 'nightly') {
    return value;
  }
  throw new Error('Remote daemon setup channel must be "stable" or "nightly"');
}

function readOptionalTunnelPreference(value: PaneCommandValue): RemoteSetupTunnelPreference | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'auto' || value === 'tailscale' || value === 'ssh' || value === 'manual') {
    return value;
  }
  throw new Error('Remote daemon tunnel preference must be "auto", "tailscale", "ssh", or "manual"');
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) {
    return [...items, nextItem];
  }

  return items.map((item, index) => (index === existingIndex ? nextItem : item));
}

function hasPersistedRemoteHostClient(
  config: RemoteDaemonConfig,
  client: RemoteDaemonClientRecord,
): boolean {
  return config.host.clients.some((candidate) => (
    candidate.id === client.id &&
    candidate.tokenHash === client.tokenHash
  ));
}

function findMatchingConnectionProfile(
  profiles: RemoteDaemonClientSettings['profiles'],
  payload: PaneRemoteConnectionImportPayload,
): RemoteDaemonClientSettings['profiles'][number] | undefined {
  return profiles.find((profile) => (
    profile.baseUrl === payload.baseUrl &&
    profile.token === payload.token &&
    profile.transport === payload.transport
  ));
}

function decodeOptionalBoolean(value: PaneCommandValue): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return decodeBoundary(value, boundary.boolean);
}

function getErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
