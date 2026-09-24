import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Archive, ChevronDown, ChevronRight, Pin, PinOff, Plus, Pencil, RefreshCw, Terminal } from 'lucide-react';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useConfigStore } from '../stores/configStore';
import {
  isArchivedOrchestrationSession,
  useOrchestrationSessionStore,
  type OrchestrationSessionAvailability,
} from '../stores/orchestrationSessionStore';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { OrchestrationSessionUpdateInput } from '../../../shared/types/orchestrationSession';
import { DEFAULT_PANE_CHAT_AGENT, type PaneChatAgent } from '../../../shared/types/paneChat';
import { LEGACY_ORCHESTRATION_SESSION_ID } from '../../../shared/types/orchestrationSession';
import { Modal, ModalBody, ModalFooter, ModalHeader } from './ui/Modal';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Tooltip } from './ui/Tooltip';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';
import { visibleAgentPresets } from '../utils/agentPresets';
import { cn } from '../utils/cn';
import { SessionLaunchFields } from './SessionLaunchFields';
import { DEFAULT_SESSION_PROFILE } from '../../../shared/types/sessionProfile';
import type { AppConfig } from '../types/config';

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
}

type SessionRowPlacement = 'pinned' | 'sessions';

function statusLabel(session: OrchestrationSessionRecord): string {
  if (session.blockers.length > 0) return 'Blocked';
  if (session.report) return 'Report available';
  return 'No report yet';
}

function availabilityIsVisible(availability: OrchestrationSessionAvailability): boolean {
  return availability === 'ready' || availability === 'loading' || availability === 'error';
}

const SESSION_AGENT_OPTIONS: ReadonlyArray<{ id: PaneChatAgent; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

function availableSessionAgents(): ReadonlyArray<{ id: PaneChatAgent; label: string }> {
  const visible = new Set(visibleAgentPresets().map(preset => preset.id));
  return SESSION_AGENT_OPTIONS.filter(option => visible.has(option.id));
}

function supportedSessionAgent(preferred?: PaneChatAgent): PaneChatAgent {
  const options = availableSessionAgents();
  if (preferred && options.some(option => option.id === preferred)) return preferred;
  return options[0]?.id ?? DEFAULT_PANE_CHAT_AGENT;
}

function nextSessionName(sessions: readonly OrchestrationSessionRecord[]): string {
  const existingNames = new Set(sessions.map(session => session.name.trim().toLocaleLowerCase()));
  if (!existingNames.has('new chat')) return 'New chat';

  let suffix = 2;
  while (existingNames.has(`new chat ${suffix}`)) suffix += 1;
  return `New chat ${suffix}`;
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
  const load = useOrchestrationSessionStore(state => state.load);
  const refresh = useOrchestrationSessionStore(state => state.refresh);
  const select = useOrchestrationSessionStore(state => state.select);
  const create = useOrchestrationSessionStore(state => state.create);
  const update = useOrchestrationSessionStore(state => state.update);
  const navigateToPaneChat = useNavigationStore(state => state.navigateToPaneChat);
  const activeView = useNavigationStore(state => state.activeView);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const [showCreate, setShowCreate] = useState(false);
  const [sessionExpansionOverrides, setSessionExpansionOverrides] = useState<Map<string, boolean>>(new Map());
  const [sectionExpanded, setSectionExpanded] = useState(true);
  const [localPinnedSectionExpanded, setLocalPinnedSectionExpanded] = useState(true);
  const [sessionMenu, setSessionMenu] = useState<SessionContextMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const isPinnedSectionExpanded = pinnedSectionExpanded ?? localPinnedSectionExpanded;
  const setPinnedSectionExpanded = onPinnedSectionExpandedChange ?? setLocalPinnedSectionExpanded;

  const createSession = useCallback(async (agent: PaneChatAgent, requestedName?: string, launchCommand?: string, profile?: string, customResume?: CustomCommandResume | null) => {
    await load();
    const name = requestedName?.trim() || nextSessionName(useOrchestrationSessionStore.getState().sessions);
    await create({ name, agent, launchCommand, profile, customResume });
    setShowCreate(false);
    setActiveSession(null);
    navigateToPaneChat();
  }, [create, load, navigateToPaneChat, setActiveSession]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleSessionsChanged = (event: Event) => {
      // SAFETY: Pane's orchestration event contract supplies this detail shape.
      const detail = event instanceof CustomEvent
        ? event.detail as { kind?: string; selectionChanged?: boolean }
        : undefined;
      const adoptServerSelection = detail?.kind === 'selected' || detail?.selectionChanged === true;
      void refresh({ adoptServerSelection });
    };
    window.addEventListener('orchestration-sessions-changed', handleSessionsChanged);
    return () => window.removeEventListener('orchestration-sessions-changed', handleSessionsChanged);
  }, [refresh]);

  const openSession = useCallback(async (sessionId: string) => {
    setActionError(null);
    try {
      await select({ sessionId });
      setActiveSession(null);
      navigateToPaneChat();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Failed to open Session');
    }
  }, [navigateToPaneChat, select, setActiveSession]);

  const toggleSessionExpanded = useCallback((sessionId: string, expanded: boolean) => {
    setSessionExpansionOverrides(current => {
      const next = new Map(current);
      next.set(sessionId, !expanded);
      return next;
    });
  }, []);

  const openSessionMenu = useCallback((session: OrchestrationSessionRecord, x: number, y: number) => {
    setSessionMenu({
      sessionId: session.id,
      sessionName: session.name || 'Pane Chat',
      isPinned: session.isPinned === true,
      x,
      y,
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
    const { sessionId } = sessionMenu;
    setSessionMenu(null);
    setActionError(null);
    try {
      await update(
        { sessionId },
        { archived: true } satisfies OrchestrationSessionUpdateInput,
      );
      await refresh({ adoptServerSelection: true });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Failed to archive Session');
    }
  }, [refresh, sessionMenu, update]);

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
    const expanded = sessionExpansionOverrides.get(session.id) ?? paneRows.length > 0;
    const isLegacy = session.id === LEGACY_ORCHESTRATION_SESSION_ID;
    const label = session.name || 'Pane Chat';
    const rowId = isLegacy
      ? placement === 'pinned' ? 'orchestration-pinned-pane-chat' : 'orchestration-pane-chat'
      : `${placement === 'pinned' ? 'orchestration-pinned-session' : 'orchestration-session'}-${session.id}`;
    const panesId = `orchestration-session-panes-${placement}-${session.id}`;

    return (
      <div key={`${placement}-${session.id}`} className="group/orchestration-session">
        <div className={cn(
          'mx-2 flex h-7 w-[calc(100%-1rem)] items-center rounded-md text-[13px] transition-colors',
          activeView === 'pane-chat' && session.id === selectedSessionId ? 'bg-surface-selected text-text-primary' : 'text-text-secondary hover:bg-surface-hover',
        )}>
          <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} children`}
            aria-expanded={expanded} aria-controls={panesId}
            onClick={() => toggleSessionExpanded(session.id, expanded)}
            className="ml-1 flex h-6 w-4 flex-shrink-0 items-center justify-center rounded hover:bg-surface-hover focus:outline-none">
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          <button
            type="button"
            data-testid={rowId}
            aria-label={isLegacy ? label : `Open Session ${session.name}`}
            onClick={() => void openSession(session.id)}
            onContextMenu={event => handleSessionContextMenu(event, session)}
            onKeyDown={event => handleSessionKeyDown(event, session)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded pl-2 pr-2 py-1 text-left focus:outline-none"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">{label}</span>
            {paneRows.length > 0 && <span className="pr-1 text-[10px] tabular-nums text-text-muted">{paneRows.length}</span>}
          </button>
        </div>
        <div id={panesId} className={cn('ml-6', !expanded && 'hidden')}>
          {paneRows.length > 0 ? paneRows : (
            <p className="py-1 pl-2 text-[11px] text-text-tertiary">No child sessions</p>
          )}
        </div>
      </div>
    );
  };

  if (compact && !sessionsVisible) return null;
  if (!compact && !sessionsVisible && !hasPinnedContent) return null;

  if (compact) {
    return (
      <div role="group" aria-label="Sessions" className="flex w-full shrink-0 flex-col items-center gap-0.5">
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
        {activeSessions.map(session => (
          <Tooltip key={session.id} content={`${session.name} · ${statusLabel(session)}`} side="right">
            <button
              type="button"
              data-testid={session.id === LEGACY_ORCHESTRATION_SESSION_ID ? 'compact-pane-chat' : `compact-orchestration-session-${session.id}`}
              data-compact-rail-item
              aria-label={session.id === LEGACY_ORCHESTRATION_SESSION_ID ? 'Pane Chat' : `Open Session ${session.name}`}
              title={session.name}
              onClick={() => void openSession(session.id)}
              onContextMenu={event => handleSessionContextMenu(event, session)}
              onKeyDown={event => handleSessionKeyDown(event, session)}
              className={cn(
                'flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-interactive',
                session.id === selectedSessionId ? 'bg-surface-selected text-text-primary' : 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary',
              )}
            >
              {session.name.trim().charAt(0).toUpperCase() || <Terminal className="h-4 w-4" />}
            </button>
          </Tooltip>
        ))}
        {error && (
          <Tooltip content={error} side="right">
            <button
              type="button"
              data-testid="compact-sessions-error"
              data-compact-rail-item
              aria-label="Sessions unavailable"
              onClick={() => void load()}
              className="flex h-9 w-9 items-center justify-center rounded text-status-error hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
        {actionError && (
          <Tooltip content={actionError} side="right">
            <span role="alert" aria-label={actionError} className="flex h-9 w-9 items-center justify-center rounded text-status-error">!</span>
          </Tooltip>
        )}
        <SessionContextMenu
          menu={sessionMenu}
          onClose={() => setSessionMenu(null)}
          onArchive={() => void archiveSession()}
          onPin={() => void pinSession()}
        />
        <CreateOrchestrationSessionDialog isOpen={showCreate} onClose={() => setShowCreate(false)} onCreate={createSession} />
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
      {sessionsVisible && <div className="mt-3" role="group" aria-label="Sessions">
        <div data-testid="sessions-section-header" className="group/section flex items-center justify-between gap-2 pl-4 pr-3 py-1">
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
        {error && (
          <div className="mx-3 mb-1 rounded border border-status-error/40 bg-status-error/10 px-2 py-1.5 text-[11px] text-status-error" role="alert">
            <p>{error}</p>
            <button type="button" className="mt-1 underline" onClick={() => void load()}>Retry</button>
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
  return (<>
    <TerminalPopover
      visible={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={onClose}
    >
      <div role="menu" aria-label={`Session actions for ${menu?.sessionName ?? 'Session'}`}>
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

interface CreateOrchestrationSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (agent: PaneChatAgent, name?: string, launchCommand?: string, profile?: string, customResume?: CustomCommandResume | null) => Promise<void>;
}

function CreateOrchestrationSessionDialog({ isOpen, onClose, onCreate }: CreateOrchestrationSessionDialogProps) {
  const [agent, setAgent] = useState<PaneChatAgent>(DEFAULT_PANE_CHAT_AGENT);
  const [name, setName] = useState('');
  const [launchCommand, setLaunchCommand] = useState('');
  const [customResume, setCustomResume] = useState<CustomCommandResume | null>(null);
  const [profile, setProfile] = useState(DEFAULT_SESSION_PROFILE);
  const userEditedLaunch = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const config = useConfigStore(state => state.config);
  const fetchConfig = useConfigStore(state => state.fetchConfig);
  const updateConfig = useConfigStore(state => state.updateConfig);
  const userSelectedAgent = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    userSelectedAgent.current = false;
    userEditedLaunch.current = false;
    const savedConfig = useConfigStore.getState().config;
    setAgent(supportedSessionAgent(savedConfig?.defaultOrchestratorAgent));
    setName('');
    setLaunchCommand(savedConfig?.defaultSessionCommand ?? '');
    setCustomResume(savedConfig?.defaultSessionResume ?? null);
    setProfile(savedConfig?.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE);
    setError(null);
    if (!savedConfig) {
      void fetchConfig().then(nextConfig => {
        if (!userSelectedAgent.current) setAgent(supportedSessionAgent(nextConfig.defaultOrchestratorAgent));
        if (!userEditedLaunch.current) {
          setLaunchCommand(nextConfig.defaultSessionCommand ?? '');
          setCustomResume(nextConfig.defaultSessionResume ?? null);
          setProfile(nextConfig.defaultSessionProfile ?? DEFAULT_SESSION_PROFILE);
        }
      }).catch(() => undefined);
    }
  }, [fetchConfig, isOpen]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const defaults: Partial<AppConfig> = {};
      if (config?.defaultOrchestratorAgent !== agent) defaults.defaultOrchestratorAgent = agent;
      if ((config?.defaultSessionCommand ?? '') !== launchCommand) defaults.defaultSessionCommand = launchCommand;
      if (JSON.stringify(config?.defaultSessionResume ?? null) !== JSON.stringify(customResume)) defaults.defaultSessionResume = customResume;
      if (Object.keys(defaults).length > 0) await updateConfig(defaults);
      await onCreate(agent, name.trim() || undefined, launchCommand, profile, customResume);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create Session');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" ariaLabel="Create Session">
      <form onSubmit={submit} className="flex min-h-0 flex-col">
        <ModalHeader title="Create Session" />
        <ModalBody className="min-h-0 space-y-4">
          <Input label="Name your chat (optional)" value={name} onChange={event => setName(event.target.value)} placeholder="New chat" autoFocus fullWidth />
          <fieldset className="space-y-2">
            <legend className="text-label font-medium text-text-primary">Choose an agent</legend>
            <div className="grid gap-2" role="radiogroup" aria-label="Session agent">
              {availableSessionAgents().map(option => {
                const selected = agent === option.id;
                const isDefault = config?.defaultOrchestratorAgent === option.id;
                return (
                  <label
                    key={option.id}
                    data-testid={`create-session-agent-${option.id}`}
                    htmlFor={`create-session-agent-input-${option.id}`}
                    className={cn(
                      'flex cursor-pointer items-center justify-between rounded border px-3 py-2 text-left text-sm transition-colors focus-within:outline-none focus-within:ring-2 focus-within:ring-interactive',
                      selected ? 'border-interactive bg-surface-selected text-text-primary' : 'border-border-primary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                    )}
                  >
                    <input
                      id={`create-session-agent-input-${option.id}`}
                      type="radio"
                      name="orchestration-session-agent"
                      value={option.id}
                      aria-label={option.label}
                      checked={selected}
                      onChange={() => {
                        userSelectedAgent.current = true;
                        setAgent(option.id);
                      }}
                      className="sr-only"
                    />
                    <span>{option.label}</span>
                    {isDefault && <span className="text-[11px] text-text-muted">Default</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm font-medium text-text-secondary">Launch command and behavior</summary>
            <SessionLaunchFields
              resume={customResume}
              onResumeChange={value => { userEditedLaunch.current = true; setCustomResume(value); }}
              command={launchCommand}
              profile={profile}
              customCommands={config?.customCommands}
              onCommandChange={value => { userEditedLaunch.current = true; setLaunchCommand(value); }}
              onProfileChange={value => { userEditedLaunch.current = true; setProfile(value); }}
            />
          </details>
          {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
        </ModalBody>
        <ModalFooter className="shrink-0">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={isSubmitting} loadingText="Creating…">Create Session</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
