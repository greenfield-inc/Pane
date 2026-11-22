import { type PairingLink, type RelayIdentity } from '../fleet';
/** A new relay key's identity, as a VM's Pane makes on first use: a P-256 key, its fingerprint and the id it names. */
export declare function newRelayIdentity(domain: string): RelayIdentity;
/** A one-time pairing link for `relay`, shaped as the VM's Pane makes it, good for 10 minutes. */
export declare function pairingLinkFor(relay: RelayIdentity, name: string, now: Date): PairingLink;
