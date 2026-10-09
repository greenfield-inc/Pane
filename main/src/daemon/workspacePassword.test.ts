import { describe, expect, it } from 'vitest';
import { createWorkspacePasswordVerifier, hashWorkspacePassword } from './workspacePassword';

describe('createWorkspacePasswordVerifier', () => {
  const stored = hashWorkspacePassword('correct horse');

  it('accepts the password and rejects anything else', () => {
    const verify = createWorkspacePasswordVerifier(stored);
    expect(verify('correct horse', 'me@example.com')).toBe('valid');
    expect(verify('wrong', 'me@example.com')).toBe('invalid');
  });

  it('stops checking a login that keeps guessing, without blocking anyone else', () => {
    let now = 0;
    const verify = createWorkspacePasswordVerifier(stored, () => now);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(verify(`guess-${attempt}`, 'guesser@example.com')).toBe('invalid');
    }
    expect(verify('guess-10', 'guesser@example.com')).toBe('throttled');
    // The right password is refused too while throttled, so guessing faster gains nothing.
    expect(verify('correct horse', 'guesser@example.com')).toBe('throttled');
    expect(verify('correct horse', 'me@example.com')).toBe('valid');

    now += 61_000;
    expect(verify('guess-11', 'guesser@example.com')).toBe('invalid');
  });

  it('keeps letting a client in with the password it already proved, however busy it gets', () => {
    let now = 0;
    const verify = createWorkspacePasswordVerifier(stored, () => now);
    expect(verify('correct horse', 'me@example.com')).toBe('valid');
    for (let login = 0; login < 70; login += 1) verify(`guess-${login}`, `stranger-${login}@example.com`);
    expect(verify('another guess', 'someone@example.com')).toBe('throttled');
    expect(verify('correct horse', 'me@example.com')).toBe('valid');
    now += 61_000;
    expect(verify('another guess', 'someone@example.com')).toBe('invalid');
  });
});
