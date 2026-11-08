import { ChevronRight, CircleAlert, Navigation } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { cn } from '../../utils/cn';
import { runNotify } from '../../stores/notifyStore';
import { openSessionApproval, useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { relativeAge } from '../notify/notifyFormat';
import { useNow } from '../notify/useNow';
import { ApprovalChip } from './ApprovalColumn';
import { cardChip, isBeingRead, questionsOf } from './approvalCard';
import { useSessionApprovals } from './useSessionApprovals';

/** The dock holds this many cards; the rest are one click away in the column. */
const DOCKED_MAX = 2;

/**
 * Light approval cards in a Session's orchestrator chat (P5, D-219): docked above the composer,
 * each with its title, one line and, for a one-question approval, its options as buttons. A
 * button answers it; Open shows it in the column on the right.
 */
export function SessionApprovalCards({ sessionId }: { sessionId: string }) {
  const waiting = useSessionApprovals(sessionId);
  const openId = useApprovalColumnStore((state) => state.open[`session:${sessionId}`]?.itemId);
  if (waiting.length === 0) return null;
  const shown = waiting.slice(-DOCKED_MAX);
  const more = waiting.length - shown.length;
  return (
    <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 px-6 pb-2" data-testid="session-approval-cards">
      {more > 0 && (
        <button type="button" onClick={() => openSessionApproval(sessionId, waiting[0].id)} className="self-start text-[12.5px] font-medium text-interactive hover:underline">
          {more} more {more === 1 ? 'approval' : 'approvals'} waiting · Open
        </button>
      )}
      {shown.map((item) => <LightCard key={item.id} item={item} sessionId={sessionId} open={item.id === openId} />)}
    </div>
  );
}

function LightCard({ item, sessionId, open }: { item: NotifyItem; sessionId: string; open: boolean }) {
  const now = useNow();
  const questions = questionsOf(item);
  const chip = cardChip(item);
  // One question with options answers from here; anything more opens the column.
  const buttons = questions.length === 1 && item.ui === 'options' && !item.agentPrompt?.inTerminal && !isBeingRead(item) && !item.unreachable ? questions[0].choices : [];
  const qn = /^\s*(Q-\d+)/.exec(item.title)?.[1];
  const who = item.source.autopilot ? 'Autopilot' : item.source.session?.orchestrator ? `${item.source.session.name} orchestrator` : `${item.source.name}${item.originKind === 'worker' ? ', relayed' : ''}`;
  return (
    <div className={cn('rounded-2xl bg-surface-primary px-3.5 pb-2.5 pt-3 shadow-card ring-1', open ? 'ring-2 ring-interactive' : item.source.autopilot ? 'ring-autopilot-border' : 'ring-border-secondary')} data-testid="session-approval-card" data-item-id={item.id}>
      <div className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-wide text-text-tertiary">
        {item.source.autopilot ? <Navigation className="h-3.5 w-3.5 text-autopilot" aria-hidden="true" /> : <CircleAlert className="h-3.5 w-3.5 text-status-warning" aria-hidden="true" />}
        <span className="min-w-0 truncate">{item.source.autopilot ? 'Autopilot asks' : 'Approval'}{qn ? ` · ${qn}` : ''} · <span className="normal-case">{who}</span></span>
        <span className="ml-auto shrink-0 normal-case tabular-nums">{relativeAge(item.createdAt, now)}</span>
      </div>
      <p className="mt-1 text-[15px] font-semibold leading-snug text-text-primary">{item.title}</p>
      {item.context && <p className="truncate text-[13.5px] text-text-secondary">{item.context}</p>}
      {buttons.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {buttons.map((choice) => (
            <button key={choice.label} type="button" onClick={() => runNotify({ type: 'answer', id: item.id, answer: { picks: [choice.label] } })}
              className="rounded-lg border border-border-secondary px-2.5 py-1 text-[13px] font-semibold text-text-primary hover:bg-surface-hover" data-testid="session-approval-card-choice">
              {choice.label}{choice.recommended ? ' · recommended' : ''}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {chip && <ApprovalChip chip={chip} />}
        <button type="button" onClick={() => openSessionApproval(sessionId, item.id)}
          className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[13.5px] font-medium text-interactive hover:underline" data-testid="session-approval-card-open">
          Open on the right <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
