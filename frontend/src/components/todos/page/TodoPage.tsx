import { useReadOnlyHost } from '../../../stores/readOnlyHostStore';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { ChevronLeft, ChevronRight, Columns2, MoreHorizontal, PanelRight, Play, Square } from 'lucide-react';
import { todoRef, type TodoAction, type TodoAttachment, type TodoDetail } from '../../../../../shared/types/todos';
import { LOCAL_MACHINE_ID } from '../../../../../shared/types/machineConnections';
import { normalizeKeyboardShortcutOverrides, resolveEffectiveChord } from '../../../../../shared/utils/keyboardBindings';
import { useTodoDetail, useTodosStore } from '../../../stores/todosStore';
import { todoKey, todoRefOn } from '../../../../../shared/todoKey';
import { countsAsWaiting, notifyItem, useNotifyStore } from '../../../stores/notifyStore';
import { todoApprovalSurface, useApprovalColumnStore } from '../../../stores/approvalColumnStore';
import { useOrchestrationSessionStore } from '../../../stores/orchestrationSessionStore';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../../../stores/configStore';
import { chordForEvent, rendererKeyPlatform } from '../../../stores/hotkeyStore';
import { useOuterPanelResize } from '../../../hooks/useOuterPanelResize';
import { canOpenSplit, useSplitArea } from '../../../utils/mainSplits';
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
import { TodoNarrowTabs, TodoSplit, splitTabLabel, todoTabIds, useSplitOverviewSession, type TodoApprovalOpen } from './TodoSplit';
import { openTodoSession } from './todoNavigation';
import {
  everyTabClosed, initialSplit, splitFileItems, splitHasTabs, splitItemKey, startsHidden, todoSplitReducer, NARROW_TODO_AREA_PX, type TodoSplitItem,
} from './splitTabs';

/** The thread's narrowest usable width beside the split and the details (round 7 QA, R8). */
const THREAD_FLOOR_PX = 360;
/** The split's narrowest useful width. */
const SPLIT_FLOOR_PX = 240;
import { pruneForPage, readClosedTabs, readSplitHidden, writeClosedTabs, writeSplitHidden } from './todoSplitMemory';
import { recallTodoView, rememberTodoView, restoreActiveTab } from './todoPageView';
import { SnoozeMenu } from '../SnoozeMenu';
import { SnoozeBanner, SnoozeHeaderButton, canSnoozeTodo, snoozeTarget, usePageSnooze } from './TodoSnoozed';

export interface TodoPageProps {
  number: number;
  /** Back to the list (Esc, or the "To-dos" breadcrumb). */
  onBack: () => void;
  /** Open another to-do's page (a sub-to-do, or the parent from the breadcrumb). */
  onOpenTodo: (number: number) => void;
  /** Shown inside a Session's To-dos tab (T-23) rather than on the To-dos screen. */
  embedded?: TodoPageEmbed;
  /**
   * The machine the to-do is on (T-51 F-4), by the window's id for it. The page reads it only while the window shows
   * that machine, so it never shows another machine's to-do with the same number. Absent: the computer shown.
   */
  machineId?: string;
}

/**
 * A to-do page inside a Session's To-dos tab: "‹ To-dos / T-14" (the Session is the one around it),
 * the tab's own controls at the header's end, and ⌘\ left to the Session's split.
 */
interface TodoPageEmbed {
  trailing: ReactNode;
}

/**
 * One to-do's page (round 7, D-418 to D-420): the header with the split and details toggles, the
 * title and its chips, the card, the thread with its composer; the split with the plan and the
 * other attachments beside it; and the details sidebar on the right edge, closed until asked for.
 * Each to-do opens fresh: details closed, the split as remembered for that to-do.
 */
export function TodoPage(props: TodoPageProps) {
  return <TodoPageView key={`${props.machineId ?? ''}:${props.number}`} {...props} />;
}

function TodoPageView({ number, onBack, onOpenTodo, embedded, machineId }: TodoPageProps) {
  const detail = useAnsweredNow(useTodoDetail(number, machineId));
  // The loaded page owns Esc (an approval first, a sub-to-do's parent, then back). Until it is on screen
  // (the skeleton holds a moment, even for a to-do already read, as when ↑ ↓ step), Esc still goes back.
  const [bodyShown, setBodyShown] = useState(false);
  useEscape(false, noop, onBack, !bodyShown);
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
          <PageHeader number={number} detail={null} onBack={onBack} onOpenTodo={onOpenTodo} onNotice={() => undefined} embedded={embedded} />
          <TodoPageSkeleton number={number} />
        </>
      }>
        {detail && areaPx !== null && <TodoPageLoaded detail={detail} areaPx={areaPx} rootRef={ref} onBack={onBack} onOpenTodo={onOpenTodo} embedded={embedded} onShown={setBodyShown} />}
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
  // Keyed by the machine the page was read from (T-51), so two machines' T-5 keep their own layouts.
  const key = todoKey(detail.machineId ?? LOCAL_MACHINE_ID, detail.todo.number);
  // A visit that opened under 1,000 px starts hidden, and showing the split lasts for that visit only.
  const [narrowVisit] = useState(() => areaPx < NARROW_TODO_AREA_PX);
  const [hiddenAtOpen] = useState(() => startsHidden(safeRead(key), areaPx));
  // Closed tabs are remembered whatever the width (T-25).
  const [closedAtOpen] = useState(() => safeReadClosed(key));
  const rememberClosed = useCallback((keys: readonly string[]) => {
    try {
      writeClosedTabs(window.localStorage, key, keys);
    } catch {
      // Storage blocked: closed tabs simply aren't remembered.
    }
  }, [key]);
  const remember = useCallback((hidden: boolean) => {
    if (narrowVisit) return;
    try {
      writeSplitHidden(window.localStorage, key, hidden);
    } catch {
      // Storage blocked: the split simply isn't remembered.
    }
  }, [key, narrowVisit]);
  // Closed to-dos of the page's machine leave the memory, read from a list that came from that machine (T-51 F-3);
  // other machines' stay.
  const rows = useTodosStore((state) => state.snapshot?.rows);
  const listMachine = useTodosStore((state) => state.snapshotMachine);
  const pageMachine = detail.machineId ?? LOCAL_MACHINE_ID;
  useEffect(() => {
    try {
      pruneForPage(window.localStorage, pageMachine, rows && listMachine ? { machineId: listMachine, rows } : null);
    } catch {
      // Storage blocked: nothing to prune.
    }
  }, [rows, listMachine, pageMachine]);
  return { hiddenAtOpen, remember, closedAtOpen, rememberClosed };
}

function safeRead(key: string): boolean {
  try {
    return readSplitHidden(window.localStorage, key);
  } catch {
    return false;
  }
}

function safeReadClosed(key: string): string[] {
  try {
    return readClosedTabs(window.localStorage, key);
  } catch {
    return [];
  }
}

/** The split's scrolled area (an Overview or a document), found when it exists. */
function splitScroller(): HTMLElement | null {
  const root = document.querySelector<HTMLElement>('[data-testid="todo-split"]');
  if (!root) return null;
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    const overflow = getComputedStyle(element).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && element.scrollHeight > element.clientHeight) return element;
  }
  return null;
}

/** Scrolls back once the content is tall enough (it may arrive a few frames late); stops after a second. */
function restoreScroll(find: () => HTMLElement | null, top: number): () => void {
  let frames = 0;
  let id = 0;
  const step = () => {
    const scroller = find();
    if (scroller && scroller.scrollHeight - scroller.clientHeight >= top) {
      scroller.scrollTop = top;
      return;
    }
    if (++frames < 60) id = requestAnimationFrame(step);
  };
  step();
  return () => cancelAnimationFrame(id);
}

function TodoPageLoaded({ detail, areaPx, rootRef, onBack, onOpenTodo, embedded, onShown }: { detail: TodoDetail; areaPx: number; rootRef: RefObject<HTMLElement | null>; onBack: () => void; onOpenTodo: (number: number) => void; embedded?: TodoPageEmbed; onShown: (shown: boolean) => void }) {
  useLayoutEffect(() => {
    onShown(true);
    return () => onShown(false);
  }, [onShown]);
  const number = detail.todo.number;
  const { hiddenAtOpen, remember, closedAtOpen, rememberClosed } = useSplitMemory(detail, areaPx);
  const overview = useSplitOverviewSession(detail);
  const viewKey = todoKey(detail.machineId ?? LOCAL_MACHINE_ID, number);
  const [leftAs] = useState(() => recallTodoView(viewKey));
  const [split, dispatch] = useReducer(todoSplitReducer, undefined, () => restoreActiveTab(initialSplit(detail.attachments, hiddenAtOpen, overview, closedAtOpen), leftAs?.tab ?? null, leftAs?.todoShown ?? true));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState<TodoDetailsTab>('details');
  const [approval, setApprovalOpen] = useState<TodoApprovalOpen | null>(null);
  // In one column, an approval stays open behind another tab you pick, until it is closed (T-38).
  const [approvalBehind, setApprovalBehind] = useState(false);
  const setApproval = useCallback((next: TodoApprovalOpen | null) => {
    setApprovalOpen(next);
    setApprovalBehind(false);
  }, []);
  const idBase = useId();
  const [notice, setNotice] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Round 9: the snooze menu, from Z, the header, the banner's Change or a reminder card.
  const snoozeAnchor = useRef<HTMLElement | null>(null);
  const anchorOf = useCallback(() => (snoozeAnchor.current ?? document.querySelector<HTMLElement>('[data-testid="todo-page-more"]'))?.getBoundingClientRect() ?? null, []);
  const snooze = usePageSnooze(detail, anchorOf);

  useEffect(() => { dispatch({ type: 'sync', groups: detail.attachments, overview }); }, [detail.attachments, overview]);
  // Back from the Session (or another to-do), the page is as you left it: its tab and both scrolls.
  const splitRef = useRef(split);
  splitRef.current = split;
  useLayoutEffect(() => {
    const page = scrollRef.current;
    const stopPage = leftAs && leftAs.pageScroll > 0 ? restoreScroll(() => page, leftAs.pageScroll) : null;
    const stopSplit = leftAs && leftAs.splitScroll > 0 ? restoreScroll(splitScroller, leftAs.splitScroll) : null;
    // Read as you scroll: by unmount the content may already be gone and the browser has clamped the scroll.
    const scrolled = { page: leftAs?.pageScroll ?? 0, split: leftAs?.splitScroll ?? 0 };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target === page) scrolled.page = target.scrollTop;
      else if (target.closest('[data-testid="todo-split"]')) scrolled.split = target.scrollTop;
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      stopPage?.();
      stopSplit?.();
      document.removeEventListener('scroll', onScroll, { capture: true });
      const shown = splitRef.current.items[splitRef.current.active];
      rememberTodoView(viewKey, { tab: shown ? splitItemKey(shown) : null, todoShown: splitRef.current.todoShown, pageScroll: scrolled.page, splitScroll: scrolled.split });
    };
  }, [viewKey, leftAs]);
  // Focus starts on the title, so Tab walks the page from the top.
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, []);
  // The split's hidden state is remembered as it changes (never for the state it opened with).
  const rememberedHidden = useRef(split.hidden);
  useEffect(() => {
    if (rememberedHidden.current === split.hidden) return;
    rememberedHidden.current = split.hidden;
    remember(split.hidden);
  }, [split.hidden, remember]);
  // So are its closed tabs (T-25).
  const rememberedClosed = useRef(split.closed);
  useEffect(() => {
    if (rememberedClosed.current === split.closed) return;
    rememberedClosed.current = split.closed;
    rememberClosed(split.closed);
  }, [split.closed, rememberClosed]);

  // The main area's split rule (D-448): the page is one split, and its files may be the second only
  // where the area has room for it. Otherwise they are tabs beside the page's own To-do tab, in one
  // column. Both layouts read the same tabs, so a change of area keeps them and the one shown.
  const area = useSplitArea();
  const tabs = !canOpenSplit(area, 1);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Details count in the same budget: a column of their own only where the page alone leaves room for
  // one, and then they take the split's place (page | details), as an approval takes theirs. Where no
  // split is available they lie over the one column instead.
  const detailsColumn = canOpenSplit(area, 1);
  const detailsFillBudget = detailsColumn && !canOpenSplit(area, 2);
  const detailsFillRef = useRef(detailsFillBudget);
  detailsFillRef.current = detailsFillBudget;
  // With every tab closed the split can still be shown: its default tab comes back (T-25).
  const hasTabs = splitHasTabs(split);
  // The approval drawn now: in one column it may be open behind another tab.
  const approvalShown = approval !== null && (!tabs || !approvalBehind);
  const splitShown = (split.items.length > 0 && !split.hidden) || approval !== null;
  // Under the tabs, a file's tab or an approval's takes the page's place.
  const tabShown = approvalShown || (!split.todoShown && split.items.length > 0);
  const toggleSplit = useCallback(() => dispatch({ type: 'toggle-hidden' }), []);
  // In a Session's To-dos tab, ⌘\ stays the Session's Split Right; under the tabs there is no split to toggle.
  const splitChord = useSplitShortcut(hasTabs && !embedded && !tabs, toggleSplit);

  const active = split.items[split.active];
  const activeLabel = active ? splitTabLabel(active, split.items) : null;
  const openApproval = useCallback((id: string) => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) returnFocus.current = document.activeElement;
    // Under the tabs the approval is a tab of its own, and closing it returns to the tab it covered.
    if (tabsRef.current) {
      setApproval({ id, returnTab: splitRef.current.todoShown ? 'To-do' : activeLabel ?? 'To-do' });
      return;
    }
    // With every tab closed the approval shows over an empty split, which hides again when it closes.
    if (splitRef.current.items.length > 0) dispatch({ type: 'set-hidden', hidden: false });
    // It takes the split's column, which the details would otherwise hold (two splits at most).
    if (detailsFillRef.current) setDetailsOpen(false);
    setApproval({ id, returnTab: activeLabel ?? detail.todo.ref });
  }, [activeLabel, detail.todo.ref, setApproval]);
  const closeApproval = useCallback(() => {
    setApproval(null);
    const target = returnFocus.current;
    returnFocus.current = null;
    // The control you came from may be gone (an answered card redraws): the title keeps focus on the page.
    requestAnimationFrame(() => (target?.isConnected ? target : titleRef.current)?.focus({ preventScroll: true }));
  }, [setApproval]);
  // Opening a file shows the split; where it was crowded out by the details, the details close (as "Plan · N files" does).
  const crowdedRef = useRef(false);
  const openItem = useCallback((item: TodoSplitItem) => {
    setApproval(null);
    dispatch({ type: 'open', item });
    if (crowdedRef.current) setDetailsOpen(false);
  }, [setApproval]);
  // A tab's own item (closed or not) when it has one; otherwise a sub-to-do's file, marked with where it is from.
  const openAttachment = useCallback((attachment: TodoAttachment) => {
    const tab = [...split.items, ...split.all].find((item) => item.kind === 'attachment' && item.attachment.id === attachment.id);
    const from = detail.attachments.find((group) => group.attachments.some((candidate) => candidate.id === attachment.id))?.from;
    openItem(tab ?? (from ? { kind: 'attachment', attachment, from: from.number } : { kind: 'attachment', attachment }));
  }, [split.items, split.all, detail.attachments, openItem]);
  const openAttachmentById = useCallback((attachmentId: number) => {
    const attachment = detail.attachments.flatMap((group) => group.attachments).find((candidate) => candidate.id === attachmentId);
    if (attachment) openAttachment(attachment);
  }, [detail.attachments, openAttachment]);
  const attached = useCallback((target: string) => dispatch({ type: 'reveal', target }), []);
  const openPr = useCallback(() => {
    const tab = split.all.find((item) => item.kind === 'attachment' && item.attachment.kind === 'pr');
    if (tab) openItem(tab);
    else if (detail.pr?.url) void window.electronAPI.openExternal(detail.pr.url);
  }, [split.all, openItem, detail.pr?.url]);
  const scrollToSubTodos = useCallback(() => {
    const section = document.getElementById(todoSubTodosAnchor(number));
    section?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    section?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [number]);

  const parentNumber = detail.todo.parentNumber;
  const back = useCallback(() => (parentNumber !== null ? onOpenTodo(parentNumber) : onBack()), [parentNumber, onOpenTodo, onBack]);
  useEscape(approvalShown, closeApproval, back);

  // Widths: the details sidebar out of the whole area; the split out of what is left.
  const details = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.todoDetails, containerPx: areaPx, enabled: detailsOpen });
  const splitContainer = Math.max(0, areaPx - (detailsOpen && detailsColumn ? details.renderedPx : 0));
  const splitResize = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.todoSplit, containerPx: splitContainer, enabled: splitShown });
  // Too narrow for the split's floor beside the thread: it still shows, at most half of what is left.
  const room = splitContainer - THREAD_FLOOR_PX;
  // The details and the split never show at once where they would make a third column (D-448), nor
  // where the split would be too narrow beside the thread: the split steps aside for this visit (its
  // remembered state is untouched) and "Plan · N files" brings it back by closing the details.
  const crowded = !tabs && detailsOpen && approval === null && (detailsFillBudget || room < SPLIT_FLOOR_PX);
  // Details over the one column hide what a file would open under them.
  crowdedRef.current = crowded || (detailsOpen && !detailsColumn);
  const splitHere = !tabs && splitShown && !crowded;
  // Where the split's content is on screen: beside the page, or in the page's place under the tabs.
  const splitOnScreen = tabs ? tabShown : splitHere;
  const splitPx = Math.min(splitResize.bodyActive ? splitResize.renderedPx : Math.min(320, Math.floor(splitContainer / 2)), Math.max(SPLIT_FLOOR_PX, room));
  // "Plan · 3 files" shows the split; with every tab closed it opens the details' Files instead (T-25).
  const showSplit = () => {
    if (everyTabClosed(split)) {
      setDetailsTab('files');
      setDetailsOpen(true);
      return;
    }
    dispatch({ type: 'set-hidden', hidden: false });
    if (crowdedRef.current) setDetailsOpen(false);
  };
  // The details button, which takes the approval's column where they can't both show.
  const toggleDetails = () => {
    if (!detailsOpen && detailsFillBudget && approval !== null) closeApproval();
    setDetailsOpen((open) => !open);
  };
  // "Plan · 3 files" counts the files, closed or not; the Session's Overview tab isn't one.
  const files = splitFileItems(split);
  const lead = files[0] ? splitTabLabel(files[0], split.all) : null;
  // The close-tab key (⌘W) closes the selected tab that closes: the split's shown tab, or the approval
  // (T-25). In a Session's To-dos tab it does so only while focus is in this to-do; elsewhere, and on
  // the To-do tab, which never closes, the key stays the Session's.
  const closeShown = useCallback(() => {
    if (approvalShown) closeApproval();
    else dispatch({ type: 'close', index: splitRef.current.active });
  }, [approvalShown, closeApproval]);
  const closable = tabs ? tabShown : splitOnScreen && (split.items.length > 0 || approval !== null);
  useChordShortcut('close-active-tab', closable, closeShown, embedded ? rootRef : undefined);

  return (
    <>
      <PageHeader
        number={number}
        detail={detail}
        onBack={onBack}
        onOpenTodo={onOpenTodo}
        onNotice={setNotice}
        snooze={{ anchorRef: snoozeAnchor, onOpen: snooze.open }}
        split={tabs ? undefined : { shown: splitShown, enabled: hasTabs, chord: splitChord, onToggle: toggleSplit }}
        details={{ open: detailsOpen, onToggle: toggleDetails }}
        embedded={embedded}
      />
      {tabs && (
        <TodoNarrowTabs detail={detail} split={split} dispatch={dispatch} approval={approval} approvalShown={approvalShown}
          onShowApproval={() => setApprovalBehind(false)} onLeaveApproval={() => setApprovalBehind(true)} onCloseApproval={closeApproval}
          onAttached={attached} idBase={idBase} />
      )}
      <div className="relative flex min-h-0 flex-1" data-layout={tabs ? 'tabs' : 'split'} data-testid="todo-page-body">
        {/* Kept mounted under another tab, so its scroll and the composer's draft stay. */}
        <div className={cn('min-w-0 flex-1 flex-col', tabs && tabShown ? 'hidden' : 'flex')} data-testid="todo-page-main"
          {...(tabs ? { role: 'tabpanel', id: todoTabIds(idBase).page, 'aria-labelledby': todoTabIds(idBase).todoTab } : {})}>
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
              <SnoozeBanner detail={detail} onChange={snooze.open} onWake={snooze.wake} />
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
        {snooze.anchor && (
          <SnoozeMenu target={snoozeTarget(detail)} anchor={snooze.anchor} onSubmit={snooze.submit} onWake={detail.todo.snooze ? snooze.wake : undefined} onClose={snooze.close} />
        )}
        {splitOnScreen && (
          <div className={cn('relative flex min-h-0 bg-bg-primary', tabs ? 'min-w-0 flex-1' : 'shrink-0 border-l border-border-primary')} style={tabs ? undefined : { width: splitPx }} data-testid="todo-page-split">
            {!tabs && splitResize.separatorVisible && (
              <OuterResizeSeparator label="Resize the split" orientation="vertical" value={splitResize.effectivePx}
                minimum={splitResize.floor} maximum={splitResize.cap} {...splitResize.separatorHandlers} />
            )}
            <TodoSplit
              detail={detail}
              split={split}
              dispatch={dispatch}
              approval={approvalShown ? approval : null}
              onOpenApproval={openApproval}
              onCloseApproval={closeApproval}
              onAttached={attached}
              showStrip={!tabs}
              idBase={idBase}
            />
          </div>
        )}
        {detailsOpen && (
          <aside
            className={cn('flex min-h-0 shrink-0 flex-col border-l border-border-primary bg-bg-secondary', detailsColumn ? 'relative' : 'absolute inset-y-0 right-0 z-20 max-w-full')}
            style={{ width: details.renderedPx }} aria-label="To-do details" data-focus-region="right-panel" data-testid="todo-page-details" data-overlay={detailsColumn ? undefined : true}>
            {details.separatorVisible && (
              <OuterResizeSeparator label="Resize to-do details" orientation="vertical" value={details.effectivePx}
                minimum={details.floor} maximum={details.cap} {...details.separatorHandlers} />
            )}
            <TodoDetailsSidebar
              detail={detail}
              tab={detailsTab}
              onTab={setDetailsTab}
              openAttachmentId={(tabs ? tabShown && !approvalShown : splitShown) && active?.kind === 'attachment' ? active.attachment.id : undefined}
              closedTabs={split.closed}
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
 * split, so here the chord is this page's. Returns the chord's label for the button's tooltip.
 */
function useSplitShortcut(enabled: boolean, toggle: () => void): string | null {
  return useChordShortcut('split-right', enabled, toggle);
}

/**
 * A Session's shortcut, by its catalog id and with the person's rebinding, run by this page while
 * `enabled`. Caught before the global hotkeys so the Session's own command doesn't also run
 * underneath. Returns the chord's label.
 */
function useChordShortcut(command: 'split-right' | 'close-active-tab', enabled: boolean, run: () => void, within?: RefObject<HTMLElement | null>): string | null {
  const config = useConfigStore((state) => state.config);
  const chord = resolveEffectiveChord(command, normalizeKeyboardShortcutOverrides(config?.keyboardShortcutOverrides).overrides, rendererKeyPlatform());
  const active = enabled && areKeyboardShortcutsEnabled(config) && chord !== null;
  useEffect(() => {
    if (!active || !chord) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || chordForEvent(event) !== chord) return;
      if (event.target instanceof HTMLElement && event.target.closest('[aria-modal="true"]')) return;
      // Scoped: the key is ours only while focus is in that element; otherwise it goes on to its owner.
      if (within && !(within.current && document.activeElement && within.current.contains(document.activeElement))) return;
      event.preventDefault();
      event.stopPropagation();
      run();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, chord, run, within]);
  return chord ? formatKeyDisplay(chord) : null;
}

/**
 * Esc closes the approval over the split first, then goes back. It leaves alone a key someone else
 * took (a menu, a dialog, a field's own Esc) and typing in a field.
 */
function noop(): void {
  // Nothing to close: no approval shows before the page has loaded.
}

function useEscape(approvalOpen: boolean, closeApproval: () => void, back: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
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
  }, [approvalOpen, closeApproval, back, enabled]);
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

/**
 * ⋯: Snooze… (round 9) and Drop while open; Archive (with its result line) and Reopen once closed; and its Session.
 * `withDone`: Mark done too, where the header has no room for its button (a Session's To-dos tab, T-23).
 */
function moreMenu(detail: TodoDetail, run: (action: TodoAction) => Promise<void>, onSnooze?: () => void, withDone = false, readOnly = false): DropdownItem[] {
  const number = detail.todo.number;
  const closed = detail.status.status === 'done' || detail.status.status === 'dropped';
  const hasSession = Boolean(detail.todo.sessionId ?? detail.parent?.todo.sessionId);
  const session: DropdownItem = { id: 'session', label: 'Session · Open', description: 'Its own Session, hidden from the sidebar', separatorBefore: !readOnly, disabled: !hasSession, onClick: () => openTodoSession(detail) };
  // A to-do on a computer you only watch offers nothing that changes it.
  if (readOnly) return [session];
  const items: DropdownItem[] = [];
  if (onSnooze && canSnoozeTodo(detail.todo)) {
    items.push({ id: 'snooze', label: detail.todo.snooze ? 'Change snooze…' : 'Snooze…', description: 'Z · until a time, with a wake-up note', onClick: onSnooze });
  }
  // While snoozed the header's button stands in for the state action and Mark done.
  if (detail.todo.snooze || (withDone && !closed)) items.push({ id: 'done', label: 'Mark done', onClick: () => void run({ kind: 'done', number }) });
  if (closed) {
    items.push({ id: 'archive', label: 'Archive', description: 'Archives its Session’s Panes that are safe to archive', onClick: () => void run({ kind: 'archive', number }) });
    items.push({ id: 'reopen', label: 'Reopen', onClick: () => void run({ kind: 'reopen', number }) });
  } else {
    items.push({ id: 'drop', label: 'Drop', variant: 'danger', onClick: () => void run({ kind: 'drop', number }) });
  }
  items.push(session);
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

interface SnoozeControl {
  /** The header's snooze button, which the menu opens under. */
  anchorRef: MutableRefObject<HTMLElement | null>;
  onOpen: () => void;
}

interface PageHeaderProps {
  number: number;
  detail: TodoDetail | null;
  onBack: () => void;
  onOpenTodo: (number: number) => void;
  onNotice: (line: string | null) => void;
  snooze?: SnoozeControl;
  split?: SplitToggle;
  details?: DetailsToggle;
  embedded?: TodoPageEmbed;
}

/**
 * "‹ To-dos   <Session> › T-12", or on a sub-to-do "‹ T-12   <Session> › T-12 › T-14"; then the
 * actions, and the split and details toggles at the right edge.
 */
function PageHeader({ number, detail, onBack, onOpenTodo, onNotice, snooze, split, details, embedded }: PageHeaderProps) {
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
  const readOnly = useReadOnlyHost();
  const primary = detail && !readOnly ? stateAction(detail) : null;
  const menu = detail ? moreMenu(detail, run, snooze?.onOpen, embedded !== undefined, readOnly) : [];
  const snoozed = detail?.todo.snooze;
  const splitWords = split?.shown ? 'Hide split' : 'Show split';
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border-primary pl-4 pr-3" data-testid="todo-page-header">
      <button type="button" onClick={parent ? () => onOpenTodo(parent.todo.number) : onBack} title="Back (Esc)" className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-[7px] px-1.5 text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text-primary" data-testid="todo-page-back">
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {parent ? parent.todo.ref : 'To-dos'}
      </button>
      <nav aria-label="Breadcrumb" className={cn('flex items-center gap-1.5 text-[12.5px] text-text-tertiary', embedded ? 'shrink-0' : 'min-w-0')} data-testid="todo-breadcrumb">
        {embedded && !parent && <span aria-hidden="true">/</span>}
        {crumb && !embedded && (
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
        {/* Another computer's to-do names it, as the To-dos list does: "T-5 · qa-mini" (T-51 F-2). */}
        <b className="shrink-0 font-semibold text-text-primary" aria-current="page" data-testid="todo-page-ref">{detail?.machineId && detail.machineId !== LOCAL_MACHINE_ID ? todoRefOn(number, detail.machine) : todoRef(number)}</b>
      </nav>
      <span className="flex-1" />
      {snoozed && snooze && <SnoozeHeaderButton ref={(element) => { snooze.anchorRef.current = element; }} snooze={snoozed} onOpen={snooze.onOpen} />}
      {primary && !snoozed && (
        <button type="button" onClick={() => void run(primary.action)} className={primary.primary ? PRIMARY_BUTTON : PLAIN_BUTTON} data-testid="todo-page-state-action">
          {primary.primary ? <Play className="h-3 w-3 fill-current" aria-hidden="true" /> : <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />}
          {primary.label}
        </button>
      )}
      {detail && !closed && !snoozed && !embedded && !readOnly && <button type="button" onClick={() => void run({ kind: 'done', number })} className={PLAIN_BUTTON} data-testid="todo-page-done">Mark done</button>}
      {detail && (
        <Dropdown
          trigger={<button type="button" aria-label="More" className="inline-flex h-7 w-8 items-center justify-center rounded-[7px] text-text-secondary hover:bg-surface-hover" data-testid="todo-page-more"><MoreHorizontal className="h-4 w-4" aria-hidden="true" /></button>}
          items={menu}
          position="bottom-right"
          width="lg"
          menuLabel={`${detail.todo.ref} actions`}
        />
      )}
      {/* In a Session's To-dos tab the chips show the split and the details; the bar keeps the tab's own controls. */}
      {/* With no split available there is no split to toggle: the files are tabs (T-38). */}
      {details && !embedded && (
        <>
          <span className="mx-0.5 h-[18px] w-px shrink-0 bg-border-primary" aria-hidden="true" />
          {split && (
            <button type="button" className={cn(TOGGLE, split.shown && 'bg-surface-hover text-text-primary')} disabled={!split.enabled}
              aria-label={splitWords}
              title={split.chord ? `${splitWords} (${split.chord})` : splitWords}
              aria-pressed={split.shown}
              onClick={split.onToggle}
              data-testid="todo-split-toggle"><Columns2 className="h-4 w-4" aria-hidden="true" /></button>
          )}
          <button type="button" className={cn(TOGGLE, details.open && 'bg-surface-hover text-text-primary')}
            aria-label={details.open ? 'Hide details' : 'Show details'}
            title={details.open ? 'Hide details' : 'Show details'}
            aria-expanded={details.open}
            onClick={details.onToggle}
            data-testid="todo-details-toggle"><PanelRight className="h-4 w-4" aria-hidden="true" /></button>
        </>
      )}
      {embedded && (
        <>
          <span className="mx-0.5 h-[18px] w-px shrink-0 bg-border-primary" aria-hidden="true" />
          {embedded.trailing}
        </>
      )}
    </div>
  );
}
