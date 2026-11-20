import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'crypto';
import type { WorkspacePasswordHash } from '../../../shared/types/workspaceAccess';

const KEY_LENGTH = 32;
/** Desktop clients send the password on every request; remember recent wrong answers instead of re-running scrypt. */
const MAX_REMEMBERED_SECRETS = 64;
const THROTTLE_WINDOW_MS = 60_000;
/** Wrong guesses one Tailscale login may make per window before its checks stop. */
const MAX_FAILURES_PER_LOGIN = 10;
/**
 * scrypt runs on libuv's thread pool, not Pane's main thread, but each hash still takes tens of
 * milliseconds of a pool thread that file system and DNS work share (about 50-95 ms on Windows).
 * All logins together get at most this many per window, so a stream of distinct wrong guesses
 * keeps at most one pool thread busy for a few seconds a minute.
 */
const MAX_HASHES_PER_WINDOW = 60;

type SecretCheck = 'valid' | 'invalid' | 'throttled';

export interface WorkspaceSecretVerifier {
  /** Checks a presented password for a login, hashing it unless it was already proved or refuted. */
  check(secret: string, login: string): Promise<SecretCheck>;
  /** Answers from memory alone, never hashing: true only for the password a check already proved. */
  isProved(secret: string): boolean;
}

/**
 * Runs once when someone at the machine itself sets the password (remote callers are refused),
 * so it stays synchronous: one hash per deliberate change, which no guesser can trigger.
 */
export function hashWorkspacePassword(password: string): WorkspacePasswordHash {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, KEY_LENGTH).toString('hex') };
}

/** Hashes a presented password with the stored salt on libuv's thread pool. */
export function scryptWorkspaceSecret(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_LENGTH, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export interface WorkspacePasswordVerifierOptions {
  now?: () => number;
  hash?: (secret: string, salt: string) => Promise<Buffer>;
}

const secretKey = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * Checks a presented password against the stored hash. The password, once proved right, is
 * answered from memory for good; new guesses are rate limited per login and overall.
 *
 * Checks can overlap, so the limits count a hash when it starts, and a login's hashes still in
 * flight count toward its failures. Checks of a secret already being hashed share that hash.
 */
export function createWorkspacePasswordVerifier(
  stored: WorkspacePasswordHash,
  { now = Date.now, hash = scryptWorkspaceSecret }: WorkspacePasswordVerifierOptions = {},
): WorkspaceSecretVerifier {
  const expected = Buffer.from(stored.hash, 'hex');
  // Only one secret can match, so it is kept apart from the wrong guesses and never evicted by them.
  let proved: string | null = null;
  const refuted = new Set<string>();
  const inFlight = new Map<string, Promise<boolean>>();
  const failures = new Map<string, number[]>();
  const pendingByLogin = new Map<string, number>();
  let hashes: number[] = [];

  const recent = (times: readonly number[]) => times.filter((time) => now() - time < THROTTLE_WINDOW_MS);

  const startHash = (key: string, secret: string, login: string): Promise<boolean> => {
    hashes.push(now());
    pendingByLogin.set(login, (pendingByLogin.get(login) ?? 0) + 1);
    const hashed = hash(secret, stored.salt)
      .then((actual) => {
        const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
        if (matches) {
          proved = key;
        } else {
          if (refuted.size >= MAX_REMEMBERED_SECRETS) {
            const oldest = refuted.values().next().value;
            if (oldest !== undefined) refuted.delete(oldest);
          }
          refuted.add(key);
        }
        return matches;
      })
      .finally(() => {
        inFlight.delete(key);
        const pending = (pendingByLogin.get(login) ?? 1) - 1;
        if (pending > 0) pendingByLogin.set(login, pending);
        else pendingByLogin.delete(login);
      });
    inFlight.set(key, hashed);
    return hashed;
  };

  return {
    isProved: (secret) => proved !== null && secretKey(secret) === proved,
    check: async (secret, login) => {
      const key = secretKey(secret);
      if (key === proved) return 'valid';

      const loginFailures = recent(failures.get(login) ?? []);
      failures.set(login, loginFailures);
      if (loginFailures.length + (pendingByLogin.get(login) ?? 0) >= MAX_FAILURES_PER_LOGIN) return 'throttled';

      // A secret already being hashed costs nothing more, so joining it is exempt from the overall cap.
      let matches: boolean | Promise<boolean> | undefined = inFlight.get(key);
      if (matches === undefined) {
        hashes = recent(hashes);
        if (hashes.length >= MAX_HASHES_PER_WINDOW) return 'throttled';
        matches = refuted.has(key) ? false : startHash(key, secret, login);
      }
      if (await matches) return 'valid';
      failures.set(login, [...recent(failures.get(login) ?? []), now()]);
      return 'invalid';
    },
  };
}
