import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import type { WorkspacePasswordHash } from '../../../shared/types/workspaceAccess';

const KEY_LENGTH = 32;
/** Desktop clients send the password on every request; remember recent wrong answers instead of re-running scrypt. */
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

type SecretCheck = 'valid' | 'invalid' | 'throttled';

export interface WorkspaceSecretVerifier {
  /** Checks a presented password for a login, hashing it unless it was already proved or refuted. */
  check(secret: string, login: string): SecretCheck;
  /** Answers from memory alone, never hashing: true only for the password a check already proved. */
  isProved(secret: string): boolean;
}

export function hashWorkspacePassword(password: string): WorkspacePasswordHash {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, KEY_LENGTH).toString('hex') };
}

const secretKey = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * Checks a presented password against the stored hash. The password, once proved right, is
 * answered from memory for good; new guesses are rate limited per login and overall.
 */
export function createWorkspacePasswordVerifier(
  stored: WorkspacePasswordHash,
  now: () => number = Date.now,
): WorkspaceSecretVerifier {
  const expected = Buffer.from(stored.hash, 'hex');
  // Only one secret can match, so it is kept apart from the wrong guesses and never evicted by them.
  let proved: string | null = null;
  const refuted = new Set<string>();
  const failures = new Map<string, number[]>();
  let hashes: number[] = [];

  const recent = (times: readonly number[]) => times.filter((time) => now() - time < THROTTLE_WINDOW_MS);

  return {
    isProved: (secret) => proved !== null && secretKey(secret) === proved,
    check: (secret, login) => {
      const key = secretKey(secret);
      if (key === proved) return 'valid';

      const loginFailures = recent(failures.get(login) ?? []);
      hashes = recent(hashes);
      if (loginFailures.length >= MAX_FAILURES_PER_LOGIN || hashes.length >= MAX_HASHES_PER_WINDOW) {
        failures.set(login, loginFailures);
        return 'throttled';
      }

      if (!refuted.has(key)) {
        hashes.push(now());
        const actual = scryptSync(secret, stored.salt, KEY_LENGTH);
        if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
          proved = key;
          return 'valid';
        }
        if (refuted.size >= MAX_REMEMBERED_SECRETS) {
          const oldest = refuted.values().next().value;
          if (oldest !== undefined) refuted.delete(oldest);
        }
        refuted.add(key);
      }
      failures.set(login, [...loginFailures, now()]);
      return 'invalid';
    },
  };
}
