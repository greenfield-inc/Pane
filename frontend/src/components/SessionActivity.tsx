import type { OrchestrationSessionRecord, SessionActivity } from '../../../shared/types/orchestrationSession';
import { useSessionBlockedPaneCount } from '../hooks/useAgentStatus';
import { useSessionActivity } from '../services/sessionActivitySync';
import { cn } from '../utils/cn';

interface SessionActivityProps {
  session: OrchestrationSessionRecord;
  paneIds: readonly string[];
}

/**
 * A Session's activity icon (Option 1, D-363): Pane's working spinner while the host says the
 * Session is working, else an empty ring in the same fixed 12 px box. Never red: the approvals
 * count and the expanded Pane rows carry "needs input".
 */
export function SessionActivityIcon({ state, className }: { state: SessionActivity['state']; className?: string }) {
  const working = state === 'working';
  return (
    <span
      className={cn('inline-flex items-center justify-center w-3 h-3 flex-shrink-0', className)}
      role="status"
      aria-label={working ? 'Session working' : 'Session idle'}
      title={working ? 'Working' : 'Idle'}
      data-testid="session-activity-icon"
      data-state={state}
    >
      <span
        className={cn(
          'inline-block box-border w-3 h-3 rounded-full border-2',
          working ? 'border-status-info/30 border-t-status-info animate-spin' : 'border-text-muted/45',
        )}
      />
    </span>
  );
}

/** The Session row's icon, from the host's activity for this Session. */
export function SessionActivityDot({ session }: SessionActivityProps) {
  const { state } = useSessionActivity(session.id);
  return <SessionActivityIcon state={state} />;
}

/** How much delegated work is in flight, in place of the plain child count. */
export function SessionActivitySummary({ session, paneIds }: SessionActivityProps) {
  const blocked = useSessionBlockedPaneCount(paneIds);
  const { workingPanes } = useSessionActivity(session.id);
  return <SessionActivityCount blocked={blocked} working={workingPanes} panes={paneIds.length} />;
}

/** "N need input", else the host's "N working", else the plain Pane count. */
export function SessionActivityCount({ blocked, working, panes }: { blocked: number; working: number; panes: number }) {
  if (blocked > 0) return <span className="pr-1 text-[10px] tabular-nums text-status-error">{blocked} need{blocked === 1 ? 's' : ''} input</span>;
  if (working > 0) return <span className="pr-1 text-[10px] tabular-nums text-text-secondary">{working} working</span>;
  if (panes === 0) return null;
  return <span className="pr-1 text-[10px] tabular-nums text-text-muted">{panes}</span>;
}
