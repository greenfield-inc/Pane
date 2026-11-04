import { Inbox } from 'lucide-react';
import { useNavigationStore } from '../../stores/navigationStore';
import { useNotifyStore, waitingCount } from '../../stores/notifyStore';
import { cn } from '../../utils/cn';
import { toggleApprovals } from './approvalsNavigation';

/**
 * The title bar's Approvals badge, after the sidebar toggle: amber with the count while
 * something waits on you. It opens Approvals, and clicked again returns to the view you left.
 */
export function ApprovalsBadge({ compact = false }: { compact?: boolean }) {
  const enabled = useNotifyStore((state) => state.snapshot?.settings.enabled ?? false);
  const count = useNotifyStore((state) => waitingCount(state.snapshot));
  const open = useNavigationStore((state) => state.activeView === 'notify');
  if (!enabled) return null;
  const waiting = count > 0;
  return (
    <button
      type="button"
      data-testid="approvals-badge"
      aria-pressed={open}
      aria-label={waiting ? `Approvals, ${count} waiting` : 'Approvals'}
      title={open ? 'Back to where you were' : 'Approvals'}
      onClick={toggleApprovals}
      className={cn(
        'ml-1 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle',
        waiting
          ? 'border-status-warning bg-status-warning text-text-on-status-warning hover:bg-status-warning-hover'
          : 'border-border-primary bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
        open && !waiting && 'bg-surface-selected text-text-primary',
      )}
    >
      <Inbox className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {!compact && <span>Approvals</span>}
      {waiting && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-text-on-status-warning px-1 text-[11px] font-semibold tabular-nums text-status-warning" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );
}
