import { CreateOrchestrationSessionDialog, type SessionCreateRequest } from './CreateOrchestrationSessionDialog';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { create as createStore } from 'zustand';
import { Archive, ChevronDown, ChevronRight, MoreHorizontal, Pin, PinOff, Plus, Pencil, RefreshCw, Terminal } from 'lucide-react';
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
import { useOrchestrationSessionActivity } from '../hooks/useAgentStatus';
import { AgentActivityDot, AgentStatusDot } from './ui/AgentStatusDot';
import { startSessionDrag } from '../utils/sessionDrag';

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
}

interface SessionContextMenuState {
  sessionId: string;
  sessionName: string;
  isPinned: boolean;
  x: number;
  y: number;
  /** The ⋯ button that opened the menu; focus moves into the menu and returns here on Escape. */
  trigger?: HTMLElement;
}

type SessionRowPlacement = 'pinned' | 'sessions';

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

/** Rolled-up agent status for a Session: its orchestrator plus child Panes. */
function SessionActivityDot({ session, paneIds }: { session: OrchestrationSessionRecord; paneIds: readonly string[] }) {
  const { status } = useOrchestrationSessionActivity(session.internalSessionId, paneIds);
  return status === 'unknown'
    ? <AgentActivityDot active={false} size="sm" className="flex-shrink-0" />
    : <AgentStatusDot status={status} size="sm" className="flex-shrink-0" />;
}

/** How much delegated work is in flight, in place of the plain child count. */
function SessionActivitySummary({ session, paneIds }: { session: OrchestrationSessionRecord; paneIds: readonly string[] }) {
  const { working, blocked } = useOrchestrationSessionActivity(session.internalSessionId, paneIds);
  if (blocked > 0) return <span className="pr-1 text-[10px] tabular-nums text-status-error">{blocked} need{blocked === 1 ? 's' : ''} input</span>;
  if (working > 0) return <span className="pr-1 text-[10px] tabular-nums text-text-secondary">{working} working</span>;
  if (paneIds.length === 0) return null;
  return <span className="pr-1 text-[10px] tabular-nums text-text-muted">{paneIds.length}</span>;
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
  const navigateToPaneChat = useNavigationStore(state => state.navigateToPaneChat);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const activeView = useNavigationStore(state => state.activeView);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const [showCreate, setShowCreate] = useState(false);
  const [sessionExpansionOverrides, setSessionExpansionOverrides] = useState<Map<string, boolean>>(new Map());
  const [sectionExpanded, setSectionExpanded] = useState(true);
  const [localPinnedSectionExpanded, setLocalPinnedSectionExpanded] = useState(true);
  const [sessionMenu, setSessionMenu] = useState<SessionContextMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hostRevision = useOrchestrationSessionStore(state => state.hostRevision);
  const pendingToast = useArchivedSessionToastStore(state => state.toast);
  const archivedToast = pendingToast?.hostRevision === hostRevision ? pendingToast : null;
  const compactError = actionError ?? sessionError;
  const isPinnedSectionExpanded = pinnedSectionExpanded ?? localPinnedSectionExpanded;
  const setPinnedSectionExpanded = onPinnedSectionExpandedChange ?? setLocalPinnedSectionExpanded;

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
      // Reconnection snapshots can still contain the selection preceding a failed click.
      // A new host clears selectionError during invalidation; explicit selection events
      // remain authoritative on the current host.
      const retainFailedIntent = detail?.kind === 'runtime-resync'
        && useOrchestrationSessionStore.getState().selectionError !== null;
      const adoptServerSelection = !retainFailedIntent
        && (detail?.kind === 'selected' || detail?.selectionChanged === true);
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

  const toggleSessionExpanded = useCallback((sessionId: string, expanded: boolean) => {
    setSessionExpansionOverrides(current => {
      const next = new Map(current);
      next.set(sessionId, !expanded);
      return next;
    });
  }, []);

  const openSessionMenu = useCallback((session: OrchestrationSessionRecord, x: number, y: number, trigger?: HTMLElement) => {
    setSessionMenu({
      sessionId: session.id,
      sessionName: session.name || 'Pane Chat',
      isPinned: session.isPinned === true,
      x,
      y,
      trigger,
    });
  }, []);

  const handleSessionContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>, session: OrchestrationSessionRecord) => {
    event.preventDefault();
    event.stopPropagation();
    openSessionMenu(session, event.clientX, event.clientY);
  }, [openSessionMenu]);

  const handleSessionKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>, session: OrchestrationSessionRecord) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    openSessionMenu(session, bounds.left, bounds.bottom);
  }, [openSessionMenu]);

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
    const expanded = sessionExpansionOverrides.get(session.id) ?? paneRows.length > 0;
    const isLegacy = session.id === LEGACY_ORCHESTRATION_SESSION_ID;
    const label = session.name || 'Pane Chat';
    const rowId = isLegacy
      ? placement === 'pinned' ? 'orchestration-pinned-pane-chat' : 'orchestration-pane-chat'
      : `${placement === 'pinned' ? 'orchestration-pinned-session' : 'orchestration-session'}-${session.id}`;
    const panesId = `orchestration-session-panes-${placement}-${session.id}`;
    const isOpen = activeView === 'pane-chat' && session.id === selectedSessionId;

    return (
      <div key={`${placement}-${session.id}`} className="group/orchestration-session">
        <div className={cn(
          'group/orchestration-row relative mx-2 flex h-7 w-[calc(100%-1rem)] items-center rounded-md text-[13px] transition-colors',
          isOpen ? 'bg-surface-selected text-text-primary' : 'text-text-secondary hover:bg-surface-hover',
        )}>
          {paneRows.length > 0 ? (
            <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} Panes`}
              aria-expanded={expanded} aria-controls={panesId}
              onClick={() => toggleSessionExpanded(session.id, expanded)}
              className="ml-1 flex h-6 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-surface-hover focus:outline-none">
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : <span className="ml-1 h-6 w-4 flex-shrink-0" aria-hidden="true" />}
          <button
            type="button"
            data-testid={rowId}
            aria-label={isLegacy ? label : `Open Session ${session.name}`}
            // Dragging a row tiles the Session beside another, the same gesture
            // as dragging a tab. Repository rows carry only text/plain, so the
            // two drags never answer each other's drop targets.
            draggable
            onDragStart={event => startSessionDrag(event.dataTransfer, session.id)}
            onClick={() => void openSession(session.id)}
            onContextMenu={event => handleSessionContextMenu(event, session)}
            onKeyDown={event => handleSessionKeyDown(event, session)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded pl-2 pr-2 py-1 text-left focus:outline-none"
          >
            <SessionActivityDot session={session} paneIds={visiblePaneIds} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{label}</span>
            <SessionActivitySummary session={session} paneIds={visiblePaneIds} />
          </button>
          {/* Same masked hover slot as Pane rows; it covers the activity summary while shown. */}
          <div className={cn(
            'absolute inset-y-0 right-2 z-10 flex items-center bg-surface-secondary pr-0.5 opacity-0 transition-opacity group-hover/orchestration-row:opacity-100 group-focus-within/orchestration-row:opacity-100',
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
        {activeSessions.map(session => (
          <Tooltip key={session.id} content={`${session.name} · ${statusLabel(session)}`} side="right">
            <button
              type="button"
              data-testid={session.id === LEGACY_ORCHESTRATION_SESSION_ID ? 'compact-pane-chat' : `compact-orchestration-session-${session.id}`}
              data-compact-rail-item
              aria-label={session.id === LEGACY_ORCHESTRATION_SESSION_ID ? 'Pane Chat' : `Open Session ${session.name}`}
              title={session.name}
              draggable
              onDragStart={event => startSessionDrag(event.dataTransfer, session.id)}
              onClick={() => void openSession(session.id)}
              onContextMenu={event => handleSessionContextMenu(event, session)}
              onKeyDown={event => handleSessionKeyDown(event, session)}
              className={cn(
                'flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-interactive',
                session.id === selectedSessionId ? 'bg-surface-selected text-text-primary' : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary',
              )}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border-primary">
                {session.name.trim().charAt(0).toUpperCase() || <Terminal className="h-3.5 w-3.5" />}
              </span>
            </button>
          </Tooltip>
        ))}
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
        />
        <CreateOrchestrationSessionDialog isOpen={showCreate} onClose={() => setShowCreate(false)} onCreate={createSession} />
        {archivedToastElement}
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
            onClick={() => setSectionExpanded(current => !current)}
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
          <div className="mx-3 mb-1 rounded border border-status-error/40 bg-status-error/10 px-2 py-1.5 text-[11px] text-status-error" role="alert">
            <p>{sessionError}</p>
            <button type="button" className="mt-1 underline" onClick={() => {
              if (selectionError && selectedSessionId) void openSession(selectedSessionId);
              else void load();
            }}>Retry</button>
          </div>
        )}
        {actionError && (
          <div className="mx-3 mb-1 rounded border border-status-error/40 bg-status-error/10 px-2 py-1.5 text-[11px] text-status-error" role="alert">
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
      />
      <CreateOrchestrationSessionDialog isOpen={showCreate} onClose={() => setShowCreate(false)} onCreate={createSession} />
      {archivedToastElement}
    </>
  );
}

interface SessionContextMenuProps {
  menu: SessionContextMenuState | null;
  onClose: () => void;
  onArchive: () => void;
  onPin: () => void;
}

function SessionContextMenu({ menu, onClose, onArchive, onPin }: SessionContextMenuProps) {
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
