import type { GitHubDeviceLoginStartRequest, GitHubDeviceLoginState } from '../../../shared/types/githubDeviceLogin';

/** Where the user enters the code. The link opens on this computer, never on the host. */
export const GITHUB_DEVICE_LOGIN_URL = 'https://github.com/login/device';

/** True only for GitHub's device page itself: https, github.com, no port, credentials, query or fragment. */
export function isGitHubDeviceLoginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:'
    && parsed.hostname === 'github.com'
    && parsed.port === ''
    && parsed.username === ''
    && parsed.password === ''
    && parsed.search === ''
    && parsed.hash === ''
    && (parsed.pathname === '/login/device' || parsed.pathname === '/login/device/');
}

/** States in which gh is still running on the host, so the UI keeps polling. */
export function isDeviceLoginActive(state: GitHubDeviceLoginState): boolean {
  return state.status === 'starting' || state.status === 'waiting' || state.status === 'approved';
}

/**
 * The state to show after the daemon reports `incoming`. Only the login this
 * dialog started (or one still running when it opened) moves the UI: a
 * finished login from earlier, or another one, is ignored.
 */
export function nextDeviceLoginState(current: GitHubDeviceLoginState, incoming: GitHubDeviceLoginState): GitHubDeviceLoginState {
  if (current.status === 'idle') return isDeviceLoginActive(incoming) ? incoming : current;
  if (incoming.status === 'idle' || incoming.loginId !== current.loginId) return current;
  return incoming;
}

/** The start request for the active host; its saved profile decides where gh keeps the token (keyring unless it says otherwise). */
export function buildDeviceLoginStartRequest(
  hostLabel: string,
  profile: { ghInsecureStorage?: boolean } | null,
): GitHubDeviceLoginStartRequest & { ghInsecureStorage: boolean } {
  return { hostLabel, ghInsecureStorage: profile?.ghInsecureStorage === true };
}
