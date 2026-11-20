import { Network } from 'lucide-react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

/** When the CA takes new computers again, in this computer's clock: "4:47 PM", or "Sat 4:47 PM" on another day. */
export function relayLimitTime(until: string, now = new Date()): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** The full reason, for tooltips. */
export function relayLimitSentence(until: string): string {
  return `Not accepting new phone pairings through Pane relay right now: this week's certificate limit is used up. Try again after ${relayLimitTime(until)}, or connect with Tailscale instead.`;
}

/** The full reason as tooltip content, wrapped to a readable width. */
export function relayLimitTip(until: string) {
  return <span className="block max-w-xs whitespace-normal">{relayLimitSentence(until)}</span>;
}

/**
 * Pane relay can't pair new devices while the CA turns this computer away (`RelayStatus.certificateLimit`):
 * one short line, the full reason on hover, and the way that still works.
 */
export function RelayLimitNotice({ until, onSetUpTailscale }: { until: string; onSetUpTailscale: () => void }) {
  return (
    <div role="status" className="space-y-2">
      <Tooltip content={relayLimitTip(until)} side="bottom">
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
