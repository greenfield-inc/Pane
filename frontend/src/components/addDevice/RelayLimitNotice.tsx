import { Network } from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { relayLimitSentence, relayLimitTime } from './relayLimit';

/** The full reason as tooltip content, wrapped to a readable width. */
export function RelayLimitTip({ until }: { until: string }) {
  return <span className="block max-w-xs whitespace-normal">{relayLimitSentence(until)}</span>;
}

/**
 * Pane relay can't pair new devices while the CA turns this computer away (`RelayStatus.certificateLimit`):
 * one short line, the full reason on hover, and the way that still works.
 */
export function RelayLimitNotice({ until, onSetUpTailscale }: { until: string; onSetUpTailscale: () => void }) {
  return (
    <div role="status" className="space-y-2">
      <Tooltip content={<RelayLimitTip until={until} />} side="bottom">
        <p tabIndex={0} className="text-sm font-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle">
          New pairings through Pane relay are paused until {relayLimitTime(until)}
        </p>
      </Tooltip>
      <p className="text-sm text-text-secondary">This week&apos;s certificate limit is used up. Tailscale still works.</p>
      <Button type="button" variant="secondary" size="sm" icon={<Network className="h-4 w-4" />} onClick={onSetUpTailscale}>
        Set up Tailscale
      </Button>
    </div>
  );
}
