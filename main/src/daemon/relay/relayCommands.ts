import { isRemotePaneCommand, type PaneCommandRegistry } from '../commandRegistry';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';
import { normalizeRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { ConfigManager } from '../../services/configManager';
import type { RelayService } from './relayService';
import type { RelayPreviews } from './relayPreviews';

export const RELAY_COMMANDS = {
  status: 'relay:status',
  setEnabled: 'relay:set-enabled',
  setAddress: 'relay:set-address',
  pairingCode: 'relay:pairing-code',
  previewAddress: 'relay:client:preview-address',
  computer: 'relay:client:computer',
} as const;

const callerSchema = boundary.object({ clientId: boundary.nonEmptyString });
const previewTargetSchema = boundary.union(
  boundary.object({ port: boundary.number }),
  boundary.object({ files: boundary.nonEmptyString }),
);

function onThisComputerOnly(): void {
  if (isRemotePaneCommand()) {
    throw new PaneError(
      'ERR_RELAY_LOCAL_ONLY',
      'Phone access can be changed only on the computer itself, so nothing changed.',
      'Open Pane on that computer: Settings › Remote Access.',
    );
  }
}

export function registerRelayCommands(
  registry: PaneCommandRegistry,
  relay: RelayService,
  previews: RelayPreviews,
  configManager: Pick<ConfigManager, 'updateConfigWith'>,
): void {
  registry.register(RELAY_COMMANDS.status, () => relay.getStatus());

  // Turning phone access on also turns on the pairing listener the relay forwards to.
  registry.register(RELAY_COMMANDS.setEnabled, async (enabled: unknown) => {
    onThisComputerOnly();
    const on = decodeBoundary(enabled, boundary.boolean);
    await configManager.updateConfigWith((current) => {
      const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
      return {
        remoteDaemon: {
          ...remote,
          host: on ? { ...remote.host, config: { ...remote.host.config, enabled: true, pairingRequired: true } } : remote.host,
          relay: { ...remote.relay, enabled: on },
        },
      };
    });
    return relay.getStatus();
  });

  registry.register(RELAY_COMMANDS.setAddress, async (address: unknown) => {
    onThisComputerOnly();
    const value = decodeBoundary(address, boundary.nullable(boundary.string))?.trim() || undefined;
    if (value && !/^[a-z0-9.-]+(:\d{1,5})?$/iu.test(value)) {
      throw new PaneError('ERR_RELAY_ADDRESS_INVALID', `"${value}" is not a relay address.`, 'Enter a host name, such as relay.example.com, optionally with :port.');
    }
    await configManager.updateConfigWith((current) => {
      const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
      const enabled = remote.relay?.enabled ?? false;
      return { remoteDaemon: { ...remote, relay: { enabled, ...(value ? { relayAddress: value } : {}) } } };
    });
    return relay.getStatus();
  });

  registry.register(RELAY_COMMANDS.pairingCode, () => {
    onThisComputerOnly();
    return relay.createPairingCode();
  });

  // Called by paired phones; the HTTP server supplies the caller.
  registry.register(RELAY_COMMANDS.previewAddress, (target: unknown, caller: unknown) => {
    const { clientId } = decodeBoundary(caller, callerSchema);
    return { url: previews.address(decodeBoundary(target, previewTargetSchema), clientId) };
  });

  registry.register(RELAY_COMMANDS.computer, () => relay.computerInfo() ?? null);
}
