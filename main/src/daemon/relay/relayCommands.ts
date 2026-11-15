import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../commandRegistry';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../../shared/paneError';
import { normalizeRemoteDaemonConfig, type RemoteRelaySettings } from '../../../../shared/types/remoteDaemon';
import type { ConfigManager } from '../../services/configManager';
import type { RelayService } from './relayService';
import type { ComputerLinking } from './computerLinking';
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
  /** Local only: `{link}` → `LinkPreview`, without spending the link. */
  linkPreview: 'relay:link-preview',
  /** Local only: `{link}` → `LinkRedeemResult`. The client asks the person first when `needsConfirm`. */
  redeemLink: 'relay:redeem-link',
} as const;

const callerSchema = boundary.object({ clientId: boundary.nonEmptyString });
const previewTargetSchema = boundary.union(
  boundary.object({ port: boundary.number }),
  boundary.object({ files: boundary.nonEmptyString }),
);

const peerRequestSchema = boundary.object({ peer: relayComputerSchema });
const linkRequestSchema = boundary.object({ link: boundary.nonEmptyString });
const pairingCodeSchema = boundary.optional(boundary.object({ expiresIn: boundary.optional(boundary.enumeration('10m', '1h', '24h')) }));

function onThisComputerOnly(): void {
  if (isRemotePaneCommand()) {
    throw new PaneError(
      'ERR_RELAY_LOCAL_ONLY',
      'Phone access can be changed only on the computer itself, so nothing changed.',
      'Open Pane on that computer: Settings › Remote Access.',
    );
  }
}

/** How long a link waits for phone access to start: connecting and, the first time, getting a certificate. */
const RELAY_READY_TIMEOUT_MS = 120_000;

export function registerRelayCommands(
  registry: PaneCommandRegistry,
  relay: Pick<RelayService, 'getStatus' | 'createPairingCode' | 'computerInfo'>,
  previews: RelayPreviews,
  links: RelayLinks,
  linking: ComputerLinking,
  configManager: Pick<ConfigManager, 'updateConfigWith'>,
): void {
  registry.register(RELAY_COMMANDS.status, () => relay.getStatus());

  // Turning phone access on also turns on the pairing listener the relay forwards to.
  const setEnabled = (on: boolean) => configManager.updateConfigWith((current) => {
    const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
    return {
      remoteDaemon: {
        ...remote,
        host: on ? { ...remote.host, config: { ...remote.host.config, enabled: true, pairingRequired: true } } : remote.host,
        relay: { ...remote.relay, enabled: on },
      },
    };
    });
  registry.register(RELAY_COMMANDS.setEnabled, async (enabled: PaneCommandValue) => {
    onThisComputerOnly();
    await setEnabled(decodeBoundary(enabled, boundary.boolean));
    return relay.getStatus();
  });

  /** Links are made over the relay: a computer with phone access off (one with no screen, say) turns it on and waits for it. */
  const relayReady = async (): Promise<void> => {
    if (relay.computerInfo()) return;
    await setEnabled(true);
    const deadline = Date.now() + RELAY_READY_TIMEOUT_MS;
    for (;;) {
      const status = relay.getStatus();
      if (status.phase === 'ready' && relay.computerInfo()) return;
      if (status.phase === 'error' || Date.now() > deadline) {
        throw new PaneError(
          'ERR_RELAY_NOT_READY',
          `Phone access did not get ready on this computer${status.lastError ? `: ${status.lastError}` : ''}, so the link was not used.`,
          'Check this computer can reach the internet, then run the same command again; the link still works until it expires.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

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

  // No argument: a 10-minute QR code shown on screen. A copied link names its lifetime.
  registry.register(RELAY_COMMANDS.pairingCode, (request: PaneCommandValue) => {
    onThisComputerOnly();
    return relay.createPairingCode(decodeBoundary(request ?? undefined, pairingCodeSchema)?.expiresIn ?? '10m');
  });
  registry.register(RELAY_COMMANDS.linkPreview, (request: PaneCommandValue) => {
    onThisComputerOnly();
    return linking.preview(decodeBoundary(request, linkRequestSchema).link);
  });
  registry.register(RELAY_COMMANDS.redeemLink, async (request: PaneCommandValue) => {
    onThisComputerOnly();
    const { link } = decodeBoundary(request, linkRequestSchema);
    await relayReady();
    return linking.redeem(link);
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
  registry.register(RELAY_COMPUTER_COMMANDS.grantComputer, (request: PaneCommandValue, from: PaneCommandValue) => (
    links.grantComputer(decodeBoundary(request, peerRequestSchema).peer, caller(from))
  ));
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
