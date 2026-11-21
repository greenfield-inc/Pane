import type { ComputerRoutesReport } from './remoteComputers';

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
  /**
   * Set while this computer has no certificate because the CA is turning away new computers
   * (Let's Encrypt's weekly limit): `until` is when it takes them again. New phones and computers
   * can't pair through the relay until then; Tailscale is unaffected.
   */
  certificateLimit: { until: string } | null;
}

/** How long a one-time link lasts, chosen when it is made. A QR code shown on screen lasts 10 minutes. */
export type RelayLinkLifetime = '10m' | '1h' | '24h';

/** A one-time link or QR: `https://<domain>/pair#s=<secret>&c=<id>&n=<name>`, good for one use until `expiresAt`. */
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

/** A computer redeeming a link: who it is, its routes, and a token it made for the link's maker to call it. */
export interface RelayComputerOffer {
  computer: RelayComputer;
  routes?: ComputerRoutesReport;
  token: string;
}

/** `POST /pair/exchange` body. `phoneId` is the app's stable install id, so "Remove from all your computers" finds the phone everywhere. */
export interface RelayExchangeRequest {
  secret: string;
  label: string;
  phoneId?: string;
  /** Computer ids the app already has a token for. Linked computers among them hand out no new token, which would replace the app's. */
  known?: string[];
  /** Set when a computer redeems the link: the maker saves it as a computer, not a phone. */
  computer?: RelayComputerOffer;
}

/** `POST /pair/exchange` answer: the token, this computer, and tokens for every computer linked with it. */
export interface RelayExchangeResult {
  ok: true;
  token: string;
  clientId: string;
  computer: RelayComputer;
  linked: RelayComputerGrant[];
  /** To a computer only: the maker's own routes, so the redeemer saves every way to reach it. */
  routes?: ComputerRoutesReport;
}

/** What a link would join, shown before it is redeemed (`relay:link-preview`). */
export interface LinkPreview {
  /** The computer whose link this is. */
  maker: string;
  /** The maker plus every computer already linked with it. */
  makerGroup: string[];
  /** This device's linked computers; empty when it has none. */
  here: string[];
  /** This computer doesn't reach the maker yet, so the person confirms before it can run agents here. */
  needsConfirm: boolean;
  expiresAt: string;
}

/** `relay:redeem-link` result: the computers this one is now linked with. */
export interface LinkRedeemResult {
  linked: string[];
}

/** `relay:paired`: a phone or computer used this computer's link or QR code. */
export interface RelayPairedEvent {
  kind: 'phone' | 'computer';
  label: string;
  /** Computers only: its id in `client.computers`, for "Not you? Unlink". */
  computerId?: string;
}

/** `relay:link-opened`: a `pane://pair#…` link reached desktop Pane. */
export interface RelayLinkOpenedEvent {
  link: string;
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

/** How Remote Access lists a paired phone (Phones and glasses) or linked computer (Computers). */
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
  /** "Not you? Unlink" on the computer that made the link. `{computerId}` → `{removed, notReached}` (computer names). */
  undoJoin: 'relay:undo-join',
} as const;
