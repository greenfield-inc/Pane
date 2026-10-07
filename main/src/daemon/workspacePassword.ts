import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import type { WorkspacePasswordHash } from '../../../shared/types/workspaceAccess';

const KEY_LENGTH = 32;
/** Desktop clients send the password on every request; remember recent answers instead of re-running scrypt. */
const MAX_REMEMBERED_SECRETS = 64;

export function hashWorkspacePassword(password: string): WorkspacePasswordHash {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, KEY_LENGTH).toString('hex') };
}

/** Checks a presented password against the stored hash. */
export function createWorkspacePasswordVerifier(stored: WorkspacePasswordHash): (secret: string) => boolean {
  const expected = Buffer.from(stored.hash, 'hex');
  const remembered = new Map<string, boolean>();
  return (secret) => {
    const key = createHash('sha256').update(secret).digest('hex');
    const known = remembered.get(key);
    if (known !== undefined) return known;
    const actual = scryptSync(secret, stored.salt, KEY_LENGTH);
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (remembered.size >= MAX_REMEMBERED_SECRETS) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
    remembered.set(key, matches);
    return matches;
  };
}
