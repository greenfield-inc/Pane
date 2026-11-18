import { useEffect, useMemo, useRef } from 'react';
import { leadingQn } from '../../../../../shared/autopilotDecision';
import { countsAsWaiting, selectNotifyItems, useNotifyStore } from '../../../stores/notifyStore';
import { todoApprovalSurface, useApprovalColumnStore } from '../../../stores/approvalColumnStore';
import { useTodoDetail, useTodosStore } from '../../../stores/todosStore';
import { ApprovalColumn } from '../../approvals/ApprovalColumn';
import { PhoneHeader, PhoneScreen } from './phoneParts';

export interface PhoneTodoApprovalProps {
  number: number;
  id: string;
  /** The pager moved to another of the to-do's approvals. */
  onSelect: (id: string) => void;
  /** "‹ T-12", and after an accepted Send: back to the to-do, which then reads Working. */
  onBack: () => void;
}

/**
 * An approval on a phone (D-422): full screen with back, the approval column in its narrow mode
 * (the column measures itself), its pager walking the to-do's waiting approvals. Send returns to
 * the to-do (R25).
 */
export function PhoneTodoApproval({ number, id, onSelect, onBack }: PhoneTodoApprovalProps) {
  const detail = useTodoDetail(number);
  const items = useNotifyStore(selectNotifyItems);
  const item = items.find((candidate) => candidate.id === id);
  const surface = todoApprovalSurface(number);
  const linked = detail?.approvalIds;
  const order = useMemo(() => {
    const ids = new Set(linked ?? []);
    return items.filter((candidate) => ids.has(candidate.id) && countsAsWaiting(candidate)).sort((a, b) => a.createdAt - b.createdAt).map((candidate) => candidate.id);
  }, [items, linked]);
  // Each approval opens on its Q&A tab; the column keeps its own tab after that.
  useEffect(() => {
    const store = useApprovalColumnStore.getState();
    if (store.open[surface]?.itemId !== id) store.openApproval(surface, id);
  }, [surface, id]);
  // The column is this screen's alone: leaving it forgets it.
  useEffect(() => () => useApprovalColumnStore.getState().close(surface), [surface]);
  // A reminder's "Snooze to another time…" (round 9): back to the to-do, whose page opens the snooze sheet.
  const snoozeAsked = useTodosStore((state) => state.snoozeRequest === number);
  const wentBack = useRef(false);
  useEffect(() => {
    if (!snoozeAsked || wentBack.current) return;
    wentBack.current = true;
    onBack();
  }, [snoozeAsked, onBack]);
  const title = (item && leadingQn(item.title)) ?? (detail?.status.waitingApprovalId === id ? detail.status.waitingQn : undefined) ?? 'Approval';
  return (
    <PhoneScreen testId="phone-todo-approval">
      <PhoneHeader title={title} back={{ label: `T-${number}`, onBack }} />
      <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <ApprovalColumn
          surface={surface}
          itemId={id}
          order={order}
          onSelect={onSelect}
          groupLabel={`T-${number} approvals`}
          onSent={onBack}
        />
      </div>
    </PhoneScreen>
  );
}
