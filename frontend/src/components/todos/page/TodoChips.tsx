import { useState, type ReactNode } from 'react';
import { Check, FileText, ListTree, Monitor, GitPullRequest, Paperclip } from 'lucide-react';
import type { TodoDetail, TodoShownStatus } from '../../../../../shared/types/todos';
import { cn } from '../../../utils/cn';
import { TODO_STATUS_LABEL, TodoStatusIcon } from '../TodoStatusIcon';
import { openTodoSession } from './todoNavigation';
import { AgentAvatar } from './TodoPageParts';
import { AttachField } from './TodoAttach';

/** The status chip's tint for the statuses that carry one; the rest stay plain. */
const STATUS_TINT = {
  waiting: 'border-status-warning/55 bg-status-warning/10',
  working: 'border-status-info/40',
  queued: 'bg-surface-tertiary',
  idle: '',
  snoozed: '',
  done: '',
  dropped: '',
} as const satisfies Record<TodoShownStatus, string>;

const CHIP = 'inline-flex h-6 shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[7px] border border-border-primary bg-surface-primary px-2 text-[12px] text-text-secondary outline-none hover:border-border-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus';

export interface TodoChipsProps {
  detail: TodoDetail;
  /** The split's tabs: how many, and the one "Plan · 5 files" names. */
  splitCount: number;
  splitLead: string | null;
  splitHidden: boolean;
  onOpenApproval: (approvalId: string) => void;
  /** The PR's tab in the split, when it is attached; otherwise the PR's page. */
  onOpenPr: () => void;
  onScrollToSubTodos: () => void;
  onOpenDetails: () => void;
  onShowSplit: () => void;
  onAttached: (target: string) => void;
  /** The agents chip: the to-do's Session. The web app opens it there; the desktop by default. */
  onOpenSession?: () => void;
}

/** A PR attached as a link when Pane hasn't seen it on a Pane (round 7 QA, R3): its number, from the URL. */
function attachedPr(detail: TodoDetail): TodoDetail['pr'] {
  const own = detail.attachments.find((group) => !group.from)?.attachments ?? [];
  const link = own.find((attachment) => attachment.kind === 'pr');
  if (!link) return undefined;
  const number = Number(/\/pull\/(\d+)/.exec(link.target)?.[1] ?? 0);
  return { number, label: number ? `#${number}` : link.label, url: link.target };
}

/**
 * The key details under the title (round 7, D-419): status (and its reason), agents, PR and checks,
 * sub-to-do progress and machine. Each chip opens what it names. While the split is hidden a
 * "Plan · 5 files" chip opens it; with nothing attached the row offers + Attach instead.
 */
export function TodoChips({ detail, splitCount, splitLead, splitHidden, onOpenApproval, onOpenPr, onScrollToSubTodos, onOpenDetails, onShowSplit, onAttached, onOpenSession }: TodoChipsProps) {
  const { status, todo } = detail;
  const [attaching, setAttaching] = useState(false);
  const waitingId = status.status === 'waiting' ? status.waitingApprovalId : undefined;
  const reason = status.status === 'waiting' && status.waitingQuestion
    ? [status.waitingQn, status.waitingQuestion].filter(Boolean).join(' · ')
    : status.status === 'working' ? '' : status.reason;
  const hasSession = Boolean(todo.sessionId ?? detail.parent?.todo.sessionId);
  const worker = todo.assignee;
  const subTotal = detail.subTodos.length;
  const subDone = detail.subTodos.filter((row) => row.status.status === 'done').length;
  const pr = detail.pr ?? attachedPr(detail);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="todo-chips">
      <Chip
        label={waitingId ? `${TODO_STATUS_LABEL[status.status]}: answer` : TODO_STATUS_LABEL[status.status]}
        onClick={waitingId ? () => onOpenApproval(waitingId) : onOpenDetails}
        className={cn('font-medium text-text-primary', STATUS_TINT[status.status])}
        testId="todo-chip-status"
      >
        <TodoStatusIcon status={status.status} />
        {TODO_STATUS_LABEL[status.status]}
      </Chip>
      {reason && <span className={cn('max-w-[280px] truncate text-[12px]', status.alert ? 'text-status-error' : 'text-text-tertiary')} title={reason} data-testid="todo-status-reason">{reason}</span>}
      <Chip label={worker ? `Open its Session: orchestrator and ${worker.name ?? 'its agent'}` : 'Open its Session'} onClick={onOpenSession ?? (() => openTodoSession(detail))} disabled={!hasSession} testId="todo-chip-agents">
        <span className="inline-flex items-center">
          <AgentAvatar agentId={detail.orchestrator?.agentId ?? todo.agent ?? undefined} name="orchestrator" className="h-4 w-4 rounded" />
          {worker && <AgentAvatar agentId={detail.agentId} name={worker.name ?? 'agent'} className="-ml-[3px] h-4 w-4 rounded ring-[1.5px] ring-surface-primary" />}
        </span>
        <b className="font-medium text-text-primary">orchestrator</b>
      </Chip>
      {pr && (
        <Chip label={`Open ${pr.label}`} onClick={onOpenPr} testId="todo-chip-pr">
          <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
          <PrLabel label={pr.label} />
        </Chip>
      )}
      {subTotal > 0 && (
        <Chip label={`Sub-to-dos: ${subDone} of ${subTotal} done`} onClick={onScrollToSubTodos} testId="todo-chip-subs">
          <ListTree className="h-3.5 w-3.5" aria-hidden="true" />
          <b className="font-medium tabular-nums text-text-primary">{subDone}/{subTotal}</b>
          <span className="inline-block h-1 w-11 overflow-hidden rounded bg-surface-tertiary" aria-hidden="true">
            <span className="block h-full bg-status-success" style={{ width: `${Math.round((subDone / subTotal) * 100)}%` }} />
          </span>
        </Chip>
      )}
      <Chip label={`Machine: ${detail.machine}. Show details`} onClick={onOpenDetails} testId="todo-chip-machine">
        <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
        <b className="font-medium text-text-primary">{detail.machine}</b>
      </Chip>
      {splitCount > 0 && splitHidden && (
        <Chip label="Show the split" onClick={onShowSplit} testId="todo-chip-plan">
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          <b className="max-w-[160px] truncate font-medium text-text-primary">{splitLead}</b>
          <span>· {splitCount} {splitCount === 1 ? 'file' : 'files'}</span>
        </Chip>
      )}
      {splitCount === 0 && (attaching
        ? <AttachField number={todo.number} onAttached={onAttached} onClose={() => setAttaching(false)} className="h-6" />
        : (
          <button type="button" onClick={() => setAttaching(true)} className={cn(CHIP, 'border-dashed')} data-testid="todo-chip-attach">
            <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
            Nothing attached yet · <span className="font-medium text-interactive-text">+ Attach</span>
          </button>
        ))}
    </div>
  );
}

function Chip({ children, label, onClick, disabled, className, testId }: {
  children: ReactNode; label: string; onClick: () => void; disabled?: boolean; className?: string; testId: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} className={cn(CHIP, 'disabled:cursor-default disabled:hover:border-border-primary', className)} data-testid={testId}>
      {children}
    </button>
  );
}

/** "#7 · checks passed" → "#7" and, after it, the checks in their colour. */
function PrLabel({ label }: { label: string }) {
  const [number, ...rest] = label.split(' · ');
  const checks = rest.join(' · ');
  const passed = /pass|green|success/i.test(checks);
  const failed = /fail|red|error/i.test(checks);
  return (
    <>
      <b className="font-medium text-text-primary">{number}</b>
      {checks && (
        <span className={cn('inline-flex items-center gap-0.5', passed ? 'text-status-success' : failed ? 'text-status-error' : 'text-text-tertiary')}>
          {passed && <Check className="h-3 w-3" aria-hidden="true" />}
          {checks}
        </span>
      )}
    </>
  );
}
