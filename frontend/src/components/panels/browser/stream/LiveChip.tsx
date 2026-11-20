import { Radio } from 'lucide-react';

/** The text of the line a streamed tab shows: whose page this is and whether an agent drives it. */
export function liveLabel(host: string, driving: boolean): string {
  return driving ? `Agent driving · live from ${host}` : `Live from ${host}`;
}

/**
 * The line under a streamed tab's address bar while an agent works on the host's page: it says so,
 * and Back to my copy loads the page's current URL in this screen's own copy.
 */
export function LiveChip({ host, driving, onBack }: { host: string; driving: boolean; onBack(): void }) {
  return (
    <div className="flex h-7 flex-shrink-0 items-center gap-1.5 border-b border-border-primary bg-bg-chrome px-3 text-xs text-text-secondary" data-testid="browser-live-chip">
      <Radio className="h-3.5 w-3.5 flex-shrink-0 text-interactive" />
      <span className="min-w-0 flex-1 truncate" title={`This tab shows the page on ${host}, where the agent works.`}>{liveLabel(host, driving)}</span>
      <button type="button" className="flex-shrink-0 text-interactive hover:text-interactive-hover" onClick={onBack}>Back to my copy</button>
    </div>
  );
}
