import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, RefreshCw, Settings, Terminal, X } from 'lucide-react';
import { API } from '../utils/api';
import type { Session } from '../types/session';
import { PANE_CHAT_AGENT_LABELS, type PaneChatAgent, type PaneChatState } from '../../../shared/types/paneChat';
import type {
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import type { SessionTileNode, SessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { SessionProvider } from '../contexts/SessionContext';
import { PanelContainer } from './panels/PanelContainer';
import { DropOverlay } from './panels/DropOverlay';
import { SessionWorkspacePanels } from './SessionWorkspacePanels';
import { SessionTileLayout, type SessionTileContext } from './SessionTileLayout';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { SessionLaunchFields } from './SessionLaunchFields';
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
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
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
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary text-text-secondary">
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
          <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" />
          <span>{availability === 'unavailable' ? 'Opening Pane Chat…' : 'Opening Sessions…'}</span>
        </div>
      </div>
    );
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
              Create a new Session or restore one from Archived to start a chat.
            </p>
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
    () => sessions.filter(session => !isArchivedOrchestrationSession(session)).map(session => session.id),
    [sessions],
  );

  const currentLayout = useCallback(() => useSessionWorkspaceLayoutStore.getState().layout, []);

  const selectSession = useCallback((sessionId: string) => {
    if (sessionId === useOrchestrationSessionStore.getState().selectedSessionId) return;
    void select({ sessionId }).catch(() => undefined);
  }, [select]);

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
  useEffect(() => {
    if (remoteHostId === undefined || activeSessionIds.length === 0) return;
    void hydrateLayout(activeSessionIds, selectedSessionId).then(hydrated => {
      if (!hydrated) return;
      const focused = focusedSessionId(hydrated);
      if (activeSessionIds.includes(focused)) selectSession(focused);
    });
  }, [activeSessionIds, hydrateLayout, remoteHostId, selectSession, selectedSessionId]);

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
    keys: '',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('left'),
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-session-tile-right',
    label: 'Focus Session Right',
    keys: '',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('right'),
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-session-tile-up',
    label: 'Focus Session Up',
    keys: '',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('up'),
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-session-tile-down',
    label: 'Focus Session Down',
    keys: '',
    category: 'view',
    enabled: () => isTiled,
    action: () => focusDirection('down'),
    showInPalette: true,
  });
  useHotkey({
    id: 'close-session-tile',
    label: 'Stop tiling this Session',
    keys: '',
    category: 'view',
    enabled: () => isTiled,
    action: () => {
      const current = currentLayout();
      if (current) closeTile(focusedSessionTile(current).id);
    },
    showInPalette: true,
  });

  const renderTile = useCallback((tile: SessionTileNode, context: SessionTileContext) => (
    <SessionTile
      tile={tile}
      isFocused={context.isFocused}
      tiled={context.tiled}
      draggedSessionId={draggedSessionId}
      onFocus={focusTile}
      onDropSession={dropSession}
      onClose={context.tiled ? closeTile : undefined}
    />
  ), [closeTile, dropSession, draggedSessionId, focusTile]);

  if (!layout) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary text-text-secondary">
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
          <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" />
          <span>Opening Sessions…</span>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="session-tile-layout" className="relative flex min-h-0 flex-1 overflow-hidden bg-bg-primary">
      <SessionTileLayout
        layout={layout}
        focusedTileId={focusedSessionTile(layout).id}
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
  draggedSessionId: string | null;
  onFocus: (tileId: string) => void;
  onDropSession: (tileId: string, sessionId: string, zone: DropZone) => void;
  /** Absent while the window shows a single Session: the last tile never closes. */
  onClose?: (tileId: string) => void;
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
}: SessionTileProps) {
  const sessionId = tile.sessionId;
  const [view, setView] = useState<OrchestrationSessionView<Session> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const requestGeneration = useRef(0);
  const agentReloadKey = useRef<string | null>(null);
  const record = useOrchestrationSessionStore(state => state.sessions.find(session => session.id === sessionId));

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
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
  }, [sessionId]);

  useEffect(() => {
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]);

  // The view carries a snapshot of the record; a changed agent needs a fresh
  // panel, while any other edit only needs the newer record folded in.
  useEffect(() => {
    if (!view || !record || view.session.id !== record.id) return;
    if (view.agent !== record.agent) {
      const reloadKey = `${record.id}:${record.agent}`;
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
    isFocused,
    onDragStart: handleDragStart,
    onClose: onClose ? () => onClose(tile.id) : undefined,
  }), [handleDragStart, isFocused, onClose, tile.id, tiled]);

  // A tile already showing the dragged Session has nothing to offer it.
  const isDragSource = draggedSessionId === sessionId;

  return (
    <div
      className={cn(
        // h-full/w-full fills an Allotment pane; flex-1 fills the plain flex
        // row a single tile sits in. A tile is never content-sized.
        'relative flex h-full w-full flex-1 min-w-0 min-h-0 flex-col overflow-hidden bg-bg-primary',
        tiled && isFocused && 'ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-interactive-primary)_30%,transparent)]',
      )}
      onMouseDownCapture={focusThisTile}
      onFocusCapture={focusThisTile}
    >
      {view ? (
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
          name={record?.name}
          error={error}
          isLoading={isLoading}
          chrome={chrome}
          onRetry={() => void load()}
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

function SessionTileFallback({ name, error, isLoading, chrome, onRetry }: {
  name?: string;
  error: string | null;
  isLoading: boolean;
  chrome: SessionTileChrome;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionTileHeader name={name ?? 'Session'} chrome={chrome} />
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
        {isLoading ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-text-secondary">
            <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" />
            <span>Opening {name ?? 'Session'}…</span>
          </div>
        ) : (
          <div>
            <p role="alert" className="text-sm text-text-secondary">{error ?? 'This Session did not open.'}</p>
            <Button type="button" variant="secondary" size="sm" className="mt-3"
              icon={<RefreshCw className="h-4 w-4" />} onClick={onRetry}>Retry</Button>
          </div>
        )}
      </div>
    </div>
  );
}

interface SessionTileChrome {
  /** False while the window shows a single Session. */
  tiled: boolean;
  isFocused: boolean;
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
          <h1 className="truncate text-sm font-semibold text-text-primary">Pane Chat</h1>
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
  const [overview, setOverview] = useState<OrchestrationSessionOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const overviewRequestId = useRef(0);
  const overviewRefreshTimer = useRef<number | null>(null);
  const isMounted = useRef(false);

  const refreshOverview = useCallback(async () => {
    const sessionId = view.session.id;
    const requestId = ++overviewRequestId.current;
    const isCurrentRequest = () => isMounted.current && requestId === overviewRequestId.current;

    try {
      const response = await API.orchestrationSessions.overview({ sessionId });
      const responseFailure = responseError(response, 'Failed to refresh Session overview');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to refresh Session overview');
      if (!isCurrentRequest()) return;
      setOverview(response.data);
      setOverviewError(null);
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setOverviewError(cause instanceof Error ? cause.message : 'Failed to refresh Session overview');
    }
  }, [view.session.id]);

  const scheduleOverviewRefresh = useCallback(() => {
    if (!isMounted.current || overviewRefreshTimer.current !== null) return;
    overviewRefreshTimer.current = window.setTimeout(() => {
      overviewRefreshTimer.current = null;
      if (isMounted.current) void refreshOverview();
    }, 50);
  }, [refreshOverview]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      overviewRequestId.current += 1;
      if (overviewRefreshTimer.current !== null) {
        window.clearTimeout(overviewRefreshTimer.current);
        overviewRefreshTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  useEffect(() => {
    const events = window.electronAPI?.events;
    if (!events) return;

    const currentAssociations = () => {
      const state = useOrchestrationSessionStore.getState();
      return state.sessions.find(session => session.id === view.session.id)?.associations ?? [];
    };
    const isAssociatedPane = (paneId: string) => currentAssociations().some(association => association.paneId === paneId);
    const isAssociatedPanel = (panelId: string, paneId: string) => currentAssociations().some(association => (
      association.paneId === paneId
      && (association.panelIds.length === 0 || association.panelIds.includes(panelId))
    ));

    const unsubscribeSessionUpdated = events.onSessionUpdated(session => {
      if (isAssociatedPane(session.id)) scheduleOverviewRefresh();
    });
    const unsubscribeSessionDeleted = events.onSessionDeleted(session => {
      if (isAssociatedPane(session.id)) scheduleOverviewRefresh();
    });
    const unsubscribePanelCreated = events.onPanelCreated(panel => {
      if (isAssociatedPanel(panel.id, panel.sessionId)) scheduleOverviewRefresh();
    });
    const unsubscribePanelUpdated = events.onPanelUpdated(panel => {
      if (isAssociatedPanel(panel.id, panel.sessionId)) scheduleOverviewRefresh();
    });
    const unsubscribePanelDeleted = events.onPanelDeleted(({ panelId, sessionId }) => {
      if (isAssociatedPanel(panelId, sessionId)) scheduleOverviewRefresh();
    });
    const unsubscribeGitStatusUpdated = events.onGitStatusUpdated(({ sessionId }) => {
      if (isAssociatedPane(sessionId)) scheduleOverviewRefresh();
    });
    const unsubscribeGitStatusUpdatedBatch = events.onGitStatusUpdatedBatch?.(updates => {
      if (updates.some(({ sessionId }) => isAssociatedPane(sessionId))) scheduleOverviewRefresh();
    });

    return () => {
      unsubscribeSessionUpdated();
      unsubscribeSessionDeleted();
      unsubscribePanelCreated();
      unsubscribePanelUpdated();
      unsubscribePanelDeleted();
      unsubscribeGitStatusUpdated();
      unsubscribeGitStatusUpdatedBatch?.();
    };
  }, [scheduleOverviewRefresh, view.session.id]);

  useEffect(() => {
    const handleRefresh = (event: Event) => {
      const sessionId = event instanceof CustomEvent ? event.detail?.sessionId : undefined;
      if (sessionId && sessionId !== view.session.id) return;
      scheduleOverviewRefresh();
    };
    window.addEventListener('orchestration-sessions-changed', handleRefresh);
    window.addEventListener('orchestration-sessions-overview-updated', handleRefresh);
    return () => {
      window.removeEventListener('orchestration-sessions-changed', handleRefresh);
      window.removeEventListener('orchestration-sessions-overview-updated', handleRefresh);
    };
  }, [scheduleOverviewRefresh, view.session.id]);

  const saveOverview = useCallback(async (input: OrchestrationSessionUpdateInput) => {
    const record = await onOverviewUpdate(input);
    setStatusAnnouncement(`${record.name} overview saved`);
    return record;
  }, [onOverviewUpdate]);

  const sessionControls = (
    <Tooltip content="Session settings" side="bottom">
      <button type="button" aria-label="Session settings" onClick={() => setShowSettings(true)}
        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary">
        <Settings className="h-4 w-4" aria-hidden="true" />
      </button>
    </Tooltip>
  );

  return (
    <div className="pane-chat-shell flex-1 flex min-h-0 flex-col overflow-hidden bg-bg-primary">
      <LiveRegion>{statusAnnouncement}</LiveRegion>
      <SessionTileHeader name={view.session.name} chrome={chrome} error={error} />
      {showSettings && <SessionSettingsDialog record={view.session} onClose={() => setShowSettings(false)} onSave={saveOverview} />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SessionProvider session={view.internalSession}>
          <SessionWorkspacePanels agentPanel={view.panel} agentPanelIds={Object.values(view.session.panelIds)}
            toolbarActions={sessionControls}
            chromeInline={chrome.tiled}
            focusWithin={chrome.isFocused}
            overviewContent={<SessionOverviewPanel
            record={view.session}
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
            changesContent={<SessionChangesPanel overview={overview} error={overviewError} onRetry={onRetry} />} />
        </SessionProvider>
      </div>
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

interface SessionOverviewPanelProps {
  record: OrchestrationSessionRecord;
  overview: OrchestrationSessionOverview | null;
  error: string | null;
  onRefresh: () => Promise<void>;
  onUpdate: (input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
  onRetry: () => void;
}

function SessionOverviewPanel({ record, overview, error, onRefresh, onUpdate, onRetry }: SessionOverviewPanelProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(record.name);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) return;
    setName(record.name);
  }, [editing, record]);

  const save = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await onUpdate({
        name,
      });
      setEditing(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Failed to save Session overview');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto bg-surface-primary">
      <div className="flex items-center justify-between gap-2 border-b border-border-primary px-3 py-2">
        <div>
          <h2 className="truncate text-sm font-semibold text-text-primary">{record.name}</h2>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Refresh Session overview" title="Refresh" onClick={() => void onRefresh()} className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive"><RefreshCw className="h-3.5 w-3.5" /></button>
          <button type="button" aria-label={editing ? 'Cancel renaming Session' : 'Rename Session'} title={editing ? 'Cancel renaming' : 'Rename Session'} onClick={() => setEditing(value => !value)} className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive">{editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}</button>
        </div>
      </div>
      <div className="space-y-3 p-3 text-xs">
        {editing ? (
          <>
            <Input label="Name" value={name} onChange={event => setName(event.target.value)} fullWidth />
            {saveError && <p role="alert" className="text-status-error">{saveError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="button" size="sm" loading={isSaving} loadingText="Saving…" onClick={() => void save()}>Save name</Button>
            </div>
          </>
        ) : null}

        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Associated Panes</h3>
          {!overview && !error && <p className="text-text-muted">Loading live state…</p>}
          {error && <div className="space-y-1"><p role="alert" className="text-status-error">{error}</p><button type="button" className="underline text-text-secondary" onClick={onRetry}>Retry</button></div>}
          {overview?.panes.length === 0 && <p className="text-text-muted">This Session has no associated Panes.</p>}
          {overview?.panes.map(pane => <PaneOverviewCard key={pane.paneId} pane={pane} />)}
        </div>

        <div className="border-t border-border-primary pt-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Activity</h3>
          <div className="select-text space-y-2">
            {(overview?.activity ?? record.activity).slice(0, 12).map(activity => (
              <div key={activity.id} className="border-l-2 border-border-primary pl-2">
                <p className="text-text-secondary">{activity.message}</p>
                <p className="mt-0.5 text-[10px] text-text-muted">{formatActivityTime(activity.at)} · {activity.source}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionChangesPanel({ overview, error, onRetry }: {
  overview: OrchestrationSessionOverview | null;
  error: string | null;
  onRetry: () => void;
}) {
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const panes = overview?.panes ?? [];

  return (
    <div className="space-y-2 p-3 text-[12px] text-text-secondary">
      {error && <div role="alert" className="space-y-1"><p className="text-status-error">{error}</p><button type="button" className="underline" onClick={onRetry}>Retry</button></div>}
      {!overview && !error && <p className="text-text-muted">Loading linked worktrees…</p>}
      {overview && panes.length === 0 && <p className="text-text-muted">No linked worktrees.</p>}
      {panes.map(pane => (
        <div key={pane.paneId} className="rounded-md bg-surface-secondary px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-medium text-text-primary">{pane.name}</span>
            {!pane.missing && <button type="button" className="shrink-0 text-interactive hover:underline"
              onClick={() => { setActiveSession(pane.paneId); navigateToSessions(); }}>Open Pane</button>}
          </div>
          <p className="mt-1 text-[11px] text-text-tertiary">
            {pane.missing ? 'Worktree unavailable' : pane.git?.hasUncommittedChanges || pane.git?.hasUntrackedFiles ? 'Uncommitted changes' : 'No uncommitted changes'}
            {pane.branch ? ` · ${pane.branch}` : ''}
          </p>
          {pane.git && (pane.git.ahead || pane.git.behind) ? (
            <p className="mt-1 text-[11px] text-text-tertiary">
              {pane.git.ahead ? `${pane.git.ahead} ahead` : ''}
              {pane.git.ahead && pane.git.behind ? ' · ' : ''}
              {pane.git.behind ? `${pane.git.behind} behind` : ''}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PaneOverviewCard({ pane }: { pane: OrchestrationSessionOverview['panes'][number] }) {
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const openPane = () => {
    if (pane.missing) return;
    setActiveSession(pane.paneId);
    navigateToSessions();
  };
  return (
    <div className="mt-2 rounded border border-border-primary bg-surface-secondary p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><p className="truncate font-medium text-text-primary">{pane.name}</p><p className="truncate text-[10px] text-text-muted">{pane.branch || 'Branch unknown'}{pane.archived ? ' · archived' : pane.missing ? ' · missing' : ''}</p></div>
        {!pane.missing && <button type="button" onClick={openPane} className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-interactive hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive">Open Pane</button>}
      </div>
      {pane.panels.map(panel => {
        const stateLabel = panel.missing
          ? 'Missing'
          : panel.state === 'unknown'
            ? null
            : `${panel.state.charAt(0).toUpperCase()}${panel.state.slice(1)}`;
        return <div key={panel.panelId} className="mt-1 flex items-center justify-between gap-2 text-[10px]"><span className="min-w-0 truncate text-text-secondary">{panel.title}</span>{stateLabel && <span className={cn('flex-shrink-0', panel.state === 'blocked' ? 'text-status-error' : panel.state === 'working' ? 'text-status-warning' : 'text-text-muted')}>{stateLabel}</span>}</div>;
      })}
      {pane.git && <p className="mt-1 text-[10px] text-text-muted">{pane.git.hasUncommittedChanges ? 'Uncommitted changes' : 'Clean working tree'}{pane.git.prNumber ? ` · PR #${pane.git.prNumber}` : ''}</p>}
    </div>
  );
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
