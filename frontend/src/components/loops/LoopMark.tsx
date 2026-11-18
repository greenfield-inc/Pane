import { Repeat } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * A loop's Session or run Pane in the main sidebar lists, where it shows only while a card from
 * it waits: the loop icon in the status dot's box (same footprint, so the swap never shifts the
 * row), amber like a waiting dot.
 */
export function LoopMark({ loopName, className }: { loopName: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-3 w-3 flex-shrink-0 items-center justify-center text-status-warning', className)}
      role="status"
      aria-label={`Loop ${loopName}: waiting on you`}
      data-testid="loop-mark"
    >
      <Repeat className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

/** "Loop: <name>", where a waiting row says "Waiting". */
export function LoopLabel({ loopName }: { loopName: string }) {
  return <span className="ml-auto min-w-0 max-w-[45%] shrink truncate pl-1 text-[11px] text-status-warning-on-tint">Loop: {loopName}</span>;
}
