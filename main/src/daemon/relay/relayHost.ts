import os from 'os';
import { normalizeRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { getPaneEventSink } from '../../core/runtime';
import { systemSecretBackend } from '../../services/paneSecrets';
import { KeychainItemMissing } from '../../services/keychain';
import type { ConfigManager } from '../../services/configManager';
import type { PaneCommandRegistry } from '../commandRegistry';
import { servePreviews, type PreviewFiles, type PreviewProxy } from '../previewProxy';
import type { PairingRoute } from '../httpApiServer';
import { registerRelayCommands } from './relayCommands';
import { RelayPreviews } from './relayPreviews';
import { RelayService, type RelaySecretStore } from './relayService';
import { createComputerCaller, RelayLinks } from './relayLinks';
import { disconnectActiveRemoteHostClients } from '../remoteTransportController';
import { remoteHostRuntimeStateStore } from '../remoteHostRuntimeState';
import { readFileSync } from 'fs';
import { setRelayPushChannel } from '../mobilePushSender';

export interface RelayHost {
  service: RelayService;
  links: RelayLinks;
  previews: RelayPreviews;
  pairing: PairingRoute;
  suspend(): void;
  resume(): void;
  stop(): Promise<void>;
}

/** A secret that was never stored reads as null; any other failure (a locked keychain) is thrown, so the key is never replaced by mistake. */
function relaySecrets(dataDir: string): RelaySecretStore {
  const backend = systemSecretBackend(dataDir);
  return {
    async read(key) {
      try {
        return await backend.read(key);
      } catch (error) {
        if (error instanceof KeychainItemMissing || (error instanceof Error && error.message.startsWith('No value is stored'))) return null;
        throw error;
      }
    },
    write: (key, value) => backend.write(key, value),
  };
}

function computerDisplayName(): string {
  return os.hostname().replace(/\.local$/iu, '');
}

/** Phone access through the relay: the service, previews under the computer's names, and its commands. */
export async function createRelayHost(deps: {
  commandRegistry: PaneCommandRegistry;
  configManager: ConfigManager;
  dataDir: string;
  isForwardedPort(port: number): boolean;
  files: PreviewFiles;
  log(line: string): void;
}): Promise<RelayHost> {
  const { configManager } = deps;
  const remote = () => configManager.getConfig().remoteDaemon;
  let service: RelayService | null = null;
  const previews = new RelayPreviews({
    id: () => service?.getStatus().id ?? null,
    domain: () => service?.getStatus().domain ?? null,
    isForwardedPort: deps.isForwardedPort,
    clientActive: (clientId) => remote()?.host.clients.some((client) => client.id === clientId) ?? false,
  });
  let proxy: PreviewProxy | null = null;
  service = new RelayService({
    settings: () => remote()?.relay,
    onSettingsChanged: (listener) => {
      configManager.on('config-updated', listener);
      return () => configManager.off('config-updated', listener);
    },
    secrets: relaySecrets(deps.dataDir),
    dataDir: deps.dataDir,
    serverPort: () => {
      const host = remote()?.host.config;
      return host?.enabled ? host.listenPort : null;
    },
    previewPort: () => proxy?.port ?? null,
    displayName: computerDisplayName,
    addClient: async (record) => {
      // Pairing the same phone again replaces its earlier token here.
      const replaced = (remote()?.host.clients ?? []).filter((client) => client.kind === undefined && record.phoneId !== undefined && client.phoneId === record.phoneId).map((client) => client.id);
      await configManager.updateConfigWith((current) => {
        const config = normalizeRemoteDaemonConfig(current.remoteDaemon);
        return { remoteDaemon: { ...config, host: { ...config.host, clients: [...config.host.clients.filter((client) => !replaced.includes(client.id)), record] } } };
      });
      if (replaced.length) disconnectActiveRemoteHostClients(replaced);
    },
    log: deps.log,
  });
  const relay = service;
  const dial = process.env.PANE_RELAY_DIAL ? /^(.+):(\d+)$/u.exec(process.env.PANE_RELAY_DIAL) : null;
  const links = new RelayLinks({
    config: configManager,
    self: () => relay.computerInfo(),
    call: createComputerCaller({
      dial: dial ? { host: dial[1], port: Number(dial[2]) } : undefined,
      extraCa: process.env.PANE_RELAY_EXTRA_CA ? readFileSync(process.env.PANE_RELAY_EXTRA_CA, 'utf8') : undefined,
    }),
    disconnect: (ids) => {
      disconnectActiveRemoteHostClients(ids);
      for (const id of ids) previews.revokeClient(id);
    },
    connectedClientIds: () => new Set(remoteHostRuntimeStateStore.getState().connectedClients.map((client) => client.clientId).filter((id): id is string => id !== null)),
    log: deps.log,
  });
  proxy = await servePreviews(previews.route, deps.files);
  registerRelayCommands(deps.commandRegistry, relay, previews, links, configManager);
  relay.onStatus((status) => getPaneEventSink().send('relay:status-changed', status));
  relay.onPaired((event) => getPaneEventSink().send('relay:paired', event));
  relay.start();
  // A computer without the Pane app's push keys sends its phones' alerts through its relay.
  setRelayPushChannel({ available: () => relay.isOnline(), send: (alert) => relay.sendAlert(alert) });
  return {
    service: relay,
    previews,
    links,
    pairing: {
      exchange: async ({ secret, label, phoneId }) => {
        const result = await relay.exchangeSecret(secret, label, phoneId);
        if (!result.ok) return result;
        return { ...result, linked: await links.grantsFor({ label: result.client.label, phoneId }, []) };
      },
    },
    suspend: () => relay.suspend(),
    resume: () => relay.resume(),
    stop: async () => {
      setRelayPushChannel(null);
      await relay.stop();
      await proxy?.close();
    },
  };
}
