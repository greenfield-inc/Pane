import { Radio } from 'lucide-react';

/** The text of the chip a streamed tab shows: whose page this is and whether an agent drives it. */
export function liveLabel(host: string, driving: boolean): string {
  return driving ? `Agent driving · live from ${host}` : `Live from ${host}`;
}

/**
 * The chip on a tab streamed from its host while an agent works there: it says so, and Back to my
 * copy loads the page's current URL in this screen's own copy.
 */
export function LiveChip({ host, driving, onBack }: { host: string; driving: boolean; onBack(): void }) {
  return (
    <span className="inline-flex min-w-0 max-w-[50%] flex-shrink items-center gap-1.5 rounded-full border border-interactive px-2 text-[11px] leading-5 text-text-primary" data-testid="browser-live-chip">
      <Radio className="h-3 w-3 flex-shrink-0 text-interactive" />
      <span className="truncate" title={`This tab shows the page on ${host}, where the agent works.`}>{liveLabel(host, driving)}</span>
      <button type="button" className="flex-shrink-0 text-interactive hover:text-interactive-hover" onClick={onBack}>Back to my copy</button>
    </span>
  );
}
