import type { ReactNode } from 'react';
import { sessionWaitingCount, useNotifyStore } from '../../stores/notifyStore';

/**
 * A Session row's indicator (D-38): the amber count of approvals waiting from it, or, at zero,
 * whatever the row shows otherwise. Both sit in one fixed-height box, so the row never shifts.
 */
export function SessionApprovalsCount({ sessionId, machineId, otherwise }: { sessionId: string; machineId?: string; otherwise: ReactNode }) {
  const count = useNotifyStore((state) => sessionWaitingCount(state.snapshot, sessionId, machineId));
  return (
    <span className="pointer-events-none ml-auto inline-flex h-[18px] shrink-0 items-center justify-end">
      {count > 0
        ? (
          <span
            className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-status-warning px-[5px] text-[11px] font-semibold tabular-nums text-text-on-status-warning"
            aria-label={`${count} ${count === 1 ? 'approval' : 'approvals'} waiting`}
            data-testid="session-approvals-count"
          >
            {count}
          </span>
        )
        : otherwise}
    </span>
  );
}
