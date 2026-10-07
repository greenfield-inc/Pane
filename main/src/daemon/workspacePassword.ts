import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import type { WorkspacePasswordHash } from '../../../shared/types/workspaceAccess';

const KEY_LENGTH = 32;
/** Desktop clients send the password on every request; remember recent answers instead of re-running scrypt. */
const MAX_REMEMBERED_SECRETS = 64;
const THROTTLE_WINDOW_MS = 60_000;
/** Wrong guesses one Tailscale login may make per window before its checks stop. */
const MAX_FAILURES_PER_LOGIN = 10;
/**
 * scrypt runs on Pane's main thread (tens of milliseconds each), so all logins together get at
 * most this many per window: a stream of distinct wrong guesses costs a few seconds a minute at
 * worst instead of freezing the app.
 */
const MAX_HASHES_PER_WINDOW = 60;

export type SecretCheck = 'valid' | 'invalid' | 'throttled';

export function hashWorkspacePassword(password: string): WorkspacePasswordHash {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, KEY_LENGTH).toString('hex') };
}

/**
 * Checks a presented password against the stored hash. A password already proved right is
 * answered from memory; new guesses are rate limited per login and overall.
 */
export function createWorkspacePasswordVerifier(
  stored: WorkspacePasswordHash,
  now: () => number = Date.now,
): (secret: string, login: string) => SecretCheck {
  const expected = Buffer.from(stored.hash, 'hex');
  const remembered = new Map<string, boolean>();
  const failures = new Map<string, number[]>();
  let hashes: number[] = [];

  const recent = (times: readonly number[]) => times.filter((time) => now() - time < THROTTLE_WINDOW_MS);

  return (secret, login) => {
    const key = createHash('sha256').update(secret).digest('hex');
    if (remembered.get(key) === true) return 'valid';

    const loginFailures = recent(failures.get(login) ?? []);
    hashes = recent(hashes);
    if (loginFailures.length >= MAX_FAILURES_PER_LOGIN || hashes.length >= MAX_HASHES_PER_WINDOW) {
      failures.set(login, loginFailures);
      return 'throttled';
    }

    let matches = remembered.get(key);
    if (matches === undefined) {
      hashes.push(now());
      const actual = scryptSync(secret, stored.salt, KEY_LENGTH);
      matches = expected.length === actual.length && timingSafeEqual(expected, actual);
      if (remembered.size >= MAX_REMEMBERED_SECRETS) {
        const oldest = remembered.keys().next().value;
        if (oldest !== undefined) remembered.delete(oldest);
      }
      remembered.set(key, matches);
    }
    if (matches) return 'valid';
    failures.set(login, [...loginFailures, now()]);
    return 'invalid';
  };
}
