import { describe, expect, it } from 'vitest';
import { isDaemonOwnedChannel } from '../../../shared/types/daemon';
import type { GitHubDeviceLoginState } from '../../../shared/types/githubDeviceLogin';
import {
  GITHUB_DEVICE_LOGIN_URL,
  buildDeviceLoginStartRequest,
  isDeviceLoginActive,
  isGitHubDeviceLoginUrl,
  nextDeviceLoginState,
} from './githubDeviceLogin';

describe('isGitHubDeviceLoginUrl', () => {
  it.each([
    'https://github.com/login/device',
    'https://github.com/login/device/',
  ])('accepts %s', (url) => {
    expect(isGitHubDeviceLoginUrl(url)).toBe(true);
  });

  it.each([
    'http://github.com/login/device',
    'https://github.com.example.com/login/device',
    'https://example.com/github.com/login/device',
    'https://gist.github.com/login/device',
    'https://github.com:8443/login/device',
    'https://user:pass@github.com/login/device',
    'https://github.com/login/device?next=https://example.com',
    'https://github.com/login/device#code',
    'https://github.com/login/oauth/authorize',
    'https://github.com/login/device/../../settings',
    'file:///github.com/login/device',
    'javascript:alert(1)//github.com/login/device',
    'github.com/login/device',
    '',
  ])('rejects %s', (url) => {
    expect(isGitHubDeviceLoginUrl(url)).toBe(false);
  });

  it('opens on this computer, never through the host', () => {
    expect(isGitHubDeviceLoginUrl(GITHUB_DEVICE_LOGIN_URL)).toBe(true);
    expect(isDaemonOwnedChannel('openExternal')).toBe(false);
  });
});

describe('isDeviceLoginActive', () => {
  it.each<[GitHubDeviceLoginState, boolean]>([
    [{ status: 'idle' }, false],
    [{ status: 'starting', loginId: 'a' }, true],
    [{ status: 'waiting', loginId: 'a', code: 'fake-0000', verificationUrl: GITHUB_DEVICE_LOGIN_URL }, true],
    [{ status: 'approved', loginId: 'a' }, true],
    [{ status: 'signed-in', loginId: 'a', user: 'octocat' }, false],
    [{ status: 'failed', loginId: 'a', reason: 'expired', exitCode: 1, message: 'The code expired before it was approved. Start again.' }, false],
    [{ status: 'cancelled', loginId: 'a' }, false],
  ])('polls %o: %s', (state, active) => {
    expect(isDeviceLoginActive(state)).toBe(active);
  });
});

describe('nextDeviceLoginState', () => {
  const waiting: GitHubDeviceLoginState = { status: 'waiting', loginId: 'mine', code: 'fake-0000', verificationUrl: GITHUB_DEVICE_LOGIN_URL };

  it('takes states of the login this dialog started', () => {
    expect(nextDeviceLoginState(waiting, { status: 'signed-in', loginId: 'mine', user: 'octocat' }))
      .toEqual({ status: 'signed-in', loginId: 'mine', user: 'octocat' });
  });

  it('ignores a state from another login', () => {
    expect(nextDeviceLoginState(waiting, { status: 'cancelled', loginId: 'other' })).toBe(waiting);
  });

  it('keeps its login when the daemon has none left', () => {
    expect(nextDeviceLoginState(waiting, { status: 'idle' })).toBe(waiting);
  });

  it('adopts a login already running on the host when it has none', () => {
    expect(nextDeviceLoginState({ status: 'idle' }, waiting)).toBe(waiting);
  });

  it('does not adopt a finished login it never started', () => {
    expect(nextDeviceLoginState({ status: 'idle' }, { status: 'signed-in', loginId: 'old', user: 'octocat' })).toEqual({ status: 'idle' });
  });
});

describe('buildDeviceLoginStartRequest', () => {
  it('asks for file storage when the saved host says so', () => {
    expect(buildDeviceLoginStartRequest('sandbox-1', { ghInsecureStorage: true }))
      .toEqual({ hostLabel: 'sandbox-1', ghInsecureStorage: true });
  });

  it('keeps the keyring when the saved host says no', () => {
    expect(buildDeviceLoginStartRequest('devbox', { ghInsecureStorage: false }))
      .toEqual({ hostLabel: 'devbox', ghInsecureStorage: false });
  });

  it('keeps the keyring by default', () => {
    expect(buildDeviceLoginStartRequest('devbox', {})).toEqual({ hostLabel: 'devbox', ghInsecureStorage: false });
    expect(buildDeviceLoginStartRequest('devbox', null)).toEqual({ hostLabel: 'devbox', ghInsecureStorage: false });
  });
});
