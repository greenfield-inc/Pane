"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newRelayIdentity = newRelayIdentity;
exports.pairingLinkFor = pairingLinkFor;
const node_crypto_1 = require("node:crypto");
const fleet_1 = require("../fleet");
/** A new relay key's identity, as a VM's Pane makes on first use: a P-256 key, its fingerprint and the id it names. */
function newRelayIdentity(domain) {
    const { publicKey } = (0, node_crypto_1.generateKeyPairSync)('ec', { namedCurve: 'P-256' });
    const fingerprint = (0, node_crypto_1.createHash)('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
    return { computerId: (0, fleet_1.relayComputerIdOf)(fingerprint), fingerprint, domain };
}
/** A one-time pairing link for `relay`, shaped as the VM's Pane makes it, good for 10 minutes. */
function pairingLinkFor(relay, name, now) {
    const fragment = new URLSearchParams({ s: (0, node_crypto_1.randomBytes)(32).toString('base64url'), c: relay.computerId, n: name.slice(0, 60) });
    return { relay, link: `https://${relay.domain}/pair#${fragment.toString()}`, expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString() };
}
