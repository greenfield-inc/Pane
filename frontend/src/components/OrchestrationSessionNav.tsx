import { CreateOrchestrationSessionDialog, type SessionCreateRequest } from './CreateOrchestrationSessionDialog';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { create as createStore } from 'zustand';
import { Archive, ArrowRightLeft, ChevronDown, ChevronRight, MoreHorizontal, Pin, PinOff, Plus, Pencil, RefreshCw, Terminal } from 'lucide-react';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import {
  isArchivedOrchestrationSession,
  useOrchestrationSessionStore,
  type OrchestrationSessionAvailability,
} from '../stores/orchestrationSessionStore';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { OrchestrationSessionUpdateInput } from '../../../shared/types/orchestrationSession';
import { LEGACY_ORCHESTRATION_SESSION_ID, nextOrchestrationSessionName } from '../../../shared/types/orchestrationSession';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Tooltip } from './ui/Tooltip';
import { UndoToast } from './ui/UndoToast';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';
import { cn } from '../utils/cn';
import { SessionActivityDot, SessionActivitySummary } from './SessionActivity';
import { readDraggedSessionId, startSessionDrag, useDraggedSessionId } from '../utils/sessionDrag';
import { dropOrder, stepOrder, type SessionDropTarget } from '../utils/sessionReorder';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { MoveSessionToHostDialog } from './MoveSessionToHostDialog';
import { useMoveToHostBlockedReason } from '../hooks/useMoveToHostBlockedReason';

interface OrchestrationSessionNavProps {
  compact?: boolean;
  /** Pane IDs that are still present in the normal Pane list. */
  availablePaneIds?: ReadonlySet<string>;
  /** Renders an associated Pane with the existing Pane row experience. */
  renderPane?: (paneId: string, parentSessionId: string, index: number) => ReactNode | null;
  /** Existing pinned Pane rows, rendered alongside pinned orchestration Sessions. */
  pinnedPaneRows?: ReactNode;
  pinnedSectionExpanded?: boolean;
  onPinnedSectionExpandedChange?: (expanded: boolean) => void;
  sessionsSectionExpanded?: boolean;
  onSessionsSectionExpandedChange?: (expanded: boolean) => void;
}

interface SessionContextMenuState {
  sessionId: string;
  sessionName: string;
  isPinned: boolean;
  x: number;
  y: number;
  /** The ⋯ button that opened the menu; focus moves into the menu and returns here on Escape. */
  trigger?: HTMLElement;
  /** Where a dialog opened from the menu returns focus: the trigger, or the row right-clicked. */
  returnFocusTo?: HTMLElement;
}

type SessionRowPlacement = 'pinned' | 'sessions';
/** The lists a Session can be reordered in. A drag reorders only the list it started in. */
type SessionOrderList = SessionRowPlacement | 'rail';

interface SessionListDrop extends SessionDropTarget {
  list: SessionOrderList;
}

/** What a failed reorder tells the person: what happened, what changed, why, and the next step. */
function sessionOrderError(cause: unknown): string {
  const reason = ipcErrorMessage(cause, 'The host did not answer.').trim();
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  const next = /\bNext:/.test(reason) ? '' : ' Try the move again.';
  return `The Session order was not saved, so the list is back in its previous order. ${sentence}${next}`;
}

function sessionTestId(session: OrchestrationSessionRecord, list: SessionOrderList): string {
  const isLegacy = session.id === LEGACY_ORCHESTRATION_SESSION_ID;
  if (list === 'rail') return isLegacy ? 'compact-pane-chat' : `compact-orchestration-session-${session.id}`;
  if (isLegacy) return list === 'pinned' ? 'orchestration-pinned-pane-chat' : 'orchestration-pane-chat';
  return `${list === 'pinned' ? 'orchestration-pinned-session' : 'orchestration-session'}-${session.id}`;
}

/** A drop in the top half of a Session (its row and Panes together) lands before it, else after. */
function dropEdge(event: { clientY: number; currentTarget: Element }): SessionDropTarget['edge'] {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

interface ArchivedSessionToast {
  sessionId: string;
  sessionName: string;
  wasOpen: boolean;
  /** The host that archived the Session; Undo is offered only while that host is current. */
  hostRevision: number;
}

/** The pending archive Undo, shared so the toast survives a switch between the rail and the tree. */
const useArchivedSessionToastStore = createStore<{ toast: ArchivedSessionToast | null }>(() => ({ toast: null }));
const setArchivedToast = (toast: ArchivedSessionToast | null) => useArchivedSessionToastStore.setState({ toast });
const clearArchivedToast = () => setArchivedToast(null);

function statusLabel(session: OrchestrationSessionRecord): string {
  if (session.blockers.length > 0) return 'Blocked';
  if (session.report) return 'Report available';
  return 'No report yet';
}

function availabilityIsVisible(availability: OrchestrationSessionAvailability): boolean {
  return availability === 'ready' || availability === 'loading' || availability === 'error';
}

export function OrchestrationSessionNav({
  compact = false,
  availablePaneIds,
  renderPane,
  pinnedPaneRows = null,
  pinnedSectionExpanded,
  onPinnedSectionExpandedChange,
  sessionsSectionExpanded,
  onSessionsSectionExpandedChange,
}: OrchestrationSessionNavProps) {
  const sessions = useOrchestrationSessionStore(state => state.sessions);
  const activeSessions = useMemo(
    () => sessions.filter(session => !isArchivedOrchestrationSession(session)),
    [sessions],
  );
  const pinnedSessions = useMemo(
    () => activeSessions.filter(session => session.isPinned === true),
    [activeSessions],
  );
  const selectedSessionId = useOrchestrationSessionStore(state => state.selectedSessionId);
  const availability = useOrchestrationSessionStore(state => state.availability);
  const error = useOrchestrationSessionStore(state => state.error);
  const selectionError = useOrchestrationSessionStore(state => state.selectionError);
  const sessionError = selectionError ?? error;
  const load = useOrchestrationSessionStore(state => state.load);
  const refresh = useOrchestrationSessionStore(state => state.refresh);
  const select = useOrchestrationSessionStore(state => state.select);
  const create = useOrchestrationSessionStore(state => state.create);
  const update = useOrchestrationSessionStore(state => state.update);
  const reorder = useOrchestrationSessionStore(state => state.reorder);
  const navigateToPaneChat = useNavigationStore(state => state.navigateToPaneChat);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const activeView = useNavigationStore(state => state.activeView);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const [showCreate, setShowCreate] = useState(false);
  const expandedSessions = useNavigationStore(state => state.expandedSessions);
  const toggleStoredSessionExpanded = useNavigationStore(state => state.toggleSessionExpanded);
  const [localSectionExpanded, setLocalSectionExpanded] = useState(true);
  const [localPinnedSectionExpanded, setLocalPinnedSectionExpanded] = useState(true);
  const [sessionMenu, setSessionMenu] = useState<SessionContextMenuState | null>(null);
  const [movingSessionId, setMovingSessionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const draggedSessionId = useDraggedSessionId();
  // The list a Session drag started in; the drag reorders only that list. A ref, not state:
  // the window's drop listener ends the in-flight drag (and re-renders) before the row's own
  // drop handler runs, so only the drag's own drop or dragend may clear it.
  const dragOrigin = useRef<{ sessionId: string; list: SessionOrderList } | null>(null);
  const [drop, setDrop] = useState<SessionListDrop | null>(null);
  const [orderAnnouncement, setOrderAnnouncement] = useState('');
  // The row Alt+Up/Down moved, refocused after the list renders in its new order.
  const focusAfterMove = useRef<string | null>(null);
  const hostRevision = useOrchestrationSessionStore(state => state.hostRevision);
  const pendingToast = useArchivedSessionToastStore(state => state.toast);
  const archivedToast = pendingToast?.hostRevision === hostRevision ? pendingToast : null;
  const compactError = actionError ?? sessionError;
  const isPinnedSectionExpanded = pinnedSectionExpanded ?? localPinnedSectionExpanded;
  const setPinnedSectionExpanded = onPinnedSectionExpandedChange ?? setLocalPinnedSectionExpanded;
  const sectionExpanded = sessionsSectionExpanded ?? localSectionExpanded;
  const setSectionExpanded = onSessionsSectionExpandedChange ?? setLocalSectionExpanded;

  const createSession = useCallback(async ({ name: requestedName, ...input }: SessionCreateRequest) => {
    await load();
    const name = requestedName || nextOrchestrationSessionName(useOrchestrationSessionStore.getState().sessions);
    await create({ ...input, name, nameFromFirstMessage: !requestedName });
    setShowCreate(false);
    setActiveSession(null);
    navigateToPaneChat();
  }, [create, load, navigateToPaneChat, setActiveSession]);

  useEffect(() => {
    void load();
  }, [load]);

  // The command palette's New Session. Sidebar mounts exactly one nav (rail or tree), so one dialog opens.
  useEffect(() => {
    const openCreate = () => setShowCreate(true);
    window.addEventListener('open-create-orchestration-session', openCreate);
    return () => window.removeEventListener('open-create-orchestration-session', openCreate);
  }, []);

  useEffect(() => {
    const handleSessionsChanged = (event: Event) => {
      // SAFETY: Pane's orchestration event contract supplies this detail shape.
      const detail = event instanceof CustomEvent
        ? event.detail as { kind?: string; selectionChanged?: boolean }
        : undefined;
      // Another client's selection never moves this desktop. Only a resync
      // adopts one, and only when this desktop has none of its own for the host.
      // Reconnection snapshots can still contain the selection preceding a failed
      // click; a new host clears selectionError during invalidation.
      const retainFailedIntent = useOrchestrationSessionStore.getState().selectionError !== null;
      const adoptServerSelection = !retainFailedIntent && detail?.kind === 'runtime-resync';
      void refresh({ adoptServerSelection });
    };
    window.addEventListener('orchestration-sessions-changed', handleSessionsChanged);
    return () => window.removeEventListener('orchestration-sessions-changed', handleSessionsChanged);
  }, [refresh]);

  const openSession = useCallback(async (sessionId: string) => {
    // Navigation belongs to the click, never to the order of remote replies.
    void setActiveSession(null);
    navigateToPaneChat();
    try {
      await select({ sessionId });
    } catch {
      // The store owns selection errors, including retries from the content view.
      // Keeping a second local copy would leave the sidebar error after recovery.
    }
  }, [navigateToPaneChat, select, setActiveSession]);

  const toggleSessionExpanded = useCallback((sessionId: string) => {
    const expandedSessionIds = toggleStoredSessionExpanded(sessionId);
    void window.electronAPI.uiState.saveExpandedSessions(expandedSessionIds).catch(error => {
      console.error('Failed to save opened Sessions:', error);
    });
  }, [toggleStoredSessionExpanded]);

  const openSessionMenu = useCallback((
    session: OrchestrationSessionRecord,
    x: number,
    y: number,
    trigger?: HTMLElement,
    returnFocusTo = trigger,
  ) => {
    setSessionMenu({
      sessionId: session.id,
      sessionName: session.name || 'Pane Chat',
      isPinned: session.isPinned === true,
      x,
      y,
      trigger,
      returnFocusTo,
    });
  }, []);

  const handleSessionContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>, session: OrchestrationSessionRecord) => {
    event.preventDefault();
    event.stopPropagation();
    // Not a trigger: a right-click leaves focus where it was, but a dialog closes back to this row.
    openSessionMenu(session, event.clientX, event.clientY, undefined, event.currentTarget);
  }, [openSessionMenu]);

  const listSessions = useCallback((list: SessionOrderList) => (
    list === 'pinned' ? pinnedSessions : activeSessions
  ), [activeSessions, pinnedSessions]);

  const moveSession = useCallback(async (session: OrchestrationSessionRecord, order: string[]) => {
    setActionError(null);
    setOrderAnnouncement(`Moved ${session.name || 'Pane Chat'} to position ${order.indexOf(session.id) + 1} of ${order.length}`);
    try {
      await reorder(order);
    } catch (cause) {
      setOrderAnnouncement('');
      setActionError(sessionOrderError(cause));
      void refresh();
    }
  }, [refresh, reorder]);

  const handleSessionKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>, session: OrchestrationSessionRecord, list: SessionOrderList) => {
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const order = stepOrder(listSessions(list).map(item => item.id), session.id, event.key === 'ArrowUp' ? -1 : 1);
      if (!order) return;
      focusAfterMove.current = sessionTestId(session, list);
      void moveSession(session, order);
      return;
    }
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    // The row is the trigger: focus moves into the menu for arrow keys and returns here on Escape.
    openSessionMenu(session, bounds.left, bounds.bottom, event.currentTarget);
  }, [listSessions, moveSession, openSessionMenu]);

  // Moving a row in the DOM can drop its focus; put it back on the row that moved.
  useEffect(() => {
    const testId = focusAfterMove.current;
    if (!testId) return;
    focusAfterMove.current = null;
    const row = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (row && document.activeElement !== row) row.focus();
  }, [sessions]);

  // A drag that ends anywhere, dropped or cancelled, takes its drop line with it.
  useEffect(() => {
    if (draggedSessionId === null) setDrop(null);
  }, [draggedSessionId]);

  /** Drag handlers for one Session in one list: the row starts the drag, the whole Session takes drops. */
  const sessionDragProps = (session: OrchestrationSessionRecord, list: SessionOrderList) => {
    // Only a drag that started in this list, over a Session other than the dragged one.
    const fromThisList = () => {
      const origin = dragOrigin.current;
      return origin !== null && origin.list === list && origin.sessionId !== session.id ? origin : null;
    };
    return {
      source: {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>) => {
          startSessionDrag(event.dataTransfer, session.id);
          dragOrigin.current = { sessionId: session.id, list };
        },
        onDragEnd: () => {
          dragOrigin.current = null;
          setDrop(null);
        },
      },
      target: {
        onDragOver: (event: DragEvent<HTMLElement>) => {
          if (!fromThisList()) {
            if (drop?.list === list) setDrop(null);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const edge = dropEdge(event);
          if (drop?.list !== list || drop.targetId !== session.id || drop.edge !== edge) setDrop({ list, targetId: session.id, edge });
        },
        onDragLeave: (event: DragEvent<HTMLElement>) => {
          const into = event.relatedTarget;
          if (into instanceof Node && event.currentTarget.contains(into)) return;
          if (drop?.list === list && drop.targetId === session.id) setDrop(null);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          const origin = fromThisList();
          if (!origin) return;
          event.preventDefault();
          const movedId = readDraggedSessionId(event.dataTransfer) ?? origin.sessionId;
          const moved = listSessions(list).find(item => item.id === movedId);
          const order = moved && dropOrder(listSessions(list).map(item => item.id), movedId, { targetId: session.id, edge: dropEdge(event) });
          dragOrigin.current = null;
          setDrop(null);
          if (moved && order) void moveSession(moved, order);
        },
      },
      indicator: drop?.list === list && drop.targetId === session.id ? drop.edge : null,
    };
  };

  const orderAnnouncer = (
    <p role="status" aria-live="polite" className="sr-only">{orderAnnouncement}</p>
  );

  const archiveSession = useCallback(async () => {
    if (!sessionMenu) return;
    const { sessionId, sessionName } = sessionMenu;
    const before = useOrchestrationSessionStore.getState();
    const wasOpen = useNavigationStore.getState().activeView === 'pane-chat' && before.selectedSessionId === sessionId;
    setSessionMenu(null);
    setActionError(null);
    // Archiving the open Session lands on Home, never on a Session the server or the
    // auto-selection picks. Leaving before the request means a person who opens something
    // else while it is in flight keeps what they opened.
    if (wasOpen) {
      void setActiveSession(null);
      navigateToSessions();
    }
    try {
      await update(
        { sessionId },
        { archived: true } satisfies OrchestrationSessionUpdateInput,
      );
      // A host switch during the request leaves nothing on the new host to undo.
      if (useOrchestrationSessionStore.getState().hostRevision !== before.hostRevision) return;
      setArchivedToast({ sessionId, sessionName, wasOpen, hostRevision: before.hostRevision });
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Failed to archive Session');
    }
  }, [navigateToSessions, refresh, sessionMenu, setActiveSession, update]);

  const undoArchive = useCallback(async () => {
    if (!archivedToast) return;
    const { sessionId, wasOpen, hostRevision } = archivedToast;
    // Every await can outlive the host; nothing may act on a host that never archived this Session.
    const hostChanged = () => useOrchestrationSessionStore.getState().hostRevision !== hostRevision;
    setArchivedToast(null);
    setActionError(null);
    try {
      await update({ sessionId }, { archived: false } satisfies OrchestrationSessionUpdateInput);
      if (hostChanged()) return;
      await refresh();
      // Reopen only if the person is still on Home where the archive left them.
      const stillHome = useNavigationStore.getState().activeView === 'sessions' && !useSessionStore.getState().activeSessionId;
      if (wasOpen && stillHome && !hostChanged()) await openSession(sessionId);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Failed to restore Session');
    }
  }, [archivedToast, openSession, refresh, update]);

  const moveDialogElement = (
    <MoveSessionToHostDialog sessionId={movingSessionId} onClose={() => setMovingSessionId(null)} onMoved={sessionId => void openSession(sessionId)} />
  );

  const archivedToastElement = archivedToast && (
    <UndoToast
      key={archivedToast.sessionId}
      message={`Archived ${archivedToast.sessionName}`}
      onUndo={() => void undoArchive()}
      onDismiss={clearArchivedToast}
    />
  );

  const pinSession = useCallback(async () => {
    if (!sessionMenu) return;
    const { sessionId, isPinned } = sessionMenu;
    setSessionMenu(null);
    setActionError(null);
    try {
      await update({ sessionId }, { isPinned: !isPinned } satisfies OrchestrationSessionUpdateInput);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Failed to update Session pin');
    }
  }, [refresh, sessionMenu, update]);

  const sessionsVisible = availabilityIsVisible(availability);
  const hasPinnedContent = pinnedSessions.length > 0 || Boolean(pinnedPaneRows);

  const renderSessionRow = (session: OrchestrationSessionRecord, placement: SessionRowPlacement): ReactNode => {
    const visibleAssociations = session.associations.filter(association => (
      !availablePaneIds || availablePaneIds.has(association.paneId)
    ));
    const paneRows = renderPane
      ? visibleAssociations
        .map((association, index) => renderPane(association.paneId, session.id, index))
        .filter((row): row is ReactNode => row !== null && row !== undefined)
      : [];
    // Rows the attention inbox hides still count toward the Session's activity.
    const visiblePaneIds = renderPane ? visibleAssociations.map(association => association.paneId) : [];
    const expanded = paneRows.length > 0 && expandedSessions.has(session.id);
    const isLegacy = session.id === LEGACY_ORCHESTRATION_SESSION_ID;
    const label = session.name || 'Pane Chat';
    const rowId = sessionTestId(session, placement);
    const panesId = `orchestration-session-panes-${placement}-${session.id}`;
    const isOpen = activeView === 'pane-chat' && session.id === selectedSessionId;
    const drag = sessionDragProps(session, placement);

    return (
      <div key={`${placement}-${session.id}`} className="group/orchestration-session relative" {...drag.target}>
        {drag.indicator && (
          <div
            data-testid="session-drop-indicator"
            aria-hidden="true"
            className={cn('pointer-events-none absolute inset-x-3 z-20 h-0.5 rounded-full bg-interactive', drag.indicator === 'before' ? '-top-px' : '-bottom-px')}
          />
        )}
        <div className={cn(
          'group/orchestration-row relative mx-2 flex h-7 w-[calc(100%-1rem)] items-center rounded-md text-[13px] transition-colors',
          isOpen ? 'bg-surface-selected text-text-primary' : 'text-text-secondary hover:bg-surface-hover',
        )}>
          {paneRows.length > 0 ? (
            <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} Panes`}
              aria-expanded={expanded} aria-controls={panesId}
              onClick={() => toggleSessionExpanded(session.id)}
              className="ml-1 flex h-6 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-surface-hover focus:outline-none">
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : <span className="ml-1 h-6 w-4 flex-shrink-0" aria-hidden="true" />}
          <button
            type="button"
            data-testid={rowId}
            aria-label={isLegacy ? label : `Open Session ${session.name}`}
            // Dragging a row tiles the Session beside another, the same gesture
            // as dragging a tab, or reorders it within its own list. Repository
            // rows carry only text/plain, so the drags never answer each other.
            {...drag.source}
            onClick={() => void openSession(session.id)}
            onContextMenu={event => handleSessionContextMenu(event, session)}
            onKeyDown={event => handleSessionKeyDown(event, session, placement)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded pl-2 pr-2 py-1 text-left focus:outline-none"
          >
            <SessionActivityDot session={session} paneIds={visiblePaneIds} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{label}</span>
            <SessionActivitySummary session={session} paneIds={visiblePaneIds} />
          </button>
          {/* Same masked hover slot as Pane rows; it covers the activity summary while shown. */}
          <div className={cn(
            'absolute inset-y-0.5 right-2 z-10 flex items-center bg-surface-secondary pr-0.5 opacity-0 transition-opacity group-hover/orchestration-row:opacity-100 group-focus-within/orchestration-row:opacity-100',
            isOpen
              ? 'bg-[linear-gradient(var(--color-surface-selected),var(--color-surface-selected))]'
              : 'group-hover/orchestration-row:bg-[linear-gradient(var(--color-surface-hover),var(--color-surface-hover))]',
          )}>
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              aria-haspopup="menu"
              title="Session actions"
              onClick={event => {
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                openSessionMenu(session, bounds.left, bounds.bottom, event.currentTarget);
              }}
              className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {paneRows.length > 0 && (
          <div id={panesId} className={cn('ml-6', !expanded && 'hidden')}>{paneRows}</div>
        )}
      </div>
    );
  };

  if (compact && !sessionsVisible) return null;
  if (!compact && !sessionsVisible && !hasPinnedContent) return null;

  if (compact) {
    return (
      <div role="group" aria-label="Sessions" className="contents">
        <div className="pane-sidebar-sessions-header sticky top-0 bottom-10 z-30 flex h-10 w-full shrink-0 items-center justify-center bg-surface-secondary">
          <Tooltip content="New Session" side="right">
            <button
              type="button"
              data-testid="compact-new-orchestration-session"
              data-compact-rail-item
              aria-label="New Session"
              onClick={() => setShowCreate(true)}
              className="flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"
            >
              <Plus className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
        {activeSessions.map(session => {
          const drag = sessionDragProps(session, 'rail');
          return (
          <Tooltip key={session.id} content={`${session.name} · ${statusLabel(session)}`} side="right">
            <button
              type="button"
              data-testid={sessionTestId(session, 'rail')}
              data-compact-rail-item
              aria-label={session.id === LEGACY_ORCHESTRATION_SESSION_ID ? 'Pane Chat' : `Open Session ${session.name}`}
              title={session.name}
              {...drag.source}
              {...drag.target}
              onClick={() => void openSession(session.id)}
              onContextMenu={event => handleSessionContextMenu(event, session)}
              onKeyDown={event => handleSessionKeyDown(event, session, 'rail')}
              className={cn(
                'flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-interactive',
                session.id === selectedSessionId ? 'bg-surface-selected text-text-primary' : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary',
                // The drop line is drawn outside the item, so it takes no room and moves nothing.
                drag.indicator && 'relative before:pointer-events-none before:absolute before:inset-x-1 before:h-0.5 before:rounded-full before:bg-interactive before:content-[""]',
                drag.indicator === 'before' && 'before:-top-[3px]',
                drag.indicator === 'after' && 'before:-bottom-[3px]',
              )}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border-primary">
                {session.name.trim().charAt(0).toUpperCase() || <Terminal className="h-3.5 w-3.5" />}
              </span>
            </button>
          </Tooltip>
          );
        })}
        {sessionError && (
          <Tooltip content={sessionError} side="right">
            <button
              type="button"
              data-testid="compact-sessions-error"
              data-compact-rail-item
              aria-label={selectionError ? "Retry selected Session" : "Sessions unavailable"}
              onClick={() => {
                if (selectionError && selectedSessionId) void openSession(selectedSessionId);
                else void load();
              }}
              className="flex h-9 w-9 items-center justify-center rounded text-status-error hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        {compactError && (
          <Tooltip content={compactError} side="right">
            <span role="alert" aria-label={compactError} className="flex h-9 w-9 items-center justify-center rounded text-status-error">!</span>
          </Tooltip>
        )}
        <SessionContextMenu
          menu={sessionMenu}
          onClose={() => setSessionMenu(null)}
          onArchive={() => void archiveSession()}
          onPin={() => void pinSession()}
          onMoveToHost={() => { setMovingSessionId(sessionMenu?.sessionId ?? null); setSessionMenu(null); }}
        />
        {moveDialogElement}
        <CreateOrchestrationSessionDialog isOpen={showCreate} onClose={() => setShowCreate(false)} onCreate={createSession} />
        {archivedToastElement}
        {orderAnnouncer}
      </div>
    );
  }

  return (
    <>
      {hasPinnedContent && (
        <div className="mt-3" role="group" aria-label="Pinned">
          <div data-testid="orchestration-pinned-section-header" className="group/section flex items-center justify-between gap-2 pl-4 pr-3 py-1">
            <button
              type="button"
              aria-expanded={isPinnedSectionExpanded}
              aria-controls="orchestration-pinned-list"
              onClick={() => setPinnedSectionExpanded(!isPinnedSectionExpanded)}
              className="min-w-0 flex-1 flex items-center justify-between gap-2 text-left text-[10px] font-semibold uppercase tracking-wider leading-4 text-text-tertiary transition-colors hover:text-text-primary focus-visible:text-text-primary"
            >
              <span className="truncate">Pinned</span>
              <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-visible/section:opacity-100">
                {isPinnedSectionExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-current" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-current" />
                )}
              </span>
            </button>
          </div>
          {isPinnedSectionExpanded && (
            <div id="orchestration-pinned-list">
              {pinnedSessions.map(session => renderSessionRow(session, 'pinned'))}
              {pinnedPaneRows}
            </div>
          )}
        </div>
      )}
      {sessionsVisible && <div className="contents" role="group" aria-label="Sessions">
        <div data-testid="sessions-section-header" className="pane-sidebar-sessions-header group/section sticky top-0 bottom-8 z-30 mt-3 flex h-8 shrink-0 items-center justify-between gap-2 bg-surface-secondary pl-4 pr-3 py-1">
          <button
            type="button"
            aria-expanded={sectionExpanded}
            aria-controls="orchestration-sessions-list"
            onClick={() => setSectionExpanded(!sectionExpanded)}
            className="min-w-0 flex-1 flex items-center justify-between gap-2 text-left text-[10px] font-semibold uppercase tracking-wider leading-4 text-text-tertiary transition-colors hover:text-text-primary focus-visible:text-text-primary"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">Sessions</span>
              <span
                className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center"
                role={availability === 'loading' ? 'status' : undefined}
                aria-label={availability === 'loading' ? 'Loading Sessions' : undefined}
              >
                {availability === 'loading' && <RefreshCw aria-hidden="true" className="h-3 w-3 animate-spin text-text-muted" />}
              </span>
            </span>
            <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-visible/section:opacity-100">
              {sectionExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-current" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-current" />
              )}
            </span>
          </button>
          <button
            type="button"
            data-testid="new-orchestration-session"
            aria-label="New Session"
            title="New Session"
            onClick={event => {
              event.stopPropagation();
              setShowCreate(true);
            }}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div id="orchestration-sessions-list" hidden={!sectionExpanded}>
        {sessionError && (
          <div className="mx-3 mb-1 rounded border border-status-error/40 bg-status-error/10 px-2 py-1.5 text-[11px] text-text-primary" role="alert">
            <p>{sessionError}</p>
            <button type="button" className="mt-1 underline" onClick={() => {
              if (selectionError && selectedSessionId) void openSession(selectedSessionId);
              else void load();
            }}>Retry</button>
          </div>
        )}
        {actionError && (
          <div className="mx-3 mb-1 rounded border border-status-error/40 bg-status-error/10 px-2 py-1.5 text-[11px] text-text-primary" role="alert">
            {actionError}
          </div>
        )}
        {availability === 'ready' && activeSessions.length === 0 && (
          <p className="px-4 py-1 text-[11px] text-text-muted">Create a Session to keep intent and discussion together.</p>
        )}
        {activeSessions.map(session => renderSessionRow(session, 'sessions'))}
        </div>
      </div>}
      <SessionContextMenu
        menu={sessionMenu}
        onClose={() => setSessionMenu(null)}
        onArchive={() => void archiveSession()}
        onPin={() => void pinSession()}
        onMoveToHost={() => { setMovingSessionId(sessionMenu?.sessionId ?? null); setSessionMenu(null); }}
      />
      {moveDialogElement}
      <CreateOrchestrationSessionDialog isOpen={showCreate} onClose={() => setShowCreate(false)} onCreate={createSession} />
      {archivedToastElement}
      {orderAnnouncer}
    </>
  );
}

interface SessionContextMenuProps {
  menu: SessionContextMenuState | null;
  onClose: () => void;
  onArchive: () => void;
  onPin: () => void;
  onMoveToHost: () => void;
}

function SessionContextMenu({ menu, onClose, onArchive, onPin, onMoveToHost }: SessionContextMenuProps) {
  const moveBlockedReason = useMoveToHostBlockedReason();
  const [renaming, setRenaming] = useState<SessionContextMenuState | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menu?.trigger) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // TerminalPopover's document listener closes the menu.
      menu?.trigger?.focus();
      return;
    }
    if (event.key === 'Tab') {
      // Like Dropdown: close and let Tab continue from the trigger, so focus never leaves an open menu behind.
      menu?.trigger?.focus();
      onClose();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const list = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = list.findIndex(item => item === document.activeElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    list[(index + step + list.length) % list.length]?.focus();
  };

  return (<>
    <TerminalPopover
      visible={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={onClose}
      className="w-48"
    >
      <div ref={menuRef} role="menu" aria-label={`Session actions for ${menu?.sessionName ?? 'Session'}`} onKeyDown={handleMenuKeyDown}>
        <PopoverButton role="menuitem" onClick={onPin}>
          <span className="flex items-center gap-2">
            {menu?.isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            {menu?.isPinned ? 'Unpin Session' : 'Pin Session'}
          </span>
        </PopoverButton>
        <PopoverButton role="menuitem" onClick={() => {
          if (!menu) return;
          setRenaming(menu); setName(menu.sessionName); setError(null); onClose();
        }}>
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename Session…</span>
        </PopoverButton>
        <PopoverButton
          role="menuitem"
          // Focusable while unavailable, so arrow keys reach it and its reason is announced.
          aria-disabled={moveBlockedReason !== null}
          title={moveBlockedReason ?? undefined}
          className={cn(moveBlockedReason && 'cursor-not-allowed opacity-50')}
          onClick={() => {
            if (moveBlockedReason) return;
            // The dialog returns focus to whatever had it when it opened; make that the row, not this closing item.
            menu?.returnFocusTo?.focus();
            onMoveToHost();
          }}
        >
          <span className="flex items-center gap-2"><ArrowRightLeft className="h-4 w-4" />Move to host…</span>
        </PopoverButton>
        <PopoverButton role="menuitem" variant="danger" onClick={onArchive}>
          <span className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            Archive Session
          </span>
        </PopoverButton>
      </div>
    </TerminalPopover>
    <Modal isOpen={renaming !== null} onClose={() => { if (!busy) setRenaming(null); }} ariaLabel="Rename Session">
      <form onSubmit={event => {
        event.preventDefault();
        if (!renaming || busy || !name.trim()) return;
        setBusy(true); setError(null);
        void useOrchestrationSessionStore.getState().update({ sessionId: renaming.sessionId }, { name: name.trim() })
          .then(() => setRenaming(null))
          .catch(failure => setError(failure instanceof Error ? failure.message : 'Could not rename Session'))
          .finally(() => setBusy(false));
      }}>
        <ModalHeader title="Rename Session" />
        <ModalBody>
          <Input label="Session name" autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} fullWidth />
          {error && <p role="alert" className="mt-2 text-sm text-status-error">{error}</p>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setRenaming(null)}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</Button>
        </ModalFooter>
      </form>
    </Modal>
  </>);
}
