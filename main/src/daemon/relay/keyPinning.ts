import { createHash, X509Certificate } from 'crypto';
import tls, { type PeerCertificate } from 'tls';

/**
 * A certificate check that also requires the computer's own key: the base64url SHA-256 of its
 * SubjectPublicKeyInfo, saved when the device paired. A certificate issued to anyone else for
 * the same name is refused, so the relay operator cannot stand in for the computer.
 */
export function pinnedServerIdentity(fingerprint: string, label: string): (host: string, certificate: PeerCertificate) => Error | undefined {
  return (host, certificate) => {
    const identity = tls.checkServerIdentity(host, certificate);
    if (identity) return identity;
    const key = new X509Certificate(certificate.raw).publicKey.export({ format: 'der', type: 'spki' });
    return createHash('sha256').update(key).digest('base64url') === fingerprint
      ? undefined
      : new Error(`${label} presented a key it did not pair with, so Pane did not connect.`);
  };
}
