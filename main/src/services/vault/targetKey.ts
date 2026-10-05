import { generateKeyPairSync, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

/** This machine's X25519 key pair for receiving sealed vault bundles; both halves raw and base64url. */
export interface TargetKeyPair {
  publicKey: string;
  privateKey: string;
}

const targetKeySchema = boundary.object({
  publicKey: boundary.nonEmptyString,
  privateKey: boundary.nonEmptyString,
});

export function targetKeyPath(paneDir: string): string {
  return path.join(paneDir, 'vault', 'target-key.json');
}

/** Reads this machine's target key, creating it (owner-only file) on first use. */
export async function loadOrCreateTargetKey(paneDir: string): Promise<TargetKeyPair> {
  const keyPath = targetKeyPath(paneDir);
  const existing = await readTargetKey(keyPath);
  if (existing) return existing;

  const jwk = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.d) throw new Error('Failed to generate the vault target key');
  const created: TargetKeyPair = { publicKey: jwk.x, privateKey: jwk.d };

  await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const tempPath = `${keyPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(created), { flag: 'wx', mode: 0o600 });
  try {
    // link() publishes the complete file atomically and fails if another process published first; that key wins.
    await fs.link(tempPath, keyPath);
    return created;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const winner = await readTargetKey(keyPath);
    if (!winner) throw new Error('Vault target key file is unreadable');
    return winner;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

/** For connection codes: pairing must not depend on the vault, so a key that can't be read or created is left out. */
export async function readTargetPublicKeyForPairing(paneDir: string): Promise<string | undefined> {
  try {
    return (await loadOrCreateTargetKey(paneDir)).publicKey;
  } catch (error) {
    console.warn(`[vault] Leaving the vault key out of the connection code: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function readTargetKey(keyPath: string): Promise<TargetKeyPair | null> {
  let raw: string;
  try {
    raw = await fs.readFile(keyPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  return decodeBoundary(JSON.parse(raw), targetKeySchema);
}
