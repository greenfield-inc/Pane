import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, type KeyObject } from 'crypto';

/** Where the computer's private key lives: the OS keychain or the encrypted secrets file. It never leaves this computer. */
export interface KeyStore {
  read(): Promise<string | null>;
  write(pem: string): Promise<void>;
}

export interface ComputerKey {
  /** The 16-character name under the relay domain, derived from the public key (relay/PROTOCOL.md). */
  id: string;
  privateKey: KeyObject;
  privateKeyPem: string;
  /** SubjectPublicKeyInfo DER. */
  spki: Buffer;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function computerIdFromSpki(spki: Buffer): string {
  return base32(createHash('sha256').update(spki).digest().subarray(0, 10));
}

/** The computer's P-256 key, made on first use. Certificates renew with this same key. */
export async function loadComputerKey(store: KeyStore): Promise<ComputerKey> {
  let pem = await store.read();
  if (!pem) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    await store.write(pem);
  }
  const privateKey = createPrivateKey(pem);
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { id: computerIdFromSpki(spki), privateKey, privateKeyPem: pem, spki };
}

/** The `hello` signature: ECDSA-SHA256 (DER) over `pane-relay-v1:<nonce>`. */
export function signRelayChallenge(key: ComputerKey, nonce: string): Buffer {
  const signer = createSign('sha256');
  signer.update(`pane-relay-v1:${nonce}`);
  return signer.sign(key.privateKey);
}
