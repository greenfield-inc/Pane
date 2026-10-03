import { useState } from 'react';
import { Button } from './ui/Button';
import { GITHUB_DEVICE_LOGIN_URL, isDeviceLoginActive } from '../utils/githubDeviceLogin';
import type { GitHubDeviceLoginState } from '../../../shared/types/githubDeviceLogin';

interface CloneSignInNoticeProps {
  /** The remote host's display name. */
  host: string;
  /** The clone used an SSH URL, which the HTTPS sign-in below does not set up. */
  overSsh: boolean;
  /** This app's Settings manage the host's GitHub credentials (the saved host's `githubSignIn: 'settings'`). */
  managedInSettings: boolean;
  retrying: boolean;
  /** gh's device sign-in on the host, driven from Pane. */
  deviceLogin: GitHubDeviceLoginState;
  /** Why the sign-in could not be started or cancelled. */
  deviceLoginError: string;
  onOpenSettings: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onOpenTerminal: () => void;
  onTryAgain: () => void;
}

/** Shown when a clone on a remote host failed because that host's git is not signed in. */
export function CloneSignInNotice({
  host,
  overSsh,
  managedInSettings,
  retrying,
  deviceLogin,
  deviceLoginError,
  onOpenSettings,
  onSignIn,
  onCancelSignIn,
  onOpenTerminal,
  onTryAgain,
}: CloneSignInNoticeProps) {
  const tryAgain = (
    <Button onClick={onTryAgain} variant="secondary" size="sm" loading={retrying} loadingText="Cloning...">
      Try again
    </Button>
  );

  if (managedInSettings) {
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-status-warning/30 bg-status-warning/10 p-4">
        <p className="text-sm font-semibold text-text-primary">Add a GitHub token in Settings</p>
        {overSsh && <p className="text-sm text-text-secondary">This is an SSH URL; after signing in, use the HTTPS URL instead.</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onOpenSettings} variant="primary" size="sm">
            Open Settings
          </Button>
          {tryAgain}
        </div>
      </div>
    );
  }

  if (deviceLogin.status === 'signed-in') {
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-status-success/20 bg-status-success/10 p-4">
        <p className="text-sm font-semibold text-text-primary">
          {deviceLogin.user ? `Signed in to GitHub as ${deviceLogin.user}` : 'Signed in to GitHub'}
        </p>
        {overSsh && <p className="text-sm text-text-secondary">This is an SSH URL; after signing in, use the HTTPS URL instead.</p>}
        <div className="flex flex-wrap gap-2">{tryAgain}</div>
      </div>
    );
  }

  const signingIn = isDeviceLoginActive(deviceLogin);
  const failure = deviceLogin.status === 'failed' ? deviceLogin.message : deviceLoginError;

  return (
    <div role="alert" className="space-y-3 rounded-lg border border-status-warning/30 bg-status-warning/10 p-4">
      <div className="space-y-1 text-sm">
        <p className="font-semibold text-text-primary">{host} isn't signed in to GitHub.</p>
        <p className="text-text-secondary">Sign in on {host}, then try again.</p>
        {overSsh && <p className="text-text-secondary">This is an SSH URL; after signing in, use the HTTPS URL instead.</p>}
      </div>
      {deviceLogin.status === 'waiting' && <DeviceCode code={deviceLogin.code} onCancel={onCancelSignIn} />}
      {deviceLogin.status === 'approved' && (
        <p className="text-sm text-text-secondary">Approved on GitHub. Finishing sign-in on {host}…</p>
      )}
      {failure && <p className="text-sm text-status-error">{failure}</p>}
      <div className="flex flex-wrap gap-2">
        {deviceLogin.status !== 'waiting' && deviceLogin.status !== 'approved' && (
          <Button onClick={onSignIn} variant="primary" size="sm" loading={deviceLogin.status === 'starting'} loadingText="Starting...">
            Sign in to GitHub
          </Button>
        )}
        <Button onClick={onOpenTerminal} variant="secondary" size="sm" disabled={signingIn}>
          Open terminal on {host} to sign in
        </Button>
        {tryAgain}
      </div>
      <p className="text-xs text-text-tertiary">Open github.com/login/device on your computer, enter the code, and wait here.</p>
    </div>
  );
}

/** The one-time code while gh waits for approval. The page opens on this computer, never on the host. */
function DeviceCode({ code, onCancel }: { code: string; onCancel: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border-secondary bg-surface-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code aria-label="One-time code" data-secret="github-device-code" className="font-mono text-lg font-semibold tracking-widest text-text-primary">{code}</code>
        <Button onClick={() => void copy()} variant="secondary" size="sm">
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button onClick={() => void window.electronAPI.openExternal(GITHUB_DEVICE_LOGIN_URL)} variant="ghost" size="sm">
          Open github.com/login/device
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-text-secondary">Waiting for you to approve on GitHub…</p>
        <Button onClick={onCancel} variant="ghost" size="sm">
          Cancel
        </Button>
      </div>
    </div>
  );
}
