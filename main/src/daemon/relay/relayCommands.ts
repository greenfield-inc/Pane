import { isRemotePaneCommand, type PaneCommandRegistry } from '../commandRegistry';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';
import { normalizeRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import type { ConfigManager } from '../../services/configManager';
import type { RelayService } from './relayService';
import type { RelayPreviews } from './relayPreviews';
import { RELAY_COMPUTER_COMMANDS, type RelayLinks } from './relayLinks';
import { RELAY_CLIENT_COMMANDS, RELAY_DEVICE_COMMANDS, type RelayComputer } from '../../../../shared/types/relay';

export const RELAY_COMMANDS = {
  status: 'relay:status',
  setEnabled: 'relay:set-enabled',
  setAddress: 'relay:set-address',
  pairingCode: 'relay:pairing-code',
} as const;

const callerSchema = boundary.object({ clientId: boundary.nonEmptyString });
const previewTargetSchema = boundary.union(
  boundary.object({ port: boundary.number }),
  boundary.object({ files: boundary.nonEmptyString }),
);

const computerSchema: BoundarySchema<RelayComputer> = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  domain: boundary.nonEmptyString,
  address: boundary.nonEmptyString,
  local: boundary.array(boundary.string),
  fingerprint: boundary.nonEmptyString,
});
const peerRequestSchema = boundary.object({ peer: computerSchema });

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
  links: RelayLinks,
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

  // Called by paired phones and linked computers; the HTTP server supplies the caller.
  const caller = (value: unknown) => decodeBoundary(value, callerSchema).clientId;
  registry.register(RELAY_CLIENT_COMMANDS.previewAddress, (target: unknown, from: unknown) => (
    { url: previews.address(decodeBoundary(target, previewTargetSchema), caller(from)) }
  ));
  registry.register(RELAY_CLIENT_COMMANDS.computer, () => relay.computerInfo() ?? null);
  registry.register(RELAY_CLIENT_COMMANDS.computers, (request: unknown, from: unknown) => {
    const { known } = decodeBoundary(request ?? { known: [] }, boundary.object({ known: boundary.array(boundary.string) }));
    return links.computersFor(caller(from), known);
  });
  registry.register(RELAY_CLIENT_COMMANDS.mintLink, (request: unknown, from: unknown) => (
    links.mintLink(decodeBoundary(request, peerRequestSchema).peer, caller(from))
  ));
  registry.register(RELAY_CLIENT_COMMANDS.saveLink, async (request: unknown, from: unknown) => {
    const { peer, token } = decodeBoundary(request, boundary.object({ peer: computerSchema, token: boundary.nonEmptyString }));
    await links.saveLink(peer, token, caller(from));
    return null;
  });
  registry.register(RELAY_COMPUTER_COMMANDS.grantPhone, (request: unknown, from: unknown) => {
    const phone = decodeBoundary(request, boundary.object({ label: boundary.string, phoneId: boundary.optional(boundary.string) }));
    return links.grantPhone(phone, caller(from));
  });
  registry.register(RELAY_COMPUTER_COMMANDS.removePhone, async (request: unknown, from: unknown) => {
    await links.removePhone(decodeBoundary(request, boundary.object({ phoneId: boundary.nonEmptyString })).phoneId, caller(from));
    return null;
  });
  registry.register(RELAY_COMPUTER_COMMANDS.forgetComputer, async (request: unknown, from: unknown) => {
    await links.forgetComputer(decodeBoundary(request, boundary.object({ computerId: boundary.nonEmptyString })).computerId, caller(from));
    return null;
  });

  // Desktop only: Remote Access › Devices.
  registry.register(RELAY_DEVICE_COMMANDS.list, () => {
    onThisComputerOnly();
    return links.devices();
  });
  registry.register(RELAY_DEVICE_COMMANDS.removePhoneEverywhere, (request: unknown) => {
    onThisComputerOnly();
    return links.removePhoneEverywhere(decodeBoundary(request, boundary.object({ clientId: boundary.nonEmptyString })).clientId);
  });
  registry.register(RELAY_DEVICE_COMMANDS.unlinkComputerEverywhere, (request: unknown) => {
    onThisComputerOnly();
    return links.unlinkComputerEverywhere(decodeBoundary(request, boundary.object({ computerId: boundary.nonEmptyString })).computerId);
  });
}
