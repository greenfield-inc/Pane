import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, MoreHorizontal } from 'lucide-react';
import type { TodoAction, TodoDetail } from '../../../../../shared/types/todos';
import { snoozeRequestedFor, todosApi, useTodoDetail, useTodosStore } from '../../../stores/todosStore';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { SkeletonSwap } from '../../ui/Skeleton';
import { PhoneTodoPageSkeleton } from '../TodoSkeletons';
import { TodoCard, todoSubTodosAnchor } from '../page/TodoCard';
import { TodoChatTimeline, TodoComposer } from '../page/TodoChat';
import { TodoChips } from '../page/TodoChips';
import { stateAction } from '../page/TodoPage';
import { splitTabLabel } from '../page/TodoSplit';
import { attachmentTabs, splitItemKey } from '../page/splitTabs';
import { PHONE_ICON_BUTTON, PHONE_SCROLL, PHONE_SIDES, PhoneHeader, PhoneScreen, recalledScroll, rememberScroll, useKeyboardInset } from './phoneParts';
import { SnoozeBanner, canSnoozeTodo, snoozeActionOf } from '../page/TodoSnoozed';
import { PhoneSnoozeSheet } from './PhoneSnoozeSheet';

export interface PhoneTodoPageProps {
  number: number;
  /** "‹ To-dos", or "‹ T-12" on a sub-to-do. */
  onBack: () => void;
  onOpenTodo: (number: number) => void;
  /** Plan · Files: the attachments full screen, on `tab` (a split tab key) or the first. */
  onOpenFiles: (tab?: string) => void;
  onOpenApproval: (id: string) => void;
  onAddSubTodo: () => void;
  /** The to-do's Session, where the app can show it (the web app); none hides "Open its Session". */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * One to-do on a phone (D-422): one column with the title and its chips (wrapping), "Plan · 5 files",
 * the summary, Done when, sub-to-dos with + Add, and the thread; the composer pinned at the bottom,
 * above the home indicator and, while typing, above the keyboard. No split, no details sidebar.
 */
export function PhoneTodoPage(props: PhoneTodoPageProps) {
  const detail = useTodoDetail(props.number);
  const parent = detail?.parent;
  // Round 9: the snooze sheet, from ⋯, the banner's Change, or a reminder card's "Snooze to another time…".
  const [snoozing, setSnoozing] = useState(false);
  const request = useTodosStore((state) => state.snoozeRequest);
  const act = useTodosStore((state) => state.act);
  useEffect(() => {
    if (!snoozeRequestedFor(request, props.number) || !detail) return;
    useTodosStore.getState().requestSnooze(null);
    if (canSnoozeTodo(detail.todo)) setSnoozing(true);
  }, [request, props.number, detail]);
  const wake = () => {
    setSnoozing(false);
    void act({ kind: 'wake', number: props.number });
  };
  return (
    <PhoneScreen testId="phone-todo-page">
      <PhoneHeader
        title={`T-${props.number}`}
        back={{ label: parent ? parent.todo.ref : 'To-dos', onBack: props.onBack }}
        right={detail ? <MoreMenu detail={detail} onOpenSession={props.onOpenSession} onSnooze={() => setSnoozing(true)} /> : null}
      />
      <SkeletonSwap loading={!detail} skeleton={<PhoneTodoPageSkeleton number={props.number} />}>
        {detail && <PhoneTodoBody key={props.number} detail={detail} {...props} onChangeSnooze={() => setSnoozing(true)} onWake={wake} />}
      </SkeletonSwap>
      {detail && snoozing && (
        <PhoneSnoozeSheet
          detail={detail}
          onSubmit={(choice) => { setSnoozing(false); void act(snoozeActionOf(props.number, choice)); }}
          onWake={detail.todo.snooze ? wake : undefined}
          onClose={() => setSnoozing(false)}
        />
      )}
    </PhoneScreen>
  );
}

function PhoneTodoBody({ detail, onOpenTodo, onOpenFiles, onOpenApproval, onAddSubTodo, onOpenSession, onChangeSnooze, onWake }: PhoneTodoPageProps & { detail: TodoDetail; onChangeSnooze: () => void; onWake: () => void }) {
  const number = detail.todo.number;
  const scrollKey = `todo:${number}`;
  const scrollRef = useRef<HTMLDivElement>(null);
  const files = useMemo(() => attachmentTabs(detail.attachments), [detail.attachments]);
  const lead = files[0] ? splitTabLabel(files[0], files) : null;
  const keyboard = useKeyboardInset();
  const sessionId = detail.todo.sessionId ?? detail.parent?.todo.sessionId;

  // Back from its files or an approval lands where the page was.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = recalledScroll(scrollKey);
  }, [scrollKey]);

  // The keyboard coming up keeps the last thread item in view above the composer (R26).
  const atBottom = useRef(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (element && keyboard > 0 && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [keyboard]);
  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    rememberScroll(scrollKey, element.scrollTop);
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };

  const openPr = useCallback(() => {
    const tab = files.find((item) => item.kind === 'attachment' && item.attachment.kind === 'pr');
    if (tab) onOpenFiles(splitItemKey(tab));
    else if (detail.pr?.url) todosApi()?.openUrl(detail.pr.url);
  }, [files, detail.pr?.url, onOpenFiles]);
  const openAttachment = useCallback((attachmentId: number) => onOpenFiles(`attachment:${attachmentId}`), [onOpenFiles]);
  const scrollToSubTodos = useCallback(() => {
    document.getElementById(todoSubTodosAnchor(number))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [number]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ paddingBottom: keyboard }}>
      <div ref={scrollRef} onScroll={onScroll} className={PHONE_SCROLL} data-testid="phone-todo-scroll">
        <div className={`${PHONE_SIDES} pb-[18px] pt-3.5`}>
          <h2 className="mb-2.5 text-[20px] font-semibold leading-[1.3] text-text-primary [overflow-wrap:anywhere]" data-testid="todo-page-title">{detail.todo.title}</h2>
          <TodoChips
            detail={detail}
            splitCount={files.length}
            splitLead={lead}
            splitHidden={false}
            onOpenApproval={onOpenApproval}
            onOpenPr={openPr}
            onScrollToSubTodos={scrollToSubTodos}
            onOpenDetails={() => undefined}
            onShowSplit={() => onOpenFiles()}
            onAttached={() => undefined}
            onOpenSession={onOpenSession && sessionId ? () => onOpenSession(sessionId) : undefined}
          />
          <SnoozeBanner detail={detail} onChange={onChangeSnooze} onWake={onWake} stacked />
          {files.length > 0 && (
            <button type="button" onClick={() => onOpenFiles()} className="mb-0.5 mt-3 flex h-10 w-full items-center gap-2 rounded-[10px] border border-border-primary bg-surface-secondary px-3 text-[14px] text-text-primary outline-none active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-interactive" data-testid="phone-todo-files">
              <FileText className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <b className="min-w-0 truncate font-semibold">{lead}</b>
              <span className="shrink-0 text-text-tertiary">· {files.length} {files.length === 1 ? 'file' : 'files'}</span>
              <span className="flex-1" />
              <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
            </button>
          )}
          <TodoCard detail={detail} onOpenTodo={onOpenTodo} onOpenImage={() => undefined} onAddSubTodo={detail.todo.parentNumber === null ? onAddSubTodo : undefined} />
          <TodoChatTimeline detail={detail} onOpenApproval={onOpenApproval} onOpenAttachment={openAttachment} />
        </div>
      </div>
      <TodoComposer key={detail.chatTarget.panelId ?? 'orchestrator'} detail={detail} phone />
    </div>
  );
}

/** ⋯: the state action (Start, Resume, Stop), Mark done, Drop or Archive and Reopen, and its Session. */
function MoreMenu({ detail, onOpenSession, onSnooze }: { detail: TodoDetail; onOpenSession?: (sessionId: string) => void; onSnooze: () => void }) {
  const act = useTodosStore((state) => state.act);
  const [notice, setNotice] = useState<string | null>(null);
  const run = (action: TodoAction) => {
    void act(action).then((result) => setNotice(result?.message ?? null));
  };
  const number = detail.todo.number;
  const closed = detail.status.status === 'done' || detail.status.status === 'dropped';
  const primary = stateAction(detail);
  const sessionId = detail.todo.sessionId ?? detail.parent?.todo.sessionId;
  const items: DropdownItem[] = [];
  const snoozed = detail.todo.snooze !== undefined;
  if (canSnoozeTodo(detail.todo)) items.push({ id: 'snooze', label: snoozed ? 'Change snooze…' : 'Snooze…', onClick: onSnooze });
  if (snoozed) items.push({ id: 'wake', label: 'Wake now', onClick: () => run({ kind: 'wake', number }) });
  else if (primary) items.push({ id: 'state', label: primary.label, onClick: () => run(primary.action) });
  if (closed) {
    items.push({ id: 'archive', label: 'Archive', description: 'Archives its Session’s Panes that are safe to archive', onClick: () => run({ kind: 'archive', number }) });
    items.push({ id: 'reopen', label: 'Reopen', onClick: () => run({ kind: 'reopen', number }) });
  } else {
    items.push({ id: 'done', label: 'Mark done', onClick: () => run({ kind: 'done', number }) });
    items.push({ id: 'drop', label: 'Drop', variant: 'danger', onClick: () => run({ kind: 'drop', number }) });
  }
  if (onOpenSession) items.push({ id: 'session', label: 'Open its Session', separatorBefore: true, disabled: !sessionId, onClick: () => { if (sessionId) onOpenSession(sessionId); } });
  return (
    <>
      <Dropdown
        trigger={<button type="button" aria-label="More" className={PHONE_ICON_BUTTON} data-testid="phone-todo-more"><MoreHorizontal className="h-5 w-5" aria-hidden="true" /></button>}
        items={items}
        position="bottom-right"
        width="md"
        menuLabel={`${detail.todo.ref} actions`}
      />
      <span className="sr-only" role="status">{notice ?? ''}</span>
    </>
  );
}
