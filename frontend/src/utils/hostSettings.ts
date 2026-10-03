import type { SettingsTarget } from '../types/settings';

/** Fired to open the Settings that hold the active host's GitHub credentials (see `githubSignIn`). */
export const OPEN_HOST_GITHUB_SETTINGS_EVENT = 'pane:open-host-github-settings';

/** Where those credentials live in Settings. */
export const HOST_GITHUB_SETTINGS_TARGET: SettingsTarget = { category: 'remote-access' };

/** Open the Settings that hold the active host's GitHub credentials, from anywhere in the app. */
export function openHostGitHubSettings(): void {
  window.dispatchEvent(new Event(OPEN_HOST_GITHUB_SETTINGS_EVENT));
}

/** Call `open` whenever something asks for the host's GitHub settings; returns the unsubscribe. */
export function onOpenHostGitHubSettings(open: (target: SettingsTarget) => void): () => void {
  const listener = () => open(HOST_GITHUB_SETTINGS_TARGET);
  window.addEventListener(OPEN_HOST_GITHUB_SETTINGS_EVENT, listener);
  return () => window.removeEventListener(OPEN_HOST_GITHUB_SETTINGS_EVENT, listener);
}
