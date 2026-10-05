import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { openSealedBundle, sealBundle, vaultHpkeSuite, type SealedBundle } from './sealedBundle';
import type { TargetKeyPair } from './targetKey';

function hex(value: string): ArrayBuffer {
  return new Uint8Array(Buffer.from(value.replace(/\s+/g, ''), 'hex')).buffer;
}

function newTargetKey(): TargetKeyPair {
  const jwk = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.d) throw new Error('expected an X25519 JWK');
  return { publicKey: jwk.x, privateKey: jwk.d };
}

const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();
const CANARY = 'canary-sk-vault-v5-0b1f2e';

describe('vault HPKE suite', () => {
  // RFC 9180 Appendix A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode, sequence 0.
  it('opens the RFC 9180 A.1.1 known-answer ciphertext', async () => {
    const recipientKey = await vaultHpkeSuite.kem.deserializePrivateKey(
      hex('4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8'),
    );
    const plaintext = await vaultHpkeSuite.open(
      {
        recipientKey,
        enc: hex('37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431'),
        info: hex('4f6465206f6e2061204772656369616e2055726e'),
      },
      hex('f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a'),
      hex('436f756e742d30'),
    );
    expect(Buffer.from(plaintext).toString('utf8')).toBe('Beauty is truth, truth beauty');
  });
});

describe('sealed bundles', () => {
  it('round-trips a bundle to the target it was sealed for, without the plaintext on the wire', async () => {
    const target = newTargetKey();
    const sealed = await sealBundle(target.publicKey, Buffer.from(CANARY), { bundleId: 'b1', expiresAt: IN_AN_HOUR });

    expect(JSON.stringify(sealed)).not.toContain(CANARY);
    expect(Buffer.from(await openSealedBundle(target, sealed)).toString('utf8')).toBe(CANARY);
  });

  it('refuses a bundle sealed for another target', async () => {
    const sealed = await sealBundle(newTargetKey().publicKey, Buffer.from(CANARY), { bundleId: 'b1', expiresAt: IN_AN_HOUR });
    await expect(openSealedBundle(newTargetKey(), sealed)).rejects.toThrow(/another target/);
  });

  it('refuses an expired bundle', async () => {
    const target = newTargetKey();
    const sealed = await sealBundle(target.publicKey, Buffer.from(CANARY), {
      bundleId: 'b1',
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
    await expect(openSealedBundle(target, sealed, new Date('2026-10-02T00:00:00.000Z'))).rejects.toThrow(/expired/);
  });

  it('refuses a bundle that stays valid longer than a standing approval can', async () => {
    const target = newTargetKey();
    const sealed = await sealBundle(target.publicKey, Buffer.from(CANARY), {
      bundleId: 'b1',
      expiresAt: '2026-11-04T00:00:00.000Z',
    });
    await expect(openSealedBundle(target, sealed, new Date('2026-10-04T00:00:00.000Z'))).rejects.toThrow(/30 days/);
  });

  it('refuses a bundle whose header a relay rewrote', async () => {
    const target = newTargetKey();
    const sealed = await sealBundle(target.publicKey, Buffer.from(CANARY), {
      bundleId: 'b1',
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
    const extended: SealedBundle = { ...sealed, header: { ...sealed.header, expiresAt: '2026-10-03T00:00:00.000Z' } };
    await expect(openSealedBundle(target, extended, new Date('2026-10-02T00:00:00.000Z'))).rejects.toThrow();
  });
});
