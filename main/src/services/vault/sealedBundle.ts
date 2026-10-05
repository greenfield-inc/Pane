import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import type { TargetKeyPair } from './targetKey';

/** HPKE (RFC 9180) base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM. */
export const vaultHpkeSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

const HPKE_INFO = new TextEncoder().encode('pane-vault-bundle/v1');
/** The longest a standing approval lasts; a bundle claiming a later expiry is refused. */
const MAX_BUNDLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Travels in the clear and is authenticated as the AEAD's associated data, so a relay can read it but not change it. */
interface SealedBundleHeader {
  v: 1;
  /** The target's public key (base64url), which doubles as its id. */
  recipient: string;
  bundleId: string;
  expiresAt: string;
}

export interface SealedBundle {
  header: SealedBundleHeader;
  /** HPKE encapsulated key, base64url. */
  enc: string;
  /** base64url. */
  ciphertext: string;
}

const sealedBundleSchema: BoundarySchema<SealedBundle> = boundary.object({
  header: boundary.object({
    v: boundary.literal(1),
    recipient: boundary.nonEmptyString,
    bundleId: boundary.nonEmptyString,
    expiresAt: boundary.nonEmptyString,
  }),
  enc: boundary.nonEmptyString,
  ciphertext: boundary.nonEmptyString,
});

export function decodeSealedBundle<Value>(value: Value): SealedBundle {
  return decodeBoundary(value, sealedBundleSchema);
}

export async function sealBundle(
  recipientPublicKey: string,
  plaintext: Uint8Array,
  options: { bundleId: string; expiresAt: string },
): Promise<SealedBundle> {
  const header: SealedBundleHeader = {
    v: 1,
    recipient: recipientPublicKey,
    bundleId: options.bundleId,
    expiresAt: options.expiresAt,
  };
  const recipient = await vaultHpkeSuite.kem.deserializePublicKey(toArrayBuffer(fromBase64Url(recipientPublicKey)));
  const { enc, ct } = await vaultHpkeSuite.seal(
    { recipientPublicKey: recipient, info: HPKE_INFO },
    toArrayBuffer(plaintext),
    associatedData(header),
  );
  return {
    header,
    enc: Buffer.from(enc).toString('base64url'),
    ciphertext: Buffer.from(ct).toString('base64url'),
  };
}

export async function openSealedBundle(
  target: TargetKeyPair,
  bundle: SealedBundle,
  now = new Date(),
): Promise<Uint8Array> {
  if (bundle.header.recipient !== target.publicKey) {
    throw new Error('Vault bundle was sealed for another target');
  }
  const expiresAt = Date.parse(bundle.header.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error('Vault bundle has expired');
  }
  if (expiresAt > now.getTime() + MAX_BUNDLE_LIFETIME_MS) {
    throw new Error('Vault bundle expires more than 30 days out');
  }
  const recipientKey = await vaultHpkeSuite.kem.deserializePrivateKey(toArrayBuffer(fromBase64Url(target.privateKey)));
  const plaintext = await vaultHpkeSuite.open(
    { recipientKey, enc: toArrayBuffer(fromBase64Url(bundle.enc)), info: HPKE_INFO },
    toArrayBuffer(fromBase64Url(bundle.ciphertext)),
    associatedData(bundle.header),
  );
  return new Uint8Array(plaintext);
}

function associatedData(header: SealedBundleHeader): Uint8Array {
  // Fixed field order, so sender and target serialize the same bytes.
  const { v, recipient, bundleId, expiresAt } = header;
  return new TextEncoder().encode(JSON.stringify({ v, recipient, bundleId, expiresAt }));
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** Copies, because a Node Buffer is often a view into a larger shared pool. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
