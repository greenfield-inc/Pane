import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { API } from '../utils/api';
import { TAILNET_HTTPS_OFF_REASON, TAILSCALE_DNS_ADMIN_URL } from '../../../shared/types/workspaceAccess';

/** Main re-reads Tailscale every minute; reading its cached status this often is cheap. */
const POLL_MS = 15_000;

/**
 * Says why this machine's workspaces are off when the tailnet has HTTPS Certificates turned off.
 * It disappears once main's recheck turns workspaces on. Dismissal lasts until Pane restarts.
 */
export function TailnetHttpsBanner() {
  const [certificatesOff, setCertificatesOff] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    const read = () => {
      API.remoteDaemon.getWorkspaceAccess()
        .then((response) => {
          if (!cancelled) setCertificatesOff(response.success && response.data?.reason === TAILNET_HTTPS_OFF_REASON);
        })
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [dismissed]);

  if (!certificatesOff || dismissed) return null;

  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-1.5 text-xs text-text-secondary">
      <p className="min-w-0 flex-1">
        <span className="text-text-primary">Remote access between your machines is off because HTTPS Certificates are turned off for your Tailscale network.</span>{' '}
        Turning them on writes machine names (<code>machine.tailnet.ts.net</code>) to the public Certificate Transparency log.
      </p>
      <button
        type="button"
        onClick={() => void window.electronAPI.openExternal(TAILSCALE_DNS_ADMIN_URL)}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-interactive hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
      >
        Open Tailscale DNS settings
        <ExternalLink className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss HTTPS Certificates notice"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
