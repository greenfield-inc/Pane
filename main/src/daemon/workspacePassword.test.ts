import { describe, expect, it } from 'vitest';
import { createWorkspacePasswordVerifier, hashWorkspacePassword, scryptWorkspaceSecret } from './workspacePassword';

/** The real hash, counting how many start. */
function countingHash() {
  let started = 0;
  return {
    hash: (secret: string, salt: string) => {
      started += 1;
      return scryptWorkspaceSecret(secret, salt);
    },
    started: () => started,
  };
}

describe('createWorkspacePasswordVerifier', () => {
  const stored = hashWorkspacePassword('correct horse');

  it('accepts the password and rejects anything else', async () => {
    const { check } = createWorkspacePasswordVerifier(stored);
    await expect(check('correct horse', 'me@example.com')).resolves.toBe('valid');
    await expect(check('wrong', 'me@example.com')).resolves.toBe('invalid');
  });

  it('stops checking a login that keeps guessing, without blocking anyone else', async () => {
    let now = 0;
    const { check } = createWorkspacePasswordVerifier(stored, { now: () => now });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(check(`guess-${attempt}`, 'guesser@example.com')).resolves.toBe('invalid');
    }
    await expect(check('guess-10', 'guesser@example.com')).resolves.toBe('throttled');
    // The right password is refused too while throttled, so guessing faster gains nothing.
    await expect(check('correct horse', 'guesser@example.com')).resolves.toBe('throttled');
    await expect(check('correct horse', 'me@example.com')).resolves.toBe('valid');

    now += 61_000;
    await expect(check('guess-11', 'guesser@example.com')).resolves.toBe('invalid');
  });

  it('keeps letting a client in with the password it already proved, however busy it gets', async () => {
    let now = 0;
    const { check } = createWorkspacePasswordVerifier(stored, { now: () => now });
    await expect(check('correct horse', 'me@example.com')).resolves.toBe('valid');
    await Promise.all(Array.from({ length: 70 }, (_, login) => check(`guess-${login}`, `stranger-${login}@example.com`)));
    await expect(check('another guess', 'someone@example.com')).resolves.toBe('throttled');
    await expect(check('correct horse', 'me@example.com')).resolves.toBe('valid');
    now += 61_000;
    await expect(check('another guess', 'someone@example.com')).resolves.toBe('invalid');
  });

  it('remembers the proved password however many wrong guesses follow, and proves nothing by itself', async () => {
    const verifier = createWorkspacePasswordVerifier(stored);
    expect(verifier.isProved('correct horse')).toBe(false);
    await expect(verifier.check('correct horse', 'me@example.com')).resolves.toBe('valid');
    await Promise.all(Array.from({ length: 70 }, (_, guess) => verifier.check(`guess-${guess}`, `stranger-${guess}@example.com`)));
    expect(verifier.isProved('correct horse')).toBe(true);
    expect(verifier.isProved('guess-0')).toBe(false);
  });

  it('answers a password it already proved or refuted without hashing it again', async () => {
    const { hash, started } = countingHash();
    const { check } = createWorkspacePasswordVerifier(stored, { hash });
    await check('correct horse', 'me@example.com');
    await check('wrong', 'me@example.com');
    expect(started()).toBe(2);
    for (let request = 0; request < 5; request += 1) {
      await expect(check('correct horse', `client-${request}@example.com`)).resolves.toBe('valid');
      await expect(check('wrong', `client-${request}@example.com`)).resolves.toBe('invalid');
    }
    expect(started()).toBe(2);
  });

  it('never starts more hashes than the window allows, however many distinct guesses arrive at once', async () => {
    const { hash, started } = countingHash();
    const { check } = createWorkspacePasswordVerifier(stored, { now: () => 0, hash });
    const results = await Promise.all(Array.from({ length: 100 }, (_, guess) => check(`guess-${guess}`, `stranger-${guess}@example.com`)));
    expect(started()).toBe(60);
    expect(results.filter((result) => result === 'invalid')).toHaveLength(60);
    expect(results.filter((result) => result === 'throttled')).toHaveLength(40);
  });

  it('holds one login to its failure cap when its guesses arrive at once', async () => {
    const { hash, started } = countingHash();
    const { check } = createWorkspacePasswordVerifier(stored, { now: () => 0, hash });
    const results = await Promise.all(Array.from({ length: 15 }, (_, guess) => check(`guess-${guess}`, 'guesser@example.com')));
    expect(started()).toBe(10);
    expect(results.filter((result) => result === 'invalid')).toHaveLength(10);
    expect(results.filter((result) => result === 'throttled')).toHaveLength(5);
  });

  it('hashes a password once when a burst of requests presents it together', async () => {
    const { hash, started } = countingHash();
    const { check } = createWorkspacePasswordVerifier(stored, { hash });
    const right = await Promise.all(Array.from({ length: 20 }, (_, request) => check('correct horse', `client-${request % 3}@example.com`)));
    expect(right.every((result) => result === 'valid')).toBe(true);
    const wrong = await Promise.all(Array.from({ length: 5 }, () => check('wrong', 'me@example.com')));
    expect(wrong.every((result) => result === 'invalid')).toBe(true);
    expect(started()).toBe(2);
  });

  it('hashes off the main thread, so timers keep firing while a check runs', async () => {
    const { check } = createWorkspacePasswordVerifier(stored);
    const order: string[] = [];
    const checked = check('a new guess', 'me@example.com').then(() => order.push('check'));
    await new Promise<void>((resolve) => setTimeout(() => { order.push('timer'); resolve(); }, 0));
    await checked;
    expect(order).toEqual(['timer', 'check']);
  });
});
