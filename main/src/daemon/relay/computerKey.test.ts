import { describe, expect, it } from 'vitest';
import { createPublicKey, createVerify } from 'crypto';
import { loadComputerKey, signRelayChallenge, type KeyStore } from './computerKey';

// Generated with `openssl ecparam -name prime256v1 -genkey`; the id was computed with openssl and
// Python: base32(sha256(pubkey DER)[:10]), lowercase, no padding.
const FIXED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfWZwWNNcF4zu1byC
Ixq8bPC2xJF3q2IWBzTt0c+dqFuhRANCAATIxS0lBbPMt3cs1/JYnrs11L7AwYiL
OkhLlCQWf+7Z7VXoQ2EzfZcrwH+pP20bePnUNEP7HLjKU77Dcg0KsGP+
-----END PRIVATE KEY-----
`;

function memoryStore(initial?: string): KeyStore & { value: string | null } {
  return {
    value: initial ?? null,
    async read() { return this.value; },
    async write(value) { this.value = value; },
  };
}

describe('computer key', () => {
  it('derives the computer id from the public key', async () => {
    const key = await loadComputerKey(memoryStore(FIXED_KEY));
    expect(key.id).toBe('75rnqtlvttepjja3');
  });

  it('creates a key once and keeps it', async () => {
    const store = memoryStore();
    const first = await loadComputerKey(store);
    const second = await loadComputerKey(store);
    expect(first.id).toMatch(/^[a-z2-7]{16}$/u);
    expect(second.id).toBe(first.id);
  });

  it('signs the relay challenge so the public key verifies it', async () => {
    const key = await loadComputerKey(memoryStore(FIXED_KEY));
    const signature = signRelayChallenge(key, 'nonce-123');
    const verifier = createVerify('sha256');
    verifier.update('pane-relay-v1:nonce-123');
    const publicKey = createPublicKey({ key: key.spki, format: 'der', type: 'spki' });
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });
});
