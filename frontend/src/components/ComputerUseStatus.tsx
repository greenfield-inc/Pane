import { Loader2 } from 'lucide-react';
import { cn } from '../utils/cn';
import { computerUseStatusText, type ComputerUseReadiness, type ComputerUseState } from '../../../shared/types/computerUse';

const DOT_CLASS = {
  off: 'bg-status-neutral',
  'needs-permission': 'bg-status-warning',
  'no-desktop': 'bg-status-warning',
  failed: 'bg-status-error',
  ready: 'bg-status-success',
} satisfies Record<Exclude<ComputerUseState, 'installing'>, string>;

interface ComputerUseStatusProps {
  readiness: ComputerUseReadiness;
  now: number;
  /** Shown after the status: "Open System Settings" or "View details". */
  onAction?: () => void;
  className?: string;
}

function computerUseActionLabel(readiness: ComputerUseReadiness): string | null {
  if (readiness.state === 'needs-permission') return 'Open System Settings';
  if (readiness.state === 'failed') return 'View details';
  return null;
}

/** "Computer use: <status>" in a fixed-height row; the indicator swaps inside one fixed box. */
export function ComputerUseStatus({ readiness, now, onAction, className }: ComputerUseStatusProps) {
  const actionLabel = onAction ? computerUseActionLabel(readiness) : null;
  const text = `Computer use: ${computerUseStatusText(readiness, now)}`;
  return (
    <div className={cn('flex h-5 min-w-0 items-center gap-2 text-xs', className)} aria-live="polite">
      <span className="flex h-4 w-4 flex-none items-center justify-center" aria-hidden="true">
        {readiness.state === 'installing'
          ? <Loader2 className="h-3.5 w-3.5 animate-spin text-text-tertiary" />
          : <span className={cn('h-2 w-2 rounded-full', DOT_CLASS[readiness.state])} />}
      </span>
      <span className="min-w-0 truncate text-text-secondary" title={text}>{text}</span>
      {actionLabel && (
        <>
          <span className="text-text-muted" aria-hidden="true">·</span>
          <button
            type="button"
            className="flex-none text-interactive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
            onClick={(event) => { event.stopPropagation(); onAction?.(); }}
          >
            {actionLabel}
          </button>
        </>
      )}
    </div>
  );
}
