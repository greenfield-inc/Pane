import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Columns2, MoreHorizontal, PanelRight, Play, Square } from 'lucide-react';
import type { TodoAction, TodoAttachment, TodoDetail } from '../../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { normalizeKeyboardShortcutOverrides, resolveEffectiveChord } from '../../../../../shared/utils/keyboardBindings';
import { useTodoDetail, useTodosStore } from '../../../stores/todosStore';
import { countsAsWaiting, notifyItem, useNotifyStore } from '../../../stores/notifyStore';
import { todoApprovalSurface, useApprovalColumnStore } from '../../../stores/approvalColumnStore';
import { useOrchestrationSessionStore } from '../../../stores/orchestrationSessionStore';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../../../stores/configStore';
import { chordForEvent, rendererKeyPlatform } from '../../../stores/hotkeyStore';
import { useOuterPanelResize } from '../../../hooks/useOuterPanelResize';
import { OUTER_PANEL_CONFIGS } from '../../../utils/outerPanelSizing';
import { formatKeyDisplay } from '../../../utils/hotkeyUtils';
import { openOnMachine } from '../../../utils/machineRowActions';
import { cn } from '../../../utils/cn';
import { Dropdown, type DropdownItem } from '../../ui/Dropdown';
import { OuterResizeSeparator } from '../../ui/OuterResizeSeparator';
import { SkeletonSwap } from '../../ui/Skeleton';
import { TodoPageSkeleton } from '../TodoSkeletons';
import { isTypingTarget } from '../todosNavigation';
import { TodoCard, todoSubTodosAnchor } from './TodoCard';
import { TodoChatTimeline, TodoComposer } from './TodoChat';
import { TodoChips } from './TodoChips';
import { TodoDetailsSidebar, type TodoDetailsTab } from './TodoDetailsSidebar';
import { TodoSplit, splitTabLabel, useSplitOverviewSession, type TodoApprovalOpen } from './TodoSplit';
import { openTodoSession } from './todoNavigation';
import { initialSplit, splitAttachmentItems, startsHidden, todoSplitReducer, NARROW_TODO_AREA_PX, type TodoSplitItem } from './splitTabs';

/** The thread's narrowest usable width beside the split and the details (round 7 QA, R8). */
const THREAD_FLOOR_PX = 360;
/** The split's narrowest useful width. */
const SPLIT_FLOOR_PX = 240;
import { pruneSplitMemory, readSplitHidden, todoSplitKey, writeSplitHidden } from './todoSplitMemory';

export interface TodoPageProps {
  number: number;
  /** Back to the list (Esc, or the "To-dos" breadcrumb). */
  onBack: () => void;
  /** Open another to-do's page (a sub-to-do, or the parent from the breadcrumb). */
  onOpenTodo: (number: number) => void;
}

/**
 * One to-do's page (round 7, D-418 to D-420): the header with the split and details toggles, the
 * title and its chips, the card, the thread with its composer; the split with the plan and the
 * other attachments beside it; and the details sidebar on the right edge, closed until asked for.
 * Each to-do opens fresh: details closed, the split as remembered for that to-do.
 */
export function TodoPage(props: TodoPageProps) {
  return <TodoPageView key={props.number} {...props} />;
}

function TodoPageView({ number, onBack, onOpenTodo }: TodoPageProps) {
  const detail = useAnsweredNow(useTodoDetail(number));
  const ref = useRef<HTMLDivElement>(null);
  const [areaPx, setAreaPx] = useState<number | null>(null);
  // Measured before paint, so a narrow window's first frame already has the split hidden.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setAreaPx(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setAreaPx(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The approval column is this page's alone: leaving the page forgets it.
  useEffect(() => () => useApprovalColumnStore.getState().close(todoApprovalSurface(number)), [number]);
  return (
    <div ref={ref} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-primary" data-testid="todo-page" data-todo={number}>
      <SkeletonSwap loading={!detail || areaPx === null} skeleton={
        <>
          <PageHeader number={number} detail={null} onBack={onBack} onOpenTodo={onOpenTodo} onNotice={() => undefined} />
          <TodoPageSkeleton number={number} />
        </>
      }>
        {detail && areaPx !== null && <TodoPageLoaded detail={detail} areaPx={areaPx} onBack={onBack} onOpenTodo={onOpenTodo} />}
      </SkeletonSwap>
    </div>
  );
}

/** The split's hidden state for this visit: remembered per to-do, except in a narrow window. */
/**
 * Answering an approval reads Working at once (round 7, section 5): the host keeps an answer waiting through
 * its Undo hold, a few seconds, while Approvals here already shows it answered.
 */
function useAnsweredNow(detail: TodoDetail | null): TodoDetail | null {
  const waitingId = detail?.status.status === 'waiting' ? detail.status.waitingApprovalId : undefined;
  const answered = useNotifyStore((state) => {
    const item = waitingId ? notifyItem(state.snapshot, waitingId) : undefined;
    return item !== undefined && !countsAsWaiting(item);
  });
  return useMemo(() => (detail && answered ? { ...detail, status: { status: 'working', reason: '' } } : detail), [detail, answered]);
}

function useSplitMemory(detail: TodoDetail, areaPx: number) {
  const key = todoSplitKey(detail.machineId ?? LOCAL_MACHINE_ID, detail.todo.number);
  // A visit that opened under 1,000 px starts hidden, and showing the split lasts for that visit only.
  const [narrowVisit] = useState(() => areaPx < NARROW_TODO_AREA_PX);
  const [hiddenAtOpen] = useState(() => startsHidden(safeRead(key), areaPx));
  const remember = useCallback((hidden: boolean) => {
    if (narrowVisit) return;
    try {
      writeSplitHidden(window.localStorage, key, hidden);
    } catch {
      // Storage blocked: the split simply isn't remembered.
    }
  }, [key, narrowVisit]);
  // Closed to-dos on this machine leave the memory.
  const rows = useTodosStore((state) => state.snapshot?.rows);
  useEffect(() => {
    if (!rows) return;
    const open = new Set(rows.filter((row) => row.status.status !== 'done' && row.status.status !== 'dropped').map((row) => todoSplitKey(LOCAL_MACHINE_ID, row.todo.number)));
    try {
      pruneSplitMemory(window.localStorage, (stored) => !stored.startsWith(`${LOCAL_MACHINE_ID}:`) || open.has(stored));
    } catch {
      // Storage blocked: nothing to prune.
    }
  }, [rows]);
  return { hiddenAtOpen, remember };
}

function safeRead(key: string): boolean {
  try {
    return readSplitHidden(window.localStorage, key);
  } catch {
    return false;
  }
}

function TodoPageLoaded({ detail, areaPx, onBack, onOpenTodo }: { detail: TodoDetail; areaPx: number; onBack: () => void; onOpenTodo: (number: number) => void }) {
  const number = detail.todo.number;
  const { hiddenAtOpen, remember } = useSplitMemory(detail, areaPx);
  const overview = useSplitOverviewSession(detail);
  const [split, dispatch] = useReducer(todoSplitReducer, undefined, () => initialSplit(detail.attachments, hiddenAtOpen, overview));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<TodoDetailsTab>('details');
  const [approval, setApproval] = useState<TodoApprovalOpen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => { dispatch({ type: 'sync', groups: detail.attachments, overview }); }, [detail.attachments, overview]);
  // Focus starts on the title, so Tab walks the page from the top.
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, []);
  // The split's hidden state is remembered as it changes (never for the state it opened with).
  const rememberedHidden = useRef(split.hidden);
  useEffect(() => {
    if (rememberedHidden.current === split.hidden) return;
    rememberedHidden.current = split.hidden;
    remember(split.hidden);
  }, [split.hidden, remember]);

  const hasTabs = split.items.length > 0;
  const splitShown = (hasTabs && !split.hidden) || approval !== null;
  const toggleSplit = useCallback(() => dispatch({ type: 'toggle-hidden' }), []);
  const splitChord = useSplitShortcut(hasTabs, toggleSplit);

  const active = split.items[split.active];
  const activeLabel = active ? splitTabLabel(active, split.items) : null;
  const openApproval = useCallback((id: string) => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) returnFocus.current = document.activeElement;
    dispatch({ type: 'set-hidden', hidden: false });
    setApproval({ id, returnTab: activeLabel ?? detail.todo.ref });
  }, [activeLabel, detail.todo.ref]);
  const closeApproval = useCallback(() => {
    setApproval(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    // The control you came from may be gone (an answered card redraws): the title keeps focus on the page.
    requestAnimationFrame(() => (target?.isConnected ? target : titleRef.current)?.focus({ preventScroll: true }));
  }, []);
  const openItem = useCallback((item: TodoSplitItem) => {
    setApproval(null);
    dispatch({ type: 'open', item });
  }, []);
  const openAttachment = useCallback((attachment: TodoAttachment) => {
    const tab = split.items.find((item) => item.kind === 'attachment' && item.attachment.id === attachment.id);
    openItem(tab ?? { kind: 'attachment', attachment });
  }, [split.items, openItem]);
  const openAttachmentById = useCallback((attachmentId: number) => {
    const attachment = detail.attachments.flatMap((group) => group.attachments).find((candidate) => candidate.id === attachmentId);
    if (attachment) openAttachment(attachment);
  }, [detail.attachments, openAttachment]);
  const attached = useCallback((target: string) => dispatch({ type: 'reveal', target }), []);
  const openPr = useCallback(() => {
    const tab = split.items.find((item) => item.kind === 'attachment' && item.attachment.kind === 'pr');
    if (tab) openItem(tab);
    else if (detail.pr?.url) void window.electronAPI.openExternal(detail.pr.url);
  }, [split.items, openItem, detail.pr?.url]);
  const scrollToSubTodos = useCallback(() => {
    const section = document.getElementById(todoSubTodosAnchor(number));
    section?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    section?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [number]);

  const parentNumber = detail.todo.parentNumber;
  const back = useCallback(() => (parentNumber !== null ? onOpenTodo(parentNumber) : onBack()), [parentNumber, onOpenTodo, onBack]);
  useEscape(approval !== null, closeApproval, back);

  // Widths: the details sidebar out of the whole area; the split out of what is left.
  const details = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.todoDetails, containerPx: areaPx, enabled: detailsOpen });
  const splitContainer = Math.max(0, areaPx - (detailsOpen ? details.renderedPx : 0));
  const splitResize = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.todoSplit, containerPx: splitContainer, enabled: splitShown });
  // Too narrow for the split's floor beside the thread: it still shows, at most half of what is left.
  // The thread keeps THREAD_FLOOR_PX; with the details open and no room for both, the split steps aside for
  // this visit (its remembered state is untouched) and "Plan · N files" brings it back by closing the details.
  const room = splitContainer - THREAD_FLOOR_PX;
  const crowded = detailsOpen && room < SPLIT_FLOOR_PX && approval === null;
  const splitHere = splitShown && !crowded;
  const splitPx = Math.min(splitResize.bodyActive ? splitResize.renderedPx : Math.min(320, Math.floor(splitContainer / 2)), Math.max(SPLIT_FLOOR_PX, room));
  const showSplit = () => {
    dispatch({ type: 'set-hidden', hidden: false });
    if (crowded) setDetailsOpen(false);
  };
  // "Plan · 3 files" counts the files; the Session's Overview tab isn't one.
  const files = splitAttachmentItems(split.items);
  const lead = files[0] ? splitTabLabel(files[0], split.items) : null;

  return (
    <>
      <PageHeader
        number={number}
        detail={detail}
        onBack={onBack}
        onOpenTodo={onOpenTodo}
        onNotice={setNotice}
        split={{ shown: splitShown, enabled: hasTabs, chord: splitChord, onToggle: toggleSplit }}
        details={{ open: detailsOpen, onToggle: () => setDetailsOpen((open) => !open) }}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col" data-testid="todo-page-main">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-7 pb-3 pt-5" data-testid="todo-page-scroll">
            <div className="mx-auto max-w-[760px]">
              <h1 ref={titleRef} tabIndex={-1} className="mb-2 mt-1 text-[21px] font-semibold leading-[1.3] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-border-focus" data-testid="todo-page-title">{detail.todo.title}</h1>
              <TodoChips
                detail={detail}
                splitCount={files.length}
                splitLead={lead}
                splitHidden={!splitHere}
                onOpenApproval={openApproval}
                onOpenPr={openPr}
                onScrollToSubTodos={scrollToSubTodos}
                onOpenDetails={() => setDetailsOpen(true)}
                onShowSplit={showSplit}
                onAttached={attached}
              />
              {notice && <p className="mt-2 text-[12.5px] text-text-secondary" role="status" data-testid="todo-page-notice">{notice}</p>}
              <TodoCard detail={detail} onOpenTodo={onOpenTodo} onOpenImage={(src, label) => openItem({ kind: 'image', src, label })} />
              <TodoChatTimeline
                detail={detail}
                openApprovalId={approval?.id}
                onOpenApproval={openApproval}
                onOpenAttachment={openAttachmentById}
              />
            </div>
          </div>
          <TodoComposer key={detail.chatTarget.panelId ?? 'orchestrator'} detail={detail} />
        </div>
        {splitHere && (
          <div className="relative flex min-h-0 shrink-0 border-l border-border-primary bg-bg-primary" style={{ width: splitPx }} data-testid="todo-page-split">
            {splitResize.separatorVisible && (
              <OuterResizeSeparator label="Resize the split" orientation="vertical" value={splitResize.effectivePx}
                minimum={splitResize.floor} maximum={splitResize.cap} {...splitResize.separatorHandlers} />
            )}
            <TodoSplit
              detail={detail}
              split={split}
              dispatch={dispatch}
              approval={approval}
              onOpenApproval={openApproval}
              onCloseApproval={closeApproval}
              onAttached={attached}
            />
          </div>
        )}
        {detailsOpen && (
          <aside className="relative flex min-h-0 shrink-0 flex-col border-l border-border-primary bg-bg-secondary" style={{ width: details.renderedPx }} aria-label="To-do details" data-focus-region="right-panel" data-testid="todo-page-details">
            {details.separatorVisible && (
              <OuterResizeSeparator label="Resize to-do details" orientation="vertical" value={details.effectivePx}
                minimum={details.floor} maximum={details.cap} {...details.separatorHandlers} />
            )}
            <TodoDetailsSidebar
              detail={detail}
              tab={detailsTab}
              onTab={setDetailsTab}
              openAttachmentId={splitShown && active?.kind === 'attachment' ? active.attachment.id : undefined}
              onOpenAttachment={openAttachment}
              onOpenTodo={onOpenTodo}
              onAttached={attached}
              onClose={() => setDetailsOpen(false)}
            />
          </aside>
        )}
      </div>
    </>
  );
}

/**
 * ⌘\ (Ctrl+\ elsewhere) shows or hides the split. It is the Split Right entry's chord, read from
 * the catalog with the person's rebinding, so one binding serves both: a to-do page has nothing to
 * split, so here the chord is this page's. Caught before the global hotkeys so Split Right doesn't
 * also run on the Session underneath. Returns the chord's label for the button's tooltip.
 */
function useSplitShortcut(enabled: boolean, toggle: () => void): string | null {
  const config = useConfigStore((state) => state.config);
  const chord = resolveEffectiveChord('split-right', normalizeKeyboardShortcutOverrides(config?.keyboardShortcutOverrides).overrides, rendererKeyPlatform());
  const active = enabled && areKeyboardShortcutsEnabled(config) && chord !== null;
  useEffect(() => {
    if (!active || !chord) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || chordForEvent(event) !== chord) return;
      if (event.target instanceof HTMLElement && event.target.closest('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, chord, toggle]);
  return chord ? formatKeyDisplay(chord) : null;
}

/**
 * Esc closes the approval over the split first, then goes back. It leaves alone a key someone else
 * took (a menu, a dialog, a field's own Esc) and typing in a field.
 */
function useEscape(approvalOpen: boolean, closeApproval: () => void, back: () => void): void {
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
      if (approvalOpen) closeApproval();
      else back();
    };
    document.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [approvalOpen, closeApproval, back]);
}

const BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-2.5 text-[12.5px]';
const PLAIN_BUTTON = cn(BUTTON, 'border-border-primary bg-surface-primary text-text-primary hover:border-border-hover');
const PRIMARY_BUTTON = cn(BUTTON, 'border-transparent bg-interactive font-medium text-text-on-interactive hover:bg-interactive-hover');
/** The split and details toggles: drawn alike, in one fixed 32 px box each. */
const TOGGLE = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-hover disabled:opacity-40 disabled:hover:bg-transparent';

/** The page's one state action: Start anyway, Start, Resume or Stop; none once it is closed. */
export interface StateAction {
  label: string;
  action: TodoAction;
  primary: boolean;
}

export function stateAction(detail: TodoDetail): StateAction | null {
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

interface SplitToggle {
  shown: boolean;
  /** False while there is nothing to show. */
  enabled: boolean;
  chord: string | null;
  onToggle: () => void;
}

interface DetailsToggle {
  open: boolean;
  onToggle: () => void;
}

interface PageHeaderProps {
  number: number;
  detail: TodoDetail | null;
  onBack: () => void;
  onOpenTodo: (number: number) => void;
  onNotice: (line: string | null) => void;
  split?: SplitToggle;
  details?: DetailsToggle;
}

/**
 * "‹ To-dos   <Session> › T-12", or on a sub-to-do "‹ T-12   <Session> › T-12 › T-14"; then the
 * actions, and the split and details toggles at the right edge.
 */
function PageHeader({ number, detail, onBack, onOpenTodo, onNotice, split, details }: PageHeaderProps) {
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
  const splitWords = split?.shown ? 'Hide split' : 'Show split';
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border-primary pl-4 pr-3" data-testid="todo-page-header">
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
      {split && details && (
        <>
          <span className="mx-0.5 h-[18px] w-px shrink-0 bg-border-primary" aria-hidden="true" />
          <button type="button" className={cn(TOGGLE, split.shown && 'bg-surface-hover text-text-primary')} disabled={!split.enabled}
            aria-label={splitWords}
            title={split.chord ? `${splitWords} (${split.chord})` : splitWords}
            aria-pressed={split.shown}
            onClick={split.onToggle}
            data-testid="todo-split-toggle"><Columns2 className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className={cn(TOGGLE, details.open && 'bg-surface-hover text-text-primary')}
            aria-label={details.open ? 'Hide details' : 'Show details'}
            title={details.open ? 'Hide details' : 'Show details'}
            aria-expanded={details.open}
            onClick={details.onToggle}
            data-testid="todo-details-toggle"><PanelRight className="h-4 w-4" aria-hidden="true" /></button>
        </>
      )}
    </div>
  );
}
