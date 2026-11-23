import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { type PairingLink, relayComputerIdOf, type RelayIdentity } from '../fleet';

/** A new relay key's identity, as a VM's Pane makes on first use: a P-256 key, its fingerprint and the id it names. */
export function newRelayIdentity(domain: string): RelayIdentity {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
  return { computerId: relayComputerIdOf(fingerprint), fingerprint, domain };
}

/** A one-time pairing link for `relay`, shaped as the VM's Pane makes it, good for 10 minutes. */
export function pairingLinkFor(relay: RelayIdentity, name: string, now: Date): PairingLink {
  const fragment = new URLSearchParams({ s: randomBytes(32).toString('base64url'), c: relay.computerId, n: name.slice(0, 60) });
  return { relay, link: `https://${relay.domain}/pair#${fragment.toString()}`, expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString() };
}
