import type { ReactNode } from 'react';
import { sessionWaitingCount, useNotifyStore } from '../../stores/notifyStore';
import { readyCount } from './approvalCard';
import { useSessionApprovals } from './useSessionApprovals';

/**
 * A Session row's indicator (D-38): the amber count of approvals waiting from it, or, at zero,
 * whatever the row shows otherwise. Both sit in one fixed-height box, so the row never shifts.
 * A blue dot says one came back ready again. With `opensApprovals`, a click on the count also
 * opens the Session's newest ready-again approval, or its first waiting one (J15); the row's own
 * click opens the Session.
 */
export function SessionApprovalsCount({ sessionId, machineId, otherwise, opensApprovals = false }: { sessionId: string; machineId?: string; otherwise: ReactNode; opensApprovals?: boolean }) {
  const count = useNotifyStore((state) => sessionWaitingCount(state.snapshot, sessionId, machineId));
  const waiting = useSessionApprovals(sessionId);
  const ready = readyCount(waiting);
  return (
    <span className="pointer-events-none ml-auto inline-flex h-[18px] shrink-0 items-center justify-end gap-1.5">
      {count > 0 && ready > 0 && (
        <span className="flex h-2 w-2 items-center justify-center" aria-label={`${ready} ready again`} data-testid="session-approvals-ready-dot">
          <span className="h-1.5 w-1.5 rounded-full bg-status-info" />
        </span>
      )}
      {count > 0
        ? (
          <span
            className={`${opensApprovals ? 'pointer-events-auto cursor-pointer' : ''} inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-status-warning px-[5px] text-[11px] font-semibold tabular-nums text-text-on-status-warning`}
            aria-label={`${count} ${count === 1 ? 'approval' : 'approvals'} waiting`}
            data-testid="session-approvals-count"
            // Inside the row's button: the row's click opens the Session, and on the count, its approvals too.
            data-opens-approvals={opensApprovals ? sessionId : undefined}
          >
            {count}
          </span>
        )
        : otherwise}
    </span>
  );
}
