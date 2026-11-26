import { registerRemoteWorkspaceRestore } from '../utils/remoteRestoration';
import { useApprovalColumnStore } from '../stores/approvalColumnStore';
import { SessionApprovalColumn, SessionApprovalsButton } from './approvals/SessionApprovals';
import { openNewSessionApprovals } from './approvals/useSessionApprovals';
import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Info, RefreshCw, Settings, Terminal, X } from 'lucide-react';
import { API } from '../utils/api';
import type { Session } from '../types/session';
import { PANE_CHAT_AGENT_LABELS, type PaneChatAgent, type PaneChatState } from '../../../shared/types/paneChat';
import type {
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import type { SessionTileNode, SessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { SessionProvider } from '../contexts/SessionContext';
import { SwitchToChatPaletteEntry } from './panels/SwitchToChat';
import { PanelContainer } from './panels/PanelContainer';
import { DropOverlay } from './panels/DropOverlay';
import { SessionWorkspacePanels } from './SessionWorkspacePanels';
import { SessionTodosTab } from './todos/SessionTodosTab';
import { showSessionTodo } from './todos/sessionTodosTabMemory';
import { SessionTodosSidebar } from './todos/SessionTodosSidebar';
import { SessionTileLayout, type SessionTileContext } from './SessionTileLayout';
import { Button } from './ui/Button';
import { SessionWorkspaceSkeleton } from './SessionWorkspaceSkeleton';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { SessionLaunchFields } from './SessionLaunchFields';
import { SessionChangesPanel, SessionOverviewPanel, useSessionOverview } from './SessionOverviewPanel';
import { useConfigStore } from '../stores/configStore';
import { DEFAULT_SESSION_PROFILE } from '../../../shared/types/sessionProfile';
import { cn } from '../utils/cn';
import { LiveRegion } from './ui/LiveRegion';
import { Tooltip } from './ui/Tooltip';
import {
  isArchivedOrchestrationSession,
  useOrchestrationSessionStore,
} from '../stores/orchestrationSessionStore';
import { useSessionWorkspaceLayoutStore } from '../stores/sessionWorkspaceLayoutStore';
import { usePanelStore } from '../stores/panelStore';
import { useNavigationStore } from '../stores/navigationStore';
import { shownSnapshot, useSessionTodosWaiting, useShownHostId, useTodosEnabled, useTodosStore } from '../stores/todosStore';
import { TodoStatusIcon } from './todos/TodoStatusIcon';
import { openTodo } from './todos/todosNavigation';
import { todoForSession } from './todos/page/todoSessionLink';
import { configuredAgent } from '../../../shared/agents';
import { useHotkey } from '../hooks/useHotkey';
import { readDraggedSessionId, startSessionDrag, useDraggedSessionId } from '../utils/sessionDrag';
import type { DropZone, LayoutDirection } from '../utils/layoutTree';
import {
  closeSessionTile,
  dropSessionOnTile,
  findSessionTileInDirection,
  focusSessionTile,
  focusedSessionId,
  focusedSessionTile,
  resizeSessionSplit,
  showSessionInLayout,
  toggleMaximizedTile,
} from '../utils/sessionWorkspaceLayout';

function responseError(response: { success: boolean; error?: string }, fallback: string): Error | null {
  return response.success ? null : new Error(response.error || fallback);
}

/** Every zone, for a tile being offered the Session it already shows. */
const NO_DROP_ZONES: readonly DropZone[] = ['center', 'left', 'right', 'top', 'bottom'];

export function PaneChatView() {
  const [legacyState, setLegacyState] = useState<PaneChatState<Session> | null>(null);
  const [legacyLoading, setLegacyLoading] = useState(true);
  const [legacyError, setLegacyError] = useState<string | null>(null);

  const availability = useOrchestrationSessionStore(state => state.availability);
  const storeError = useOrchestrationSessionStore(state => state.error);
  const hasActiveSessions = useOrchestrationSessionStore(state => state.sessions.some(
    session => !isArchivedOrchestrationSession(session),
  ));
  const loadSessions = useOrchestrationSessionStore(state => state.load);

  const loadLegacyPaneChat = useCallback(async () => {
    setLegacyLoading(true);
    setLegacyError(null);
    try {
      const response = await API.paneChat.getOrCreate();
      const responseFailure = responseError(response, 'Failed to open Pane Chat');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to open Pane Chat');
      setLegacyState(response.data);
    } catch (cause) {
      setLegacyError(cause instanceof Error ? cause.message : 'Failed to open Pane Chat');
    } finally {
      setLegacyLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.orchestrationSessions) {
      void loadLegacyPaneChat();
      return;
    }
    setLegacyLoading(false);
    void loadSessions();
  }, [loadLegacyPaneChat, loadSessions]);

  if (legacyState) {
    return (
      <LegacyPaneChatWorkspace
        state={legacyState}
        error={legacyError}
        onRetry={loadLegacyPaneChat}
      />
    );
  }

  const isOpening = legacyLoading || availability === 'idle' || (availability === 'loading' && !hasActiveSessions);
  if (isOpening) {
    return <OpeningSessionSkeleton />;
  }

  if (hasActiveSessions) return <SessionWorkspace />;

  const error = availability === 'error' ? storeError ?? 'Sessions could not be loaded' : legacyError;
  return (
    <div className="flex-1 flex items-center justify-center bg-bg-primary p-6">
      <div className="max-w-md text-center">
        <Terminal className="mx-auto mb-3 h-8 w-8 text-text-tertiary" />
        {error ? (
          <>
            <h2 className="text-base font-semibold text-text-primary">Sessions did not open</h2>
            <p role="alert" className="mt-2 text-sm text-text-secondary">{error}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-4"
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => void loadSessions()}
            >
              Retry
            </Button>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-text-primary">Choose a Session</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Create a new Session or restore one from Archived.
            </p>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="mt-4"
              onClick={() => window.dispatchEvent(new Event('open-create-orchestration-session'))}
            >
              New Session
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiled Sessions
// ---------------------------------------------------------------------------

/**
 * The window divided between Sessions.
 *
 * Owns the outer layout tree and keeps it agreeing with the rest of the app in
 * both directions: the focused tile's Session is the selected one, and
 * selecting a Session elsewhere (a sidebar click, a restored host) focuses its
 * tile or, when it is not on screen, takes over the focused one. With a single
 * tile that is exactly the pre-tiling behaviour.
 */
function SessionWorkspace() {
  const sessions = useOrchestrationSessionStore(state => state.sessions);
  const selectedSessionId = useOrchestrationSessionStore(state => state.selectedSessionId);
  const selectionRevision = useOrchestrationSessionStore(state => state.selectionRevision);
  const select = useOrchestrationSessionStore(state => state.select);
  const layout = useSessionWorkspaceLayoutStore(state => state.layout);
  const applyLayout = useSessionWorkspaceLayoutStore(state => state.apply);
  const hydrateLayout = useSessionWorkspaceLayoutStore(state => state.hydrate);
  const reconcileLayout = useSessionWorkspaceLayoutStore(state => state.reconcile);
  const remoteHostId = useConfigStore(state => (
    state.config ? getActiveRemoteHostId(state.config.remoteDaemon) : undefined
  ));
  const draggedSessionId = useDraggedSessionId();

  const activeSessionIds = useMemo(
    () => sessions.flatMap(session => isArchivedOrchestrationSession(session) ? [] : [session.id]),
    [sessions],
  );

  const currentLayout = useCallback(() => useSessionWorkspaceLayoutStore.getState().layout, []);

  const selectSession = useCallback((sessionId: string) => {
    if (sessionId === useOrchestrationSessionStore.getState().selectedSessionId) return;
    void select({ sessionId }).catch(() => undefined);
  }, [select]);

  // The Session on screen counts as opened when it shows (a launch restores one without a click)
  // and each time the window comes back to it: a phone's Recent lists Sessions by when they were opened.
  const shownChatPaneId = sessions.find(session => session.id === selectedSessionId)?.internalSessionId;
  useEffect(() => {
    if (!shownChatPaneId) return;
    const markOpened = () => { void API.sessions.markViewed(shownChatPaneId).catch(() => undefined); };
    markOpened();
    return window.electronAPI?.events?.onWindowFocusChanged?.(focused => { if (focused) markOpened(); });
  }, [shownChatPaneId]);

  // Something always has to be selected for the layout to have a starting tile;
  // what the layout already shows beats an arbitrary first Session.
  useEffect(() => {
    if (selectedSessionId || activeSessionIds.length === 0) return;
    const current = currentLayout();
    const focused = current ? focusedSessionId(current) : undefined;
    selectSession(focused && activeSessionIds.includes(focused) ? focused : activeSessionIds[0]);
  }, [activeSessionIds, currentLayout, selectSession, selectedSessionId]);

  // Read the host's remembered layout once its Sessions are known, then let the
  // selection adopt what it restored. The store hydrates once per host and only
  // that call resolves with a layout, so this runs exactly once per host —
  // never as a standing rule that could argue with the effect below.
  //
  // Deliberately not gated on the host being known: the store answers an unknown
  // host with a usable single-Session layout and stays unhydrated, so a slow or
  // failed config read cannot leave this view waiting forever. `remoteHostId` is
  // still a dependency, so learning the host re-runs the real hydrate.
  useEffect(() => {
    if (activeSessionIds.length === 0) return;
    let cancelled = false;
    void hydrateLayout(activeSessionIds, selectedSessionId, selectionRevision > 0).then(hydrated => {
      if (!hydrated || cancelled) return;
      const focused = focusedSessionId(hydrated);
      if (activeSessionIds.includes(focused)) selectSession(focused);
    });
    return () => { cancelled = true; };
  }, [activeSessionIds, hydrateLayout, remoteHostId, selectSession, selectedSessionId, selectionRevision]);

  // Archiving or deleting a Session retires its tile.
  useEffect(() => {
    reconcileLayout(activeSessionIds, selectedSessionId);
  }, [activeSessionIds, reconcileLayout, selectedSessionId]);

  // Selection moving is what drives the layout; the layout pushes back only
  // from a real gesture, through `commitLayout`. Edge-triggering on the
  // selection matters: a gesture's own `select` has not landed yet on the
  // render right after it, and reading the outgoing selection as an
  // instruction here would bounce focus straight back.
  const lastSelection = useRef(selectedSessionId);
  useEffect(() => {
    const previous = lastSelection.current;
    lastSelection.current = selectedSessionId;
    if (!layout || !selectedSessionId || previous === selectedSessionId) return;
    const next = showSessionInLayout(layout, selectedSessionId);
    if (next !== layout) applyLayout(next);
  }, [applyLayout, layout, selectedSessionId]);

  /** Apply a gesture's layout and let the Session selection follow its focus. */
  const commitLayout = useCallback((next: SessionWorkspaceLayout) => {
    applyLayout(next);
    selectSession(focusedSessionId(next));
  }, [applyLayout, selectSession]);

  const focusTile = useCallback((tileId: string) => {
    const current = currentLayout();
    if (!current) return;
    const next = focusSessionTile(current, tileId);
    if (next !== current) commitLayout(next);
  }, [commitLayout, currentLayout]);

  const dropSession = useCallback((tileId: string, sessionId: string, zone: DropZone) => {
    const current = currentLayout();
    if (!current) return;
    // Only a Session this host still has can be tiled.
    if (!activeSessionIds.includes(sessionId)) return;
    const next = dropSessionOnTile(current, tileId, sessionId, zone);
    if (next !== current) commitLayout(next);
  }, [activeSessionIds, commitLayout, currentLayout]);

  const closeTile = useCallback((tileId: string) => {
    const current = currentLayout();
    if (!current) return;
    const next = closeSessionTile(current, tileId);
    if (next !== current) commitLayout(next);
  }, [commitLayout, currentLayout]);

  const resizeTiles = useCallback((splitNodeId: string, sizes: number[]) => {
    const current = currentLayout();
    if (!current) return;
    applyLayout(resizeSessionSplit(current, splitNodeId, sizes));
  }, [applyLayout, currentLayout]);

  const focusDirection = useCallback((dir: LayoutDirection) => {
    const current = currentLayout();
    if (!current) return;
    const target = findSessionTileInDirection(current, dir);
    if (target) focusTile(target);
  }, [currentLayout, focusTile]);

  // Palette-only commands: tiling is a pointer gesture, and binding keys here
  // would collide with the in-Pane split shortcuts of the same shape.
  const isTiled = layout?.root.type === 'split';
  useHotkey({
    id: 'focus-session-tile-left',
    label: 'Focus Session Left',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('left'),
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-session-tile-right',
    label: 'Focus Session Right',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('right'),
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-session-tile-up',
    label: 'Focus Session Up',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('up'),
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-session-tile-down',
    label: 'Focus Session Down',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('down'),
    showInPalette: true,
  });
  useHotkey({
    id: 'close-session-tile',
    label: 'Stop tiling this Session',
    category: 'view',
    enabled: () => isTiled,
    action: () => {
      const current = currentLayout();
      if (current) closeTile(focusedSessionTile(current).id);
    },
    showInPalette: true,
  });

  const toggleTileMaximize = useCallback((tileId: string) => {
    const current = currentLayout();
    if (!current) return;
    const next = toggleMaximizedTile(current, tileId);
    if (next !== current) commitLayout(next);
  }, [commitLayout, currentLayout]);

  const renderTile = useCallback((tile: SessionTileNode, context: SessionTileContext) => (
    <SessionTile
      tile={tile}
      isFocused={context.isFocused}
      tiled={context.tiled}
      maximized={context.maximized}
      hidden={context.hidden}
      onToggleMaximize={context.tiled ? toggleTileMaximize : undefined}
      draggedSessionId={draggedSessionId}
      onFocus={focusTile}
      onDropSession={dropSession}
      onClose={context.tiled ? closeTile : undefined}
    />
  ), [closeTile, dropSession, draggedSessionId, focusTile, toggleTileMaximize]);

  if (!layout) {
    return <OpeningSessionSkeleton />;
  }

  // The displayed tree follows intent in this commit. The passive effect above
  // only remembers it; it must never expose the outgoing focused workspace.
  const displayedLayout = selectedSessionId ? showSessionInLayout(layout, selectedSessionId) : layout;
  return (
    <div data-testid="session-tile-layout" className="relative flex min-h-0 flex-1 overflow-hidden bg-bg-primary">
      <SessionTileLayout
        layout={displayedLayout}
        focusedTileId={focusedSessionTile(displayedLayout).id}
        renderTile={renderTile}
        onSizesChange={resizeTiles}
      />
    </div>
  );
}

interface SessionTileProps {
  tile: SessionTileNode;
  isFocused: boolean;
  tiled: boolean;
  /** This tile is maximized over the others (P4). */
  maximized?: boolean;
  /** Another tile is maximized over this one. */
  hidden?: boolean;
  /** Maximize this tile over the others, or restore; absent while it is the only tile. */
  onToggleMaximize?: (tileId: string) => void;
  draggedSessionId: string | null;
  onFocus: (tileId: string) => void;
  onDropSession: (tileId: string, sessionId: string, zone: DropZone) => void;
  /** Absent while the window shows a single Session: the last tile never closes. */
  onClose?: (tileId: string) => void;
  inline?: boolean;
}

const ignoreTileEvent = () => undefined;

/**
 * One Session shown live beside something else (Approvals' right side): the same workspace as
 * its tile, with its orchestrator tab, chat or terminal, and its tab controls kept inside it.
 */
export function SessionBeside({ sessionId }: { sessionId: string }) {
  const tile = useMemo((): SessionTileNode => ({ type: 'session', id: `beside-${sessionId}`, sessionId }), [sessionId]);
  return <SessionTile tile={tile} isFocused tiled={false} inline draggedSessionId={null} onFocus={ignoreTileEvent} onDropSession={ignoreTileEvent} />;
}

/**
 * One Session filling its region of the window: its own live terminal, its own
 * tab splits, its own navigation. Tiles stay mounted whether focused or not.
 */
function SessionTile({
  tile,
  isFocused,
  tiled,
  draggedSessionId,
  onFocus,
  onDropSession,
  onClose,
  inline,
  maximized = false,
  hidden = false,
  onToggleMaximize,
}: SessionTileProps) {
  const sessionId = tile.sessionId;
  const hostId = useConfigStore(state => state.config ? getActiveRemoteHostId(state.config.remoteDaemon) : undefined);
  const visit = useOrchestrationSessionStore(state => state.selectionVisits[sessionId] ?? 0);
  const [view, setView] = useState<OrchestrationSessionView<Session> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingSessionId, setLoadingSessionId] = useState(sessionId);
  const [loadingHostId, setLoadingHostId] = useState(hostId);
  const [loadingVisit, setLoadingVisit] = useState(visit);
  const selectionError = useOrchestrationSessionStore(state => state.selectedSessionId === sessionId ? state.selectionError : null);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const requestGeneration = useRef(0);
  const agentReloadKey = useRef<string | null>(null);
  const record = useOrchestrationSessionStore(state => state.sessions.find(session => session.id === sessionId));

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoadingSessionId(sessionId);
    setLoadingHostId(hostId);
    setLoadingVisit(visit);
    setIsLoading(true);
    setError(null);
    try {
      const response = await API.orchestrationSessions.get({ sessionId });
      if (generation !== requestGeneration.current) return;
      const responseFailure = responseError(response, 'Failed to open Session');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to open Session');
      setView(response.data);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setError(cause instanceof Error ? cause.message : 'Failed to open Session');
      setView(null);
    } finally {
      if (generation === requestGeneration.current) setIsLoading(false);
    }
  }, [sessionId, hostId, visit]);

  useEffect(() => {
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]);

  // The view carries a snapshot of the record; a changed agent, or an agent tab
  // that moved (Switch to chat), needs a fresh panel, while any other edit only
  // needs the newer record folded in.
  useEffect(() => {
    if (!view || !record || view.session.id !== record.id) return;
    if (view.agent !== record.agent || view.panel.id !== record.panelIds[record.agent]) {
      const reloadKey = `${record.id}:${record.agent}:${record.panelIds[record.agent]}`;
      if (agentReloadKey.current === reloadKey) return;
      agentReloadKey.current = reloadKey;
      void load().finally(() => {
        if (agentReloadKey.current === reloadKey) agentReloadKey.current = null;
      });
      return;
    }
    agentReloadKey.current = null;
    if (view.session.revision === record.revision) return;
    setView(current => current ? { ...current, session: record } : current);
  }, [load, record, view]);

  const handleOverviewUpdate = useCallback(async (input: OrchestrationSessionUpdateInput): Promise<OrchestrationSessionRecord> => {
    if (!view) throw new Error('This Session is not open');
    const next = await useOrchestrationSessionStore.getState().update(
      { sessionId },
      { ...input, expectedRevision: view.session.revision },
    );
    setView(current => current ? { ...current, session: next } : current);
    return next;
  }, [sessionId, view]);

  const handleDragStart = useCallback((event: React.DragEvent) => {
    startSessionDrag(event.dataTransfer, sessionId);
  }, [sessionId]);

  const handleDrop = useCallback((zone: DropZone, event: React.DragEvent) => {
    setDropZone(null);
    // The payload is authoritative; the tracked id covers a drag whose
    // dragstart this window never saw.
    const dragged = readDraggedSessionId(event.dataTransfer) ?? draggedSessionId;
    if (dragged) onDropSession(tile.id, dragged, zone);
  }, [draggedSessionId, onDropSession, tile.id]);

  const handleDropZoneChange = useCallback((zone: DropZone | null) => setDropZone(zone), []);

  const focusThisTile = useCallback(() => onFocus(tile.id), [onFocus, tile.id]);

  const chrome: SessionTileChrome = useMemo(() => ({
    tiled,
    inline,
    isFocused,
    maximized,
    hidden,
    onToggleMaximize: onToggleMaximize ? () => onToggleMaximize(tile.id) : undefined,
    onDragStart: handleDragStart,
    onClose: onClose ? () => onClose(tile.id) : undefined,
  }), [handleDragStart, hidden, inline, isFocused, maximized, onClose, onToggleMaximize, tile.id, tiled]);

  // A tile already showing the dragged Session has nothing to offer it.
  const isDragSource = draggedSessionId === sessionId;

  return (
    <div
      className={cn(
        // h-full/w-full fills an Allotment pane; flex-1 fills the plain flex
        // row a single tile sits in. A tile is never content-sized.
        'relative flex h-full w-full flex-1 min-w-0 min-h-0 flex-col overflow-hidden bg-bg-primary',
      )}
      data-session-tile={sessionId}
      // A Session shown beside something else (SessionBeside) is not a tile of the layout.
      data-session-inline={inline || undefined}
      data-session-focused={isFocused}
      onMouseDownCapture={focusThisTile}
      onFocusCapture={focusThisTile}
    >
      {view && view.session.id === sessionId && loadingSessionId === sessionId && loadingHostId === hostId && loadingVisit === visit && !isLoading && !selectionError && !error ? (
        <NamedSessionWorkspace
          // Changing which Session a tile shows starts that Session's workspace
          // fresh, exactly as switching Sessions always has: its inspector, its
          // terminal dock and its tab state belong to the Session, not the tile.
          key={view.session.id}
          view={view}
          error={error}
          chrome={chrome}
          onOverviewUpdate={handleOverviewUpdate}
          onRetry={() => void load()}
        />
      ) : (
        <SessionTileFallback
          record={record}
          error={loadingSessionId === sessionId && loadingHostId === hostId && loadingVisit === visit ? selectionError ?? error : null}
          isLoading={!selectionError && (loadingSessionId !== sessionId || loadingHostId !== hostId || loadingVisit !== visit || isLoading)}
          chrome={chrome}
          onRetry={() => {
            if (selectionError) void useOrchestrationSessionStore.getState().select({ sessionId }).catch(() => undefined);
            void load();
          }}
        />
      )}

      {/* A drag shield: xterm and webviews swallow drag events otherwise. */}
      {draggedSessionId && <div className="absolute inset-0 z-30" style={{ background: 'transparent' }} />}
      {draggedSessionId && (
        <div className="absolute inset-0 z-40" data-pane-session-drop-target="true">
          <DropOverlay
            activeZone={dropZone}
            onZoneChange={handleDropZoneChange}
            onDrop={handleDrop}
            disabledZones={isDragSource ? NO_DROP_ZONES : undefined}
          />
        </div>
      )}
    </div>
  );
}

function SessionTileFallback({ record, error, isLoading, chrome, onRetry }: {
  record?: OrchestrationSessionRecord;
  error: string | null;
  isLoading: boolean;
  chrome: SessionTileChrome;
  onRetry: () => void;
}) {
  const name = record?.name;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionTileHeader name={name ?? 'Session'} chrome={chrome} />
      {isLoading ? (
        <SavedSessionSkeleton record={record} name={name ?? 'Session'} chromeInline={chrome.tiled || Boolean(chrome.inline)} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
          <div>
            <p role="alert" className="text-sm text-text-secondary">{error ?? 'This Session did not open.'}</p>
            <Button type="button" variant="secondary" size="sm" className="mt-3"
              icon={<RefreshCw className="h-4 w-4" />} onClick={onRetry}>Retry</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The agent tab's title, as the host names it, for a Session not open yet. */
function agentTabTitle(record: OrchestrationSessionRecord | undefined): string {
  return record ? `${record.name} · ${configuredAgent(record.agent).title}` : 'Session';
}

/** A Session's workspace skeleton, in the layout this window last showed it with. */
function SavedSessionSkeleton({ record, name, chromeInline }: { record?: OrchestrationSessionRecord; name: string; chromeInline: boolean }) {
  const internalId = record?.internalSessionId;
  const layout = usePanelStore(state => (internalId ? state.layouts[internalId] : undefined));
  const panels = usePanelStore(state => (internalId ? state.panels[internalId] : undefined));
  return <SessionWorkspaceSkeleton name={name} tabTitle={agentTabTitle(record)} agentPanelId={record?.panelIds[record.agent]}
    chain={internalId} layout={layout} panels={panels} chromeInline={chromeInline} />;
}

/** Before the Sessions list arrives: the selected Session's workspace, if it is known yet. */
function OpeningSessionSkeleton() {
  const record = useOrchestrationSessionStore(state => state.sessions.find(session => session.id === state.selectedSessionId));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      <SavedSessionSkeleton record={record} name={record?.name ?? 'Sessions'} chromeInline={false} />
    </div>
  );
}

interface SessionTileChrome {
  /** False while the window shows a single Session. */
  tiled: boolean;
  /** Shown beside something else (Approvals): its tab controls stay inside it, with no tile header. */
  inline?: boolean;
  isFocused: boolean;
  /** Maximized over the other tiles (P4). */
  maximized?: boolean;
  /** Hidden under a maximized tile: stays live, but its terminals deactivate. */
  hidden?: boolean;
  /** Maximize the tile or restore it; absent while it is the only tile. */
  onToggleMaximize?: () => void;
  onDragStart: (event: React.DragEvent) => void;
  /** Absent for the last tile. */
  onClose?: () => void;
}

/**
 * A tile's title row, and the handle it is dragged by: the same gesture as a
 * tab, one level up.
 */
function SessionTileHeader({ name, chrome, error, actions }: {
  name: string;
  chrome: SessionTileChrome;
  error?: string | null;
  actions?: React.ReactNode;
}) {
  // The window title already names a single Session, including native frames.
  if (!chrome.tiled) {
    return (
      <>
        <h1 className="sr-only">{name}</h1>
        {error && <p role="alert" className="px-4 py-1 text-xs text-status-error">{error}</p>}
      </>
    );
  }

  return (
    <div
      draggable
      onDragStart={chrome.onDragStart}
      data-testid="session-tile-header"
      title={`Drag ${name} beside another Session`}
      className="flex min-h-11 flex-shrink-0 cursor-grab items-center justify-between gap-3 border-b border-border-primary px-4 py-1.5 active:cursor-grabbing"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Terminal className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-text-primary">{name}</h1>
        </div>
        {error && <span role="alert" className="truncate text-xs text-status-error">{error}</span>}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {actions}
        {chrome.onClose && (
          <Tooltip content="Stop tiling this Session" side="bottom">
            <button
              type="button"
              aria-label={`Stop tiling ${name}`}
              onClick={chrome.onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function PaneChatAgentBadge({ agent }: { agent: PaneChatAgent }) {
  return (
    <span
      data-testid="pane-chat-agent-badge"
      aria-label={`Session agent: ${PANE_CHAT_AGENT_LABELS[agent]}`}
      className="inline-flex h-7 items-center rounded-md border border-border-secondary bg-surface-secondary px-2.5 text-xs font-medium text-text-secondary"
    >
      {PANE_CHAT_AGENT_LABELS[agent]}
    </span>
  );
}

interface LegacyPaneChatWorkspaceProps {
  state: PaneChatState<Session>;
  error: string | null;
  onRetry: () => void;
}

function LegacyPaneChatWorkspace({ state, error, onRetry }: LegacyPaneChatWorkspaceProps) {
  return (
    <div className="pane-chat-shell flex-1 flex flex-col overflow-hidden bg-bg-primary">
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border-primary px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
          <h1 className="truncate text-sm font-semibold text-text-primary">{state.session.name || 'Pane Chat'}</h1>
          {error && <span role="alert" className="truncate text-xs text-status-error">{error}</span>}
        </div>
        <PaneChatAgentBadge agent={state.agent} />
      </div>
      <SessionProvider session={state.session}>
        <div className="min-h-0 flex-1 overflow-hidden">
          <PanelContainer panel={state.panel} isActive={true} autoFocus={true} />
        </div>
      </SessionProvider>
      {error && <button type="button" className="sr-only" onClick={onRetry}>Retry Pane Chat</button>}
    </div>
  );
}

interface NamedSessionWorkspaceProps {
  view: OrchestrationSessionView<Session>;
  error: string | null;
  chrome: SessionTileChrome;
  onOverviewUpdate: (input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
  onRetry: () => void;
}

function NamedSessionWorkspace({ view, error, chrome, onOverviewUpdate, onRetry }: NamedSessionWorkspaceProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const showsTrustPrompt = usePanelStore(state => state.agentStatus[view.panel.id] === 'blocked'
    && state.agentStatusReason[view.panel.id] === 'workspace_trust_prompt');
  const { overview, error: overviewError, refresh: refreshOverview } = useSessionOverview(view.session.id);
  useEffect(() => registerRemoteWorkspaceRestore(() => refreshOverview(true)), [refreshOverview]);

  const saveOverview = useCallback(async (input: OrchestrationSessionUpdateInput) => {
    const record = await onOverviewUpdate(input);
    setStatusAnnouncement(`${record.name} overview saved`);
    return record;
  }, [onOverviewUpdate]);

  const approvalOpen = useApprovalColumnStore(state => state.open[`session:${view.session.id}`] !== undefined);
  const todosWaiting = useSessionTodosWaiting(view.session.id);
  // A new approval opens beside the chat on its own; shown inside another approval's column, it doesn't (D-114).
  useEffect(() => (chrome.inline ? undefined : openNewSessionApprovals(view.session.id, view.panel.id)), [chrome.inline, view.session.id, view.panel.id]);
  const sessionControls = (<>
    {/* Shown inside another approval's column (its origin tab), the Session doesn't open approvals of its own. */}
    {!chrome.inline && <SessionApprovalsButton sessionId={view.session.id} />}
    {chrome.isFocused && <SwitchToChatPaletteEntry key={view.panel.id} panel={view.panel} view="session" />}
    <Tooltip content="Session settings" side="bottom">
      <button type="button" aria-label="Session settings" onClick={() => setShowSettings(true)}
        className="needs-full-access inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary">
        <Settings className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  </>);

  return (
    <div data-session-content-id={view.session.id} className="pane-chat-shell flex-1 flex min-h-0 flex-col overflow-hidden bg-bg-primary">
      <LiveRegion>{statusAnnouncement}</LiveRegion>
      <SessionTileHeader name={view.session.name} chrome={chrome} error={error} />
      <TodoBreadcrumb session={view.session} />
      {showSettings && <SessionSettingsDialog record={view.session} onClose={() => setShowSettings(false)} onSave={saveOverview} />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SessionProvider session={view.internalSession}>
          <SessionWorkspacePanels agentPanel={view.panel} agentPanelIds={Object.values(view.session.panelIds)}
            toolbarActions={sessionControls}
            stageNotice={showsTrustPrompt && <FolderTrustNotice />}
            approval={chrome.inline ? undefined : {
              open: approvalOpen,
              onClose: () => useApprovalColumnStore.getState().close(`session:${view.session.id}`),
              render: (closeLabel, onClose, focused) => (
                <SessionApprovalColumn sessionId={view.session.id} sessionName={view.session.name} inChat={view.panel.id} closeLabel={closeLabel} onClose={onClose} focused={focused} />
              ),
            }}
            chromeInline={chrome.tiled || chrome.inline}
            focusWithin={chrome.isFocused}
            hidden={chrome.hidden}
            tileMaximized={chrome.maximized}
            onToggleTileMaximize={chrome.onToggleMaximize}
            overviewContent={<SessionOverviewPanel
            record={view.session}
            folderSessionId={view.panel.sessionId}
            overview={overview}
            error={overviewError}
            onRefresh={refreshOverview}
            onUpdate={async input => {
              const record = await saveOverview(input);
              await refreshOverview();
              return record;
            }}
            onRetry={onRetry}
          />}
            todosContent={<SessionTodosTab sessionId={view.session.id} inChat={view.panel.id} />}
            todosWaiting={todosWaiting}
            sidebarTodosContent={showTodosTab => <SessionTodosSidebar sessionId={view.session.id} onOpen={number => { showSessionTodo(view.session.id, number); showTodosTab(); }} />}
            changesContent={<SessionChangesPanel overview={overview} error={overviewError} onRetry={onRetry} />} />
        </SessionProvider>
      </div>
    </div>
  );
}

/**
 * A to-do's Session names its to-do at the left of its header (round 8, T-4): `← T-12 · Invoice PDFs`,
 * one click back to that to-do's page, the one you opened the Session from when you did. No key is
 * bound for it here: Esc belongs to the agent's terminal.
 */
function TodoBreadcrumb({ session }: { session: OrchestrationSessionRecord }) {
  // The shown computer's to-dos, once read from it (a list from the computer shown before a switch is not).
  const shownHost = useShownHostId();
  const rows = useTodosStore(state => shownSnapshot(state, shownHost)?.rows);
  const origin = useNavigationStore(state => state.todoSessionOrigin);
  const link = useMemo(() => todoForSession(session, rows, shownHost, origin), [session, rows, shownHost, origin]);
  const enabled = useTodosEnabled();
  if (!link || !enabled) return null;
  const words = link.title ? `${link.ref} · ${link.title}` : link.ref;
  const action = link.cameFrom ? `Back to ${words}` : `Open ${words}`;
  return (
    <div className="flex h-8 flex-shrink-0 items-center border-b border-border-primary bg-bg-chrome px-2" data-testid="session-todo-crumb-bar">
      <button type="button" onClick={() => openTodo(link.number)} aria-label={action} title={action}
        className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        data-testid="session-todo-crumb" data-todo={link.number} data-came-from={link.cameFrom}>
        <ArrowLeft className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        {link.status && <TodoStatusIcon status={link.status} />}
        <span className="flex-shrink-0 font-semibold text-text-primary">{link.ref}</span>
        {link.title && <span className="min-w-0 truncate">· {link.title}</span>}
      </button>
    </div>
  );
}

const FOLDER_TRUST_NOTICE = 'The agent is asking whether to trust this folder. It is Pane\'s own folder for this Session\'s notes, with no project code, so it is safe to trust.';

/** Overlays the top terminal row, which holds only the blank line and rule above the trust prompt, so the terminal keeps its size. */
function FolderTrustNotice() {
  return (
    <div role="status" title={FOLDER_TRUST_NOTICE}
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-7 items-center gap-2 border-b border-interactive/30 bg-surface-secondary px-3 text-xs text-text-primary">
      <Info className="h-3.5 w-3.5 flex-shrink-0 text-status-info" aria-hidden="true" />
      <span className="min-w-0 truncate">{FOLDER_TRUST_NOTICE}</span>
    </div>
  );
}

function SessionSettingsDialog({ record, onClose, onSave }: {
  record: OrchestrationSessionRecord;
  onClose: () => void;
  onSave: (input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
}) {
  const config = useConfigStore(state => state.config);
  const fetchConfig = useConfigStore(state => state.fetchConfig);
  const [command, setCommand] = useState(record.launchCommand ?? '');
  const [customResume, setCustomResume] = useState<CustomCommandResume | null>(record.customResume ?? null);
  const [profile, setProfile] = useState(record.profile ?? DEFAULT_SESSION_PROFILE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!config) void fetchConfig().catch(() => undefined);
  }, [config, fetchConfig]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ launchCommand: command, profile, customResume });
      onClose();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Failed to save Session settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="md" ariaLabel="Session settings">
      <form onSubmit={save} className="flex min-h-0 flex-col">
        <ModalHeader title="Session settings" />
        <ModalBody className="min-h-0 space-y-4">
          <p className="text-sm text-text-secondary">Saved changes apply the next time this Session terminal starts. Saving keeps the current conversation running.</p>
          <SessionLaunchFields resume={customResume} onResumeChange={setCustomResume} command={command} profile={profile} customCommands={config?.customCommands} onCommandChange={setCommand} onProfileChange={setProfile} />
          {saveError && <p role="alert" className="text-sm text-status-error">{saveError}</p>}
        </ModalBody>
        <ModalFooter className="shrink-0">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving} loadingText="Saving…">Save for next launch</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

