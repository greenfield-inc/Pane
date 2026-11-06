/**
 * Signing a host in to GitHub with gh's device flow, driven from Pane.
 *
 * The daemon on the active host runs `gh auth login --web` without a browser
 * and reports the one-time code here, so the user approves it on their own
 * computer. The code only ever appears in the `waiting` state.
 */

export interface GitHubDeviceLoginStartRequest {
  /** Display name of the active host, used only in user-facing messages. */
  hostLabel?: string;
  /** Store the token in gh's config file instead of the system keyring (for hosts whose keyring can't be unlocked). */
  ghInsecureStorage?: boolean;
}

export type GitHubDeviceLoginFailureReason = 'timeout' | 'expired' | 'gh-missing' | 'exit';

export type GitHubDeviceLoginState =
  | { status: 'idle' }
  | { status: 'starting'; loginId: string }
  | { status: 'waiting'; loginId: string; code: string; verificationUrl: string }
  | { status: 'approved'; loginId: string }
  | { status: 'signed-in'; loginId: string; user: string | null }
  | {
    status: 'failed';
    loginId: string;
    reason: GitHubDeviceLoginFailureReason;
    exitCode: number | null;
    message: string;
  }
  | { status: 'cancelled'; loginId: string };
