import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../commandRegistry';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';
import { normalizeRemoteDaemonConfig, type RemoteRelaySettings } from '../../../../shared/types/remoteDaemon';
import type { ConfigManager } from '../../services/configManager';
import type { RelayService } from './relayService';
import type { RelayPreviews } from './relayPreviews';
import { RELAY_COMPUTER_COMMANDS, relayComputerSchema, type RelayLinks } from './relayLinks';
import { RELAY_CLIENT_COMMANDS, RELAY_DEVICE_COMMANDS } from '../../../../shared/types/relay';

const RELAY_COMMANDS = {
  status: 'relay:status',
  setEnabled: 'relay:set-enabled',
  setAddress: 'relay:set-address',
  pairingCode: 'relay:pairing-code',
  /** Local only: linked computers with the tokens to call them, for `runpane workspace`. */
  linkedComputers: 'relay:linked-computers',
} as const;

const callerSchema = boundary.object({ clientId: boundary.nonEmptyString });
const previewTargetSchema = boundary.union(
  boundary.object({ port: boundary.number }),
  boundary.object({ files: boundary.nonEmptyString }),
);

const peerRequestSchema = boundary.object({ peer: relayComputerSchema });

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
  registry.register(RELAY_COMMANDS.setEnabled, async (enabled: PaneCommandValue) => {
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

  registry.register(RELAY_COMMANDS.setAddress, async (address: PaneCommandValue) => {
    onThisComputerOnly();
    const value = decodeBoundary(address, boundary.nullable(boundary.string))?.trim() || undefined;
    if (value && !/^[a-z0-9.-]+(:\d{1,5})?$/iu.test(value)) {
      throw new PaneError('ERR_RELAY_ADDRESS_INVALID', `"${value}" is not a relay address.`, 'Enter a host name, such as relay.example.com, optionally with :port.');
    }
    await configManager.updateConfigWith((current) => {
      const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
      const relaySettings: RemoteRelaySettings = { enabled: remote.relay?.enabled ?? false };
      if (value) relaySettings.relayAddress = value;
      return { remoteDaemon: { ...remote, relay: relaySettings } };
    });
    return relay.getStatus();
  });

  registry.register(RELAY_COMMANDS.pairingCode, () => {
    onThisComputerOnly();
    return relay.createPairingCode();
  });

  // Called by paired phones and linked computers; the HTTP server supplies the caller.
  const caller = (value: PaneCommandValue) => decodeBoundary(value, callerSchema).clientId;
  registry.register(RELAY_CLIENT_COMMANDS.previewAddress, (target: PaneCommandValue, from: PaneCommandValue) => (
    { url: previews.address(decodeBoundary(target, previewTargetSchema), caller(from)) }
  ));
  registry.register(RELAY_CLIENT_COMMANDS.computer, () => relay.computerInfo() ?? null);
  registry.register(RELAY_CLIENT_COMMANDS.computers, (request: PaneCommandValue, from: PaneCommandValue) => {
    const { known } = decodeBoundary(request ?? { known: [] }, boundary.object({ known: boundary.array(boundary.string) }));
    return links.computersFor(caller(from), known);
  });
  registry.register(RELAY_CLIENT_COMMANDS.mintLink, (request: PaneCommandValue, from: PaneCommandValue) => (
    links.mintLink(decodeBoundary(request, peerRequestSchema).peer, caller(from))
  ));
  registry.register(RELAY_CLIENT_COMMANDS.saveLink, async (request: PaneCommandValue, from: PaneCommandValue) => {
    const { peer, token } = decodeBoundary(request, boundary.object({ peer: relayComputerSchema, token: boundary.nonEmptyString }));
    await links.saveLink(peer, token, caller(from));
    return null;
  });
  registry.register(RELAY_COMPUTER_COMMANDS.grantPhone, (request: PaneCommandValue, from: PaneCommandValue) => {
    const phone = decodeBoundary(request, boundary.object({ label: boundary.string, phoneId: boundary.optional(boundary.string) }));
    return links.grantPhone(phone, caller(from));
  });
  registry.register(RELAY_COMPUTER_COMMANDS.removePhone, async (request: PaneCommandValue, from: PaneCommandValue) => {
    await links.removePhone(decodeBoundary(request, boundary.object({ phoneId: boundary.nonEmptyString })).phoneId, caller(from));
    return null;
  });
  registry.register(RELAY_COMPUTER_COMMANDS.forgetComputer, async (request: PaneCommandValue, from: PaneCommandValue) => {
    await links.forgetComputer(decodeBoundary(request, boundary.object({ computerId: boundary.nonEmptyString })).computerId, caller(from));
    return null;
  });

  registry.register(RELAY_COMMANDS.linkedComputers, () => {
    onThisComputerOnly();
    return links.linked().map((profile) => ({
      id: profile.relay.computerId,
      name: profile.label,
      address: profile.baseUrl,
      token: profile.token,
      fingerprint: profile.relay.fingerprint,
    }));
  });

  // Desktop only: Remote Access › Devices.
  registry.register(RELAY_DEVICE_COMMANDS.list, () => {
    onThisComputerOnly();
    return links.devices();
  });
  registry.register(RELAY_DEVICE_COMMANDS.removePhoneEverywhere, (request: PaneCommandValue) => {
    onThisComputerOnly();
    return links.removePhoneEverywhere(decodeBoundary(request, boundary.object({ clientId: boundary.nonEmptyString })).clientId);
  });
  registry.register(RELAY_DEVICE_COMMANDS.unlinkComputerEverywhere, (request: PaneCommandValue) => {
    onThisComputerOnly();
    return links.unlinkComputerEverywhere(decodeBoundary(request, boundary.object({ computerId: boundary.nonEmptyString })).computerId);
  });
}
