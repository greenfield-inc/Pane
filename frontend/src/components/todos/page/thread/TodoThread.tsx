import { useCallback, useMemo, useState } from 'react';
import type { TodoDetail } from '../../../../../../shared/types/todos';
import { buildTodoThread } from '../../../../../../shared/todoThread';
import { selectNotifyItems, useNotifyStore } from '../../../../stores/notifyStore';
import { useNow } from '../../../notify/useNow';
import { ApprovalCard, CommentCard, EventFold, EventLine, RunCard, type ThreadContext } from './ThreadCards';
import { todoMidTurnTabs, todoThreadApprovals } from './threadInputs';

export interface TodoThreadProps {
  detail: TodoDetail;
  /** The approval shown over the split, if any: its card is ringed. */
  openApprovalId?: string;
  /** Approval cards and a run's "Waiting on you" open the approval. */
  onOpenApproval?: (id: string) => void;
  /** An attachment named in the thread opens in the split. */
  onOpenAttachment?: (attachmentId: number) => void;
}

/** Which folds and run cards the person opened, by item key; this page's view state only. */
function useOpenKeys(): [ReadonlySet<string>, (key: string) => void] {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }), []);
  return [open, toggle];
}

/**
 * The to-do's thread, Linear-style (round 7): event lines and folds, agent run cards, comment cards
 * with their replies, and approval cards, worked out by `buildTodoThread` from the stored rows.
 */
export function TodoThread({ detail, openApprovalId, onOpenApproval, onOpenAttachment }: TodoThreadProps) {
  const notifyItems = useNotifyStore(selectNotifyItems);
  const approvals = useMemo(() => todoThreadApprovals(notifyItems, detail.approvalIds), [notifyItems, detail.approvalIds]);
  const midTurnKey = [...todoMidTurnTabs(detail)].sort().join('\n');
  const items = useMemo(
    () => buildTodoThread({ activity: detail.activity, approvals, midTurnTabs: new Set(midTurnKey ? midTurnKey.split('\n') : []) }),
    [detail.activity, approvals, midTurnKey],
  );
  const now = useNow();
  const [open, toggle] = useOpenKeys();
  const ctx: ThreadContext = { detail, now, openApprovalId, onOpenApproval, onOpenAttachment };
  return (
    <section aria-label="Activity" data-testid="todo-chat" data-items={items.length}>
      <div className="mb-1.5 mt-[22px] text-[11px] font-semibold uppercase tracking-[0.06em] text-text-tertiary" data-testid="todo-chat-divider">Activity</div>
      {items.map((item) => {
        if (item.kind === 'event') return <EventLine key={item.key} event={item.event} ctx={ctx} />;
        if (item.kind === 'fold') return <EventFold key={item.key} fold={item.fold} open={open.has(item.key)} onToggle={() => toggle(item.key)} ctx={ctx} />;
        if (item.kind === 'run') return <RunCard key={item.key} run={item.run} open={open.has(item.key)} onToggle={() => toggle(item.key)} ctx={ctx} />;
        if (item.kind === 'comment') return <CommentCard key={item.key} comment={item.comment} ctx={ctx} />;
        return <ApprovalCard key={item.key} approval={item.approval} ctx={ctx} />;
      })}
    </section>
  );
}
