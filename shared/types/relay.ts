/** Phone access through a relay (QR pairing), as Remote Access shows it. */
export interface RelayStatus {
  enabled: boolean;
  /** off; connecting to the relay; getting the certificate; ready to pair; or stuck with `lastError`. */
  phase: 'off' | 'connecting' | 'certificate' | 'ready' | 'error';
  /** This computer's id under the relay domain. */
  id: string | null;
  domain: string | null;
  /** `https://<id>.<domain>` */
  address: string | null;
  /** The relay host this computer is connected to. */
  relay: string | null;
  region: string | null;
  /** Same-network addresses phones try first. */
  localAddresses: string[];
  certificate: { notBefore: string; notAfter: string; renewAt: string } | null;
  lastError: string | null;
}

/** A one-time QR: `https://<domain>/pair#s=<secret>&c=<id>&n=<name>`, good for 10 minutes and one scan. */
export interface RelayPairingInfo {
  url: string;
  expiresAt: string;
}

/** What a paired phone or computer stores about a computer reached through a relay. */
export interface RelayComputer {
  /** The id under the relay domain. */
  id: string;
  name: string;
  domain: string;
  /** `https://<id>.<domain>` */
  address: string;
  /** Same-network addresses, tried before the relay. */
  local: string[];
  /** base64url SHA-256 of the computer's public key (SPKI DER); the Pane app and desktop check it. */
  fingerprint: string;
  /** The computer's direct QUIC endpoint (`pane-direct`); absent while it has none. */
  direct?: RelayDirectEndpoint;
}

/** Where `pane-direct connect` finds a computer: its node id, its addresses, and the relays that introduce the two ends. */
export interface RelayDirectEndpoint {
  /** iroh node id (the endpoint's public key). */
  nodeId: string;
  /** `ip:port` addresses the computer's endpoint listens on. */
  addrs: string[];
  /** iroh relay URLs that carry traffic until a direct path opens. */
  relayUrls: string[];
}

/** A computer with a token for the caller, handed out by one of its linked computers. */
export interface RelayComputerGrant {
  computer: RelayComputer;
  token: string;
}

/** `POST /pair/exchange` body. `phoneId` is the app's stable install id, so "Remove from all your computers" finds the phone everywhere. */
export interface RelayExchangeRequest {
  secret: string;
  label: string;
  phoneId?: string;
}

/** `POST /pair/exchange` answer: the token, this computer, and tokens for every computer linked with it. */
export interface RelayExchangeResult {
  ok: true;
  token: string;
  clientId: string;
  computer: RelayComputer;
  linked: RelayComputerGrant[];
}

/** Commands a paired phone (or linked computer) calls on a computer over `/invoke`. */
export const RELAY_CLIENT_COMMANDS = {
  /** `{port}` or `{files: path}` → `{url}` with a one-time ticket. */
  previewAddress: 'relay:client:preview-address',
  /** → `RelayComputer` for this computer. */
  computer: 'relay:client:computer',
  /** `{known: string[]}` → `RelayComputerGrant[]`: linked computers, with new tokens for those not in `known`. */
  computers: 'relay:client:computers',
  /** `{peer: RelayComputer}` → `{token}`: a token the peer computer uses to call this one. */
  mintLink: 'relay:client:mint-link',
  /** `{peer: RelayComputer, token}`: saves the peer as a linked computer, with the token to call it. */
  saveLink: 'relay:client:save-link',
} as const;

/** How Remote Access › Devices lists a paired phone or linked computer. */
export interface RelayDevice {
  /** The client record id on this computer. */
  clientId: string;
  kind: 'phone' | 'computer';
  label: string;
  /** "Linked by <phone>": the phone whose scan linked it; absent when paired here directly. */
  linkedBy?: string;
  /** Computers only: its relay id. */
  computerId?: string;
  connected: boolean;
  createdAt: string;
}

/** Local IPC (desktop only) for the Devices list and the everywhere actions. */
export const RELAY_DEVICE_COMMANDS = {
  /** → `RelayDevice[]` */
  list: 'relay:devices',
  /** `{clientId}` → `{removed: string[], notReached: string[]}` (computer names). */
  removePhoneEverywhere: 'relay:remove-phone-everywhere',
  /** `{computerId}` → `{removed: string[], notReached: string[]}` */
  unlinkComputerEverywhere: 'relay:unlink-computer-everywhere',
} as const;
