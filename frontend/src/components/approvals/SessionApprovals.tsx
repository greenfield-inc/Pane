import { Inbox } from 'lucide-react';
import { openSessionApproval, useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { ApprovalColumn } from './ApprovalColumn';
import { ApprovalOrigin } from './ApprovalOrigin';
import { firstToOpen, readyCount } from './approvalCard';
import { useSessionApprovals } from './useSessionApprovals';

/**
 * The Session header's count (P4): "Approvals 3 · 1 ready". Opens the column on the newest
 * ready-again approval, or the first waiting one. Nothing shows while nothing waits.
 */
export function SessionApprovalsButton({ sessionId }: { sessionId: string }) {
  const waiting = useSessionApprovals(sessionId);
  if (waiting.length === 0) return null;
  const ready = readyCount(waiting);
  return (
    <button
      type="button"
      onClick={() => { const first = firstToOpen(waiting); if (first) openSessionApproval(sessionId, first.id); }}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-status-warning/40 bg-status-warning/10 pl-2.5 pr-1 text-[12.5px] font-medium text-status-warning-on-tint hover:bg-status-warning/20"
      data-testid="session-approvals-button"
    >
      <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
      Approvals
      <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-status-warning px-[5px] text-[11px] font-semibold tabular-nums text-text-on-status-warning">{waiting.length}</span>
      {ready > 0 && <span className="rounded-full bg-status-info/15 px-2 py-px text-[11.5px] font-medium text-status-info-on-tint" data-testid="session-approvals-ready">{ready} ready</span>}
    </button>
  );
}

/**
 * The count again, as a button in a Session row's hover slot, where the row's "…" would cover the
 * plain count (J15): it opens the Session and its newest ready-again or first waiting approval.
 */
export function SessionApprovalsCountButton({ sessionId, onOpenSession }: { sessionId: string; onOpenSession: () => void }) {
  const waiting = useSessionApprovals(sessionId);
  if (waiting.length === 0) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        const first = firstToOpen(waiting);
        if (first) openSessionApproval(sessionId, first.id);
        onOpenSession();
      }}
      aria-label={`Open ${waiting.length} ${waiting.length === 1 ? 'approval' : 'approvals'}`}
      title="Open its approvals"
      className="mr-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-status-warning px-[5px] text-[11px] font-semibold tabular-nums text-text-on-status-warning hover:bg-status-warning-hover"
      data-testid="session-approvals-count-button"
    >
      {waiting.length}
    </button>
  );
}

/** The approval column for one Session: its pager walks the Session's waiting approvals. */
export function SessionApprovalColumn({ sessionId, sessionName, inChat, closeLabel, onClose }: {
  sessionId: string; sessionName: string; inChat?: string; closeLabel: string; onClose: () => void;
}) {
  const surface = `session:${sessionId}` as const;
  const open = useApprovalColumnStore((state) => state.open[surface]);
  const waiting = useSessionApprovals(sessionId);
  if (!open) return null;
  return (
    <ApprovalColumn
      surface={surface}
      itemId={open.itemId}
      order={waiting.map((item) => item.id)}
      onSelect={(id) => openSessionApproval(sessionId, id)}
      groupLabel={`${sessionName} approvals`}
      closeLabel={closeLabel}
      onClose={onClose}
      inChat={inChat}
      renderOrigin={(item) => <ApprovalOrigin item={item} />}
    />
  );
}
