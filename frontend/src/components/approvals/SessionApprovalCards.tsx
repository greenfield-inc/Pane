import { useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleAlert, Loader2, Navigation, Sparkles, X } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { approvalStatus, approvalQn, type ApprovalStatus } from '../../../../shared/approvalStatus';
import { cn } from '../../utils/cn';
import { runNotify, selectNotifyItems, useNotifyStore } from '../../stores/notifyStore';
import { openSessionApproval, useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { dockApprovals, latestReplied, questionsOf, referenceCount, statusKey } from './approvalCard';
import { useSessionApprovals } from './useSessionApprovals';

/**
 * A Session chat's approvals (P6, D-347): one compact card at a time above the composer, its
 * title and subtitle across the card, and ‹ n of m ›, the reference count and Open on a bottom
 * row. The options live in the column on the right, which Open shows; the two pagers stay in
 * step. Above it, after a Send, one status line says who is reading the reply and how it was
 * taken (P7). The chat's own AskUserQuestion is left out: the chat already shows Claude's card (P5).
 */
export function SessionApprovalCards({ sessionId, chatPanelId }: { sessionId: string; chatPanelId?: string }) {
  const waiting = useSessionApprovals(sessionId);
  const pager = useMemo(() => dockApprovals(waiting, chatPanelId), [waiting, chatPanelId]);
  const openId = useApprovalColumnStore((state) => state.open[`session:${sessionId}`]?.itemId);
  const [shownId, setShownId] = useState<string | undefined>();
  // The open card leads; else the one last paged to, while it still waits; else the first.
  const currentId = [openId, shownId].find((id) => id !== undefined && pager.some((item) => item.id === id)) ?? pager[0]?.id;
  const index = Math.max(0, pager.findIndex((item) => item.id === currentId));
  const item = pager[index];
  const step = (direction: 1 | -1) => {
    if (pager.length < 2) return;
    const next = pager[(index + direction + pager.length) % pager.length];
    setShownId(next.id);
    // The column's pager follows when it's open.
    if (openId) openSessionApproval(sessionId, next.id);
  };
  const status = <ReplyStatusLine sessionId={sessionId} />;
  if (!item) return <div className="mx-auto w-full max-w-[var(--thread-max-width)] px-6 empty:hidden">{status}</div>;
  return (
    <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 px-6 pb-2" data-testid="session-approval-cards">
      {status}
      <CompactCard item={item} index={index} total={pager.length} open={item.id === openId} onStep={step}
        onOpen={(tab) => useApprovalColumnStore.getState().openApproval(`session:${sessionId}`, item.id, tab)} />
    </div>
  );
}

function CompactCard({ item, index, total, open, onStep, onOpen }: {
  item: NotifyItem; index: number; total: number; open: boolean; onStep: (direction: 1 | -1) => void; onOpen: (tab?: string) => void;
}) {
  const now = useNow();
  const count = questionsOf(item).length;
  const qn = approvalQn(item);
  const who = item.source.autopilot ? 'Autopilot' : item.source.session?.orchestrator ? `${item.source.session.name} orchestrator` : item.source.name;
  const references = referenceCount(item);
  const stepButton = 'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border-secondary text-text-secondary hover:bg-surface-hover disabled:opacity-40';
  return (
    // The card open on the right gets a darker neutral outline and an "Open" label; blue stays for
    // whichever side has keyboard focus (D-336, D-343).
    <div className={cn('rounded-2xl bg-surface-primary px-4 pb-2.5 pt-3 shadow-card ring-1', open ? 'ring-text-tertiary' : item.source.autopilot ? 'ring-autopilot-border' : 'ring-border-secondary')}
      data-testid="session-approval-card" data-item-id={item.id} data-open={open || undefined}>
      <div className="flex items-center gap-1.5 text-[12.5px] text-text-tertiary">
        {/* Fixed box: the icon swaps, never its size. */}
        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
          {item.source.autopilot ? <Navigation className="h-3.5 w-3.5 text-autopilot" /> : <CircleAlert className="h-3.5 w-3.5 text-status-warning" />}
        </span>
        {qn && <span className="shrink-0 font-semibold text-status-warning-on-tint">{qn}</span>}
        <span className="min-w-0 truncate">{[qn ? '' : 'Approval', who, count > 1 ? `${count} questions` : count === 1 ? '1 question' : '', relativeAge(item.createdAt, now)].filter(Boolean).join(' · ')}</span>
        {open && <span className="ml-auto shrink-0 rounded-md bg-surface-secondary px-1.5 py-px text-[11px] font-semibold text-text-secondary" data-testid="session-approval-card-open-label">Open</span>}
      </div>
      <p className="mt-1 line-clamp-2 text-[15px] font-semibold leading-snug text-text-primary" data-testid="session-approval-card-title">{item.title}</p>
      {item.context && <p className="line-clamp-2 text-[13.5px] leading-snug text-text-secondary" data-testid="session-approval-card-subtitle">{item.context}</p>}
      <div className="mt-2 flex items-center gap-1.5 text-[13px]">
        <button type="button" className={stepButton} aria-label="Previous approval" disabled={total < 2} onClick={() => onStep(-1)} data-testid="session-approval-card-prev"><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
        <span className="tabular-nums text-text-tertiary" data-testid="session-approval-card-pager"><span className="font-semibold text-text-primary">{index + 1}</span> of {total}</span>
        <button type="button" className={stepButton} aria-label="Next approval" disabled={total < 2} onClick={() => onStep(1)} data-testid="session-approval-card-next"><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
        {total > 1 && (
          <span className="ml-1 flex items-center gap-1" aria-hidden="true">
            {Array.from({ length: Math.min(total, 8) }, (_, at) => (
              <span key={at} className="flex h-2 w-2 items-center justify-center"><span className={cn('h-1.5 w-1.5 rounded-full', at === index ? 'bg-interactive' : 'bg-border-hover')} /></span>
            ))}
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-1 text-text-tertiary">
          {references && <span className="truncate">{references} ·</span>}
          <button type="button" className="shrink-0 hover:text-text-primary hover:underline" onClick={() => onOpen('summary')} data-testid="session-approval-card-summary">Summary</button>
        </span>
        {!open && (
          <button type="button" onClick={() => onOpen()}
            className="ml-2 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-interactive px-3 text-[13px] font-medium text-text-on-interactive hover:bg-interactive-hover" data-testid="session-approval-card-open">
            Open <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

const LINE_TONE = {
  muted: 'bg-surface-tertiary text-text-secondary',
  warning: 'bg-status-warning/10 text-status-warning-on-tint',
  info: 'bg-status-info/10 text-status-info-on-tint',
  success: 'bg-status-success/10 text-status-success-on-tint',
} satisfies Record<ApprovalStatus['tone'], string>;

/**
 * After a Send (D-344): who is reading the reply, then how it was taken, with Reopen, for the
 * Session's approval replied to last. Only here, on that approval and its row: never on another.
 */
function ReplyStatusLine({ sessionId }: { sessionId: string }) {
  const items = useNotifyStore(selectNotifyItems);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const item = useMemo(() => latestReplied(items, sessionId, dismissed), [items, sessionId, dismissed]);
  const status = item ? approvalStatus(item, true) : null;
  if (!item || !status) return null;
  const Icon = status.kind === 'reading' ? Loader2 : status.kind === 'taken' || status.kind === 'sent' ? Check : status.kind === 'ready-again' ? Sparkles : CircleAlert;
  const fix = status.kind === 'taken' && !item.reply?.fixed ? { as: 'question' as const, label: 'It was a question' } : status.kind === 'asking' && !item.reply?.fixed ? { as: 'answer' as const, label: 'It was my answer' } : undefined;
  const dismiss = () => setDismissed((current) => new Set([...current, statusKey(item)]));
  return (
    <div className={cn('flex items-center gap-2 rounded-xl px-3.5 py-2 text-[13.5px]', LINE_TONE[status.tone])} role="status" data-testid="session-approval-status" data-kind={status.kind} data-item-id={item.id}>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        <Icon className={cn('h-3.5 w-3.5', status.kind === 'reading' && 'animate-spin')} />
      </span>
      <span className="min-w-0 flex-1 truncate">{status.text}{status.kind === 'reading' ? '…' : ''}</span>
      {fix && (
        <button type="button" className="shrink-0 font-medium text-interactive hover:underline" onClick={() => runNotify({ type: 'fix-reply', id: item.id, as: fix.as })} data-testid="session-approval-status-fix">{fix.label}</button>
      )}
      {(item.state === 'waiting' || item.state === 'answered') && (
        <button type="button" className="shrink-0 font-medium text-interactive hover:underline" data-testid="session-approval-status-reopen"
          // Opens it on the right as it stands now: waiting, or answered with its Override.
          onClick={() => openSessionApproval(sessionId, item.id)}>
          Reopen
        </button>
      )}
      {(status.kind === 'taken' || status.kind === 'sent' || status.kind === 'ready-again') && (
        <button type="button" aria-label="Dismiss" onClick={dismiss} className="shrink-0 text-text-tertiary hover:text-text-primary"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
      )}
    </div>
  );
}
