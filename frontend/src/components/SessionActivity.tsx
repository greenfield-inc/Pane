import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { useOrchestrationSessionActivity } from '../hooks/useAgentStatus';
import { AgentActivityDot, AgentStatusDot } from './ui/AgentStatusDot';

interface SessionActivityProps {
  session: OrchestrationSessionRecord;
  paneIds: readonly string[];
}

/** Rolled-up agent status for a Session: its orchestrator plus child Panes. */
export function SessionActivityDot({ session, paneIds }: SessionActivityProps) {
  const { status } = useOrchestrationSessionActivity(session.internalSessionId, paneIds);
  return status === 'unknown'
    ? <AgentActivityDot active={false} size="sm" className="flex-shrink-0" />
    : <AgentStatusDot status={status} size="sm" className="flex-shrink-0" />;
}

/** How much delegated work is in flight, in place of the plain child count. */
export function SessionActivitySummary({ session, paneIds }: SessionActivityProps) {
  const { working, blocked } = useOrchestrationSessionActivity(session.internalSessionId, paneIds);
  if (blocked > 0) return <span className="pr-1 text-[10px] tabular-nums text-status-error">{blocked} need{blocked === 1 ? 's' : ''} input</span>;
  if (working > 0) return <span className="pr-1 text-[10px] tabular-nums text-text-secondary">{working} working</span>;
  if (paneIds.length === 0) return null;
  return <span className="pr-1 text-[10px] tabular-nums text-text-muted">{paneIds.length}</span>;
}
