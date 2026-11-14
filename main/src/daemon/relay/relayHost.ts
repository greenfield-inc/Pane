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

export interface RelayHost {
  service: RelayService;
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

export function computerDisplayName(): string {
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
      await configManager.updateConfigWith((current) => {
        const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
        return { remoteDaemon: { ...remote, host: { ...remote.host, clients: [...remote.host.clients, record] } } };
      });
    },
    log: deps.log,
  });
  const relay = service;
  proxy = await servePreviews(previews.route, deps.files);
  registerRelayCommands(deps.commandRegistry, relay, previews, configManager);
  relay.onStatus((status) => getPaneEventSink().send('relay:status-changed', status));
  relay.onPaired((event) => getPaneEventSink().send('relay:paired', event));
  relay.start();
  return {
    service: relay,
    previews,
    pairing: { exchange: (secret, label) => relay.exchangeSecret(secret, label) },
    suspend: () => relay.suspend(),
    resume: () => relay.resume(),
    stop: async () => {
      await relay.stop();
      await proxy?.close();
    },
  };
}
