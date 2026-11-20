import { Radio } from 'lucide-react';

/**
 * The line under a streamed tab's address bar: the page shown is the host's own, live, and Back to my
 * copy loads the page's current URL in this screen's own copy.
 */
export function LiveChip({ host, onBack }: { host: string; onBack(): void }) {
  return (
    <div className="flex h-7 flex-shrink-0 items-center gap-1.5 border-b border-border-primary bg-bg-chrome px-3 text-xs text-text-secondary" data-testid="browser-live-chip">
      <Radio className="h-3.5 w-3.5 flex-shrink-0 text-interactive" />
      <span className="min-w-0 flex-1 truncate" title={`This tab shows the page on ${host}, where the agent works.`}>Live from {host}</span>
      <button type="button" className="flex-shrink-0 text-interactive hover:text-interactive-hover" onClick={onBack}>Back to my copy</button>
    </div>
  );
}
