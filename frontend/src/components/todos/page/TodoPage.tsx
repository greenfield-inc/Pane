import { useCallback, useEffect, useReducer, useState } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal, Play, Square } from 'lucide-react';
import type { TodoAction, TodoDetail, TodoShownStatus } from '../../../../../shared/types/todos';
import { useTodoDetail, useTodosStore } from '../../../stores/todosStore';
import { todoApprovalSurface, useApprovalColumnStore } from '../../../stores/approvalColumnStore';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { cn } from '../../../utils/cn';
import { TodoStatusPill } from '../TodoStatusIcon';
import { isTypingTarget } from '../todosNavigation';
import { TodoCard } from './TodoCard';
import { TodoChatTimeline, TodoComposer } from './TodoChat';
import { TodoRail } from './TodoRail';
import { TodoSplit } from './TodoSplit';
import { openTodoSession } from './todoNavigation';
import { useOrchestrationSessionStore } from '../../../stores/orchestrationSessionStore';
import { openOnMachine } from '../../../utils/machineRowActions';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { CLOSED_SPLIT, todoSplitReducer, type TodoSplitAction, type TodoSplitItem } from './splitTabs';

export interface TodoPageProps {
  number: number;
  /** Back to the list (Esc, or the "To-dos" breadcrumb). */
  onBack: () => void;
  /** Open another to-do's page (a sub-to-do, or the parent from the breadcrumb). */
  onOpenTodo: (number: number) => void;
}

/**
 * One to-do's page (round 6, D-407): the breadcrumb and actions, the title and status line, the
 * card, the to-do's chat with its composer, and the details rail, which a split of approvals,
 * attachments and images replaces while any is open. Each to-do opens fresh: no split carried over.
 */
export function TodoPage(props: TodoPageProps) {
  return <TodoPageView key={props.number} {...props} />;
}

function TodoPageView({ number, onBack, onOpenTodo }: TodoPageProps) {
  const detail = useTodoDetail(number);
  const [split, dispatch] = useReducer(todoSplitReducer, CLOSED_SPLIT);
  const [notice, setNotice] = useState<string | null>(null);
  const open = useCallback((item: TodoSplitItem) => dispatch({ type: 'open', item }), []);
  const parentNumber = detail?.todo.parentNumber ?? null;
  const back = useCallback(() => (parentNumber !== null ? onOpenTodo(parentNumber) : onBack()), [parentNumber, onOpenTodo, onBack]);
  useEscape(split.items.length > 0, dispatch, back);
  // The split's approval column is this page's alone: leaving the page forgets it.
  useEffect(() => () => useApprovalColumnStore.getState().close(todoApprovalSurface(number)), [number]);

  if (!detail) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col bg-bg-primary" data-testid="todo-page" data-todo={number}>
        <PageHeader number={number} detail={null} onBack={onBack} onOpenTodo={onOpenTodo} onNotice={setNotice} />
        <p className="m-auto text-[13px] text-text-tertiary" role="status">Opening T-{number}…</p>
      </div>
    );
  }

  const active = split.items[split.active];
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg-primary" data-testid="todo-page" data-todo={number}>
      <PageHeader number={number} detail={detail} onBack={onBack} onOpenTodo={onOpenTodo} onNotice={setNotice} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-3 pt-5" data-testid="todo-page-scroll">
            <div className="mx-auto max-w-[760px]">
              <h1 className="mb-1.5 mt-2 text-[21px] font-semibold leading-[1.3] text-text-primary" data-testid="todo-page-title">{detail.todo.title}</h1>
              <StatusLine detail={detail} onAnswer={(id) => open({ kind: 'approval', id })} />
              {notice && <p className="mt-2 text-[12.5px] text-text-secondary" role="status" data-testid="todo-page-notice">{notice}</p>}
              <TodoCard detail={detail} onOpenTodo={onOpenTodo} onOpenImage={(src, label) => open({ kind: 'image', src, label })} />
              <TodoChatTimeline detail={detail} openApprovalId={active?.kind === 'approval' ? active.id : undefined} onOpenApproval={(id) => open({ kind: 'approval', id })} />
            </div>
          </div>
          <TodoComposer key={detail.chatTarget.panelId ?? 'orchestrator'} detail={detail} />
        </div>
        <aside className={cn('flex min-h-0 shrink-0 flex-col border-l border-border-primary', split.items.length > 0 ? 'w-[470px] bg-bg-primary' : 'w-[360px] bg-bg-secondary')} data-testid="todo-page-side">
          {split.items.length > 0
            ? <TodoSplit detail={detail} split={split} dispatch={dispatch} />
            : <TodoRail detail={detail} onOpenAttachment={(attachment) => open({ kind: 'attachment', attachment })} onOpenTodo={onOpenTodo} />}
        </aside>
      </div>
    </div>
  );
}

/**
 * Esc closes the split's open tab first, then goes back. It leaves alone a key someone else took
 * (a menu, a dialog, a field's own Esc) and typing in a field.
 */
function useEscape(splitOpen: boolean, dispatch: (action: TodoSplitAction) => void, back: () => void): void {
  useEffect(() => {
    // A menu or dialog closes on this same Esc, before it reaches the window: note whether one was
    // open as the key went down, so its Esc never also leaves the page.
    let overlayOpen = false;
    const onCapture = (event: KeyboardEvent) => {
      if (event.key === 'Escape') overlayOpen = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || overlayOpen || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target) || (event.target instanceof HTMLElement && event.target.tagName === 'WEBVIEW')) return;
      event.preventDefault();
      if (splitOpen) dispatch({ type: 'close-active' });
      else back();
    };
    document.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [splitOpen, dispatch, back]);
}

/** The pill's tint for the statuses that carry one; the rest stay plain. */
const PILL_TINT = {
  waiting: 'border-status-warning/55 bg-status-warning/10',
  working: 'border-status-info/40',
  queued: 'bg-surface-tertiary',
  idle: '',
  done: '',
  dropped: '',
} as const satisfies Record<TodoShownStatus, string>;

/** The status pill, the words after it, and on Waiting on you the question with Answer. */
function StatusLine({ detail, onAnswer }: { detail: TodoDetail; onAnswer: (approvalId: string) => void }) {
  const { status } = detail;
  const waiting = status.status === 'waiting';
  const reason = waiting && status.waitingQuestion
    ? [status.waitingQn, status.waitingQuestion].filter(Boolean).join(' · ')
    : status.status === 'working' ? '' : status.reason;
  const waitingId = status.waitingApprovalId;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="todo-status-line">
      <TodoStatusPill status={status.status} className={cn('h-[26px] rounded-[7px] px-[9px] text-[12.5px] font-medium', PILL_TINT[status.status])} />
      {reason && <span className={cn('text-[12.5px]', status.alert ? 'text-status-error' : 'text-text-secondary')} data-testid="todo-status-reason">{reason}</span>}
      {waiting && waitingId && (
        <button type="button" onClick={() => onAnswer(waitingId)} className="inline-flex h-7 items-center gap-0.5 rounded-[7px] bg-interactive px-2.5 text-[12.5px] font-medium text-text-on-interactive hover:bg-interactive-hover" data-testid="todo-answer">
          Answer{status.waitingQn ? ` ${status.waitingQn}` : ''} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

const BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2.5 text-[12.5px]';
const PLAIN_BUTTON = cn(BUTTON, 'border-border-primary bg-surface-primary text-text-primary hover:border-border-hover');
const PRIMARY_BUTTON = cn(BUTTON, 'border-transparent bg-interactive font-medium text-text-on-interactive hover:bg-interactive-hover');

/** The page's one state action: Start anyway, Start, Resume or Stop; none once it is closed. */
interface StateAction {
  label: string;
  action: TodoAction;
  primary: boolean;
}

function stateAction(detail: TodoDetail): StateAction | null {
  const { todo, status } = detail;
  const number = todo.number;
  if (status.status === 'done' || status.status === 'dropped') return null;
  if (status.status === 'queued') return { label: 'Start anyway', action: { kind: 'start', number, anyway: true }, primary: true };
  if (todo.state === 'todo') return { label: 'Start', action: { kind: 'start', number }, primary: true };
  if (todo.state === 'stopped') return { label: 'Resume', action: { kind: 'resume', number }, primary: true };
  return { label: 'Stop', action: { kind: 'stop', number }, primary: false };
}

/** ⋯: Drop while open; Archive (with its result line) and Reopen once closed; and its Session. */
function moreMenu(detail: TodoDetail, run: (action: TodoAction) => Promise<void>): DropdownItem[] {
  const number = detail.todo.number;
  const closed = detail.status.status === 'done' || detail.status.status === 'dropped';
  const items: DropdownItem[] = [];
  if (closed) {
    items.push({ id: 'archive', label: 'Archive', description: 'Archives its Session’s Panes that are safe to archive', onClick: () => void run({ kind: 'archive', number }) });
    items.push({ id: 'reopen', label: 'Reopen', onClick: () => void run({ kind: 'reopen', number }) });
  } else {
    items.push({ id: 'drop', label: 'Drop', variant: 'danger', onClick: () => void run({ kind: 'drop', number }) });
  }
  const hasSession = Boolean(detail.todo.sessionId ?? detail.parent?.todo.sessionId);
  items.push({ id: 'session', label: 'Session · Open', description: 'Its own Session, hidden from the sidebar', separatorBefore: true, disabled: !hasSession, onClick: () => openTodoSession(detail) });
  return items;
}

/** "‹ To-dos   <Session> › T-12", or on a sub-to-do "‹ T-12   <Session> › T-12 › T-14"; then the actions. */
function PageHeader({ number, detail, onBack, onOpenTodo, onNotice }: {
  number: number; detail: TodoDetail | null; onBack: () => void; onOpenTodo: (number: number) => void; onNotice: (line: string | null) => void;
}) {
  const act = useTodosStore((state) => state.act);
  const run = async (action: TodoAction) => {
    const result = await act(action);
    onNotice(result?.message ?? null);
  };
  const parent = detail?.parent;
  // Where the work came from, as the list groups it: the requesting Session (the top-level to-do's,
  // for a sub-to-do), else the to-do's own Session.
  const requesterSessionId = (parent?.todo ?? detail?.todo)?.requester.sessionId;
  const requesterSession = useOrchestrationSessionStore((state) => (requesterSessionId ? state.sessions.find((session) => session.id === requesterSessionId) : undefined));
  const crumb = requesterSession ? { name: requesterSession.name, open: () => void openOnMachine(detail?.machineId ?? LOCAL_MACHINE_ID, { kind: 'session', id: requesterSession.id, name: requesterSession.name }) }
    : detail?.sessionName ? { name: detail.sessionName, open: () => openTodoSession(detail) } : null;
  const closed = detail ? detail.status.status === 'done' || detail.status.status === 'dropped' : false;
  const primary = detail ? stateAction(detail) : null;
  const menu = detail ? moreMenu(detail, run) : [];
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border-primary px-4" data-testid="todo-page-header">
      <button type="button" onClick={parent ? () => onOpenTodo(parent.todo.number) : onBack} title="Back (Esc)" className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-[7px] px-1.5 text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text-primary" data-testid="todo-page-back">
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {parent ? parent.todo.ref : 'To-dos'}
      </button>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-tertiary" data-testid="todo-breadcrumb">
        {crumb && (
          <>
            <button type="button" onClick={crumb.open} className="min-w-0 max-w-[260px] truncate text-text-secondary hover:text-text-primary hover:underline">{crumb.name}</button>
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          </>
        )}
        {parent && (
          <>
            <button type="button" onClick={() => onOpenTodo(parent.todo.number)} className="shrink-0 text-text-secondary hover:text-text-primary hover:underline">{parent.todo.ref}</button>
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          </>
        )}
        <b className="shrink-0 font-semibold text-text-primary" aria-current="page">T-{number}</b>
      </nav>
      <span className="flex-1" />
      {primary && (
        <button type="button" onClick={() => void run(primary.action)} className={primary.primary ? PRIMARY_BUTTON : PLAIN_BUTTON} data-testid="todo-page-state-action">
          {primary.primary ? <Play className="h-3 w-3 fill-current" aria-hidden="true" /> : <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />}
          {primary.label}
        </button>
      )}
      {detail && !closed && <button type="button" onClick={() => void run({ kind: 'done', number })} className={PLAIN_BUTTON} data-testid="todo-page-done">Mark done</button>}
      {detail && (
        <Dropdown
          trigger={<button type="button" aria-label="More" className="inline-flex h-7 w-8 items-center justify-center rounded-[7px] text-text-secondary hover:bg-surface-hover" data-testid="todo-page-more"><MoreHorizontal className="h-4 w-4" aria-hidden="true" /></button>}
          items={menu}
          position="bottom-right"
          width="lg"
          menuLabel={`${detail.todo.ref} actions`}
        />
      )}
    </div>
  );
}
