import { Button } from './ui/Button';

interface CloneSignInNoticeProps {
  /** The remote host's display name. */
  host: string;
  retrying: boolean;
  onOpenTerminal: () => void;
  onTryAgain: () => void;
}

/** Shown when a clone on a remote host failed because that host's git is not signed in. */
export function CloneSignInNotice({ host, retrying, onOpenTerminal, onTryAgain }: CloneSignInNoticeProps) {
  return (
    <div role="alert" className="space-y-3 rounded-lg border border-status-warning/30 bg-status-warning/10 p-4">
      <div className="space-y-1 text-sm">
        <p className="font-semibold text-text-primary">{host} isn't signed in to GitHub.</p>
        <p className="text-text-secondary">Sign in on {host}, then try again.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onOpenTerminal} variant="primary" size="sm">
          Open terminal on {host} to sign in
        </Button>
        <Button onClick={onTryAgain} variant="secondary" size="sm" loading={retrying} loadingText="Cloning...">
          Try again
        </Button>
      </div>
    </div>
  );
}
