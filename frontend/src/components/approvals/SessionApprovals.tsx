import { Inbox, MessageSquare } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { LOCAL_MACHINE_ID } from '../../../../shared/types/machineConnections';
import { openSessionApproval, useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { openOnMachine } from '../../utils/machineRowActions';
import { ApprovalColumn } from './ApprovalColumn';
import { firstToOpen, readyCount, sessionApprovals } from './approvalCard';
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
 * A click on a Session row's count (J15): opens the Session's newest ready-again approval, or its
 * first waiting one, beside the Session the row's click opens.
 */
export function openApprovalsFromCount(target: EventTarget, sessionId: string): void {
  if (!(target instanceof Element) || target.closest('[data-opens-approvals]')?.getAttribute('data-opens-approvals') !== sessionId) return;
  const first = firstToOpen(sessionApprovals(selectNotifyItems(useNotifyStore.getState()), sessionId));
  if (first) openSessionApproval(sessionId, first.id);
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
      renderOrigin={(item) => <AskedIn item={item} />}
    />
  );
}

/** The tab where it was asked, when that isn't the chat you're in: one click away. */
function AskedIn({ item }: { item: NotifyItem }) {
  const paneId = item.source.paneId;
  return (
    <div className="flex flex-col items-start gap-2 p-6 text-[13.5px] text-text-secondary" data-testid="approval-origin">
      <p>{item.source.name} asked this in its own tab.</p>
      {paneId && (
        <button type="button" onClick={() => void openOnMachine(item.machineId ?? LOCAL_MACHINE_ID, { kind: 'pane', id: paneId, name: item.source.name })}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-surface-tertiary px-3 font-medium text-text-primary hover:bg-surface-hover">
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" /> Open {item.source.name}
        </button>
      )}
    </div>
  );
}
