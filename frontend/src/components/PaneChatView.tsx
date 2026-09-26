import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, RefreshCw, Settings, Terminal, X } from 'lucide-react';
import { API } from '../utils/api';
import type { Session } from '../types/session';
import type { PaneChatAgent, PaneChatState } from '../../../shared/types/paneChat';
import type {
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import { SessionProvider } from '../contexts/SessionContext';
import { PanelContainer } from './panels/PanelContainer';
import { SessionWorkspacePanels } from './SessionWorkspacePanels';
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
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';

const PANE_CHAT_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
} satisfies Record<PaneChatAgent, string>;

function responseError(response: { success: boolean; error?: string }, fallback: string): Error | null {
  return response.success ? null : new Error(response.error || fallback);
}

export function PaneChatView() {
  const [legacyState, setLegacyState] = useState<PaneChatState<Session> | null>(null);
  const [namedView, setNamedView] = useState<OrchestrationSessionView<Session> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const requestGeneration = useRef(0);
  const agentReloadKey = useRef<string | null>(null);
  const lastSelectedSessionId = useRef<string | undefined>(undefined);
  const pendingSessionId = useRef<string | undefined>(undefined);

  const availability = useOrchestrationSessionStore(state => state.availability);
  const selectedSessionId = useOrchestrationSessionStore(state => state.selectedSessionId);
  const selectedSessionRecord = useOrchestrationSessionStore(state => state.sessions.find(
    session => session.id === state.selectedSessionId && !isArchivedOrchestrationSession(session),
  ));
  const hasActiveSessions = useOrchestrationSessionStore(state => state.sessions.some(
    session => !isArchivedOrchestrationSession(session),
  ));
  const loadSessions = useOrchestrationSessionStore(state => state.load);
  const updateSession = useOrchestrationSessionStore(state => state.update);
  const selectSession = useOrchestrationSessionStore(state => state.select);

  const loadLegacyPaneChat = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await API.paneChat.getOrCreate();
      const responseFailure = responseError(response, 'Failed to open Pane Chat');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to open Pane Chat');
      setLegacyState(response.data);
      setNamedView(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to open Pane Chat');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadNamedSession = useCallback(async (sessionId?: string) => {
    const generation = ++requestGeneration.current;
    setIsLoading(true);
    setError(null);
    try {
      await loadSessions();
      if (generation !== requestGeneration.current) return;
      const current = useOrchestrationSessionStore.getState();
      if (current.availability === 'error') throw new Error(current.error || 'Sessions could not be loaded');
      if (sessionId && current.selectedSessionId && sessionId !== current.selectedSessionId) return;
      const requestedSession = sessionId
        ? current.sessions.find(session => session.id === sessionId)
        : undefined;
      if (sessionId && (!requestedSession || isArchivedOrchestrationSession(requestedSession))) {
        throw new Error('This Session is archived. Restore it from Archived Sessions to reopen it.');
      }
      const targetId = sessionId
        ?? current.selectedSessionId
        ?? current.sessions.find(session => !isArchivedOrchestrationSession(session))?.id;
      if (!targetId) {
        setNamedView(null);
        setLegacyState(null);
        setError(null);
        return;
      }
      pendingSessionId.current = targetId;
      if (targetId !== current.selectedSessionId) {
        await selectSession({ sessionId: targetId });
        if (generation !== requestGeneration.current) return;
      }
      const response = await API.orchestrationSessions.get({ sessionId: targetId });
      const stateAfterLoad = useOrchestrationSessionStore.getState();
      const selectedAfterLoad = stateAfterLoad.selectedSessionId;
      const activeRecordAfterLoad = stateAfterLoad.sessions.find(session => session.id === targetId);
      if (
        generation !== requestGeneration.current
        || selectedAfterLoad !== targetId
        || !activeRecordAfterLoad
        || isArchivedOrchestrationSession(activeRecordAfterLoad)
      ) return;
      const responseFailure = responseError(response, 'Failed to open Session');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to open Session');
      pendingSessionId.current = undefined;
      setNamedView(response.data);
      setLegacyState(null);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      pendingSessionId.current = undefined;
      setError(cause instanceof Error ? cause.message : 'Failed to open Session');
      setNamedView(null);
      setLegacyState(null);
    } finally {
      if (generation === requestGeneration.current) setIsLoading(false);
    }
  }, [loadSessions, selectSession]);

  useEffect(() => {
    const hasNamedSessionApi = Boolean(window.electronAPI?.orchestrationSessions);
    if (!hasNamedSessionApi) {
      void loadLegacyPaneChat();
      return;
    }
    void loadNamedSession();
  }, [loadLegacyPaneChat, loadNamedSession]);

  useEffect(() => {
    if (!window.electronAPI?.orchestrationSessions || !selectedSessionId) return;
    if (namedView?.session.id === selectedSessionId) return;
    void loadNamedSession(selectedSessionId);
  }, [loadNamedSession, namedView?.session.id, selectedSessionId]);

  useEffect(() => {
    if (!window.electronAPI?.orchestrationSessions) return;
    if (selectedSessionId) {
      lastSelectedSessionId.current = selectedSessionId;
      return;
    }
    if (!lastSelectedSessionId.current && !pendingSessionId.current && !namedView) return;
    requestGeneration.current += 1;
    lastSelectedSessionId.current = undefined;
    pendingSessionId.current = undefined;
    if (!namedView) {
      setIsLoading(false);
      return;
    }
    setNamedView(null);
    setLegacyState(null);
    setError(null);
    setIsLoading(false);
  }, [namedView, selectedSessionId]);

  useEffect(() => {
    if (!namedView || !selectedSessionRecord || namedView.session.id !== selectedSessionRecord.id) return;
    if (namedView.agent !== selectedSessionRecord.agent) {
      const reloadKey = `${selectedSessionRecord.id}:${selectedSessionRecord.agent}`;
      if (agentReloadKey.current === reloadKey) return;
      agentReloadKey.current = reloadKey;
      void loadNamedSession(namedView.session.id).finally(() => {
        if (agentReloadKey.current === reloadKey) agentReloadKey.current = null;
      });
      return;
    }
    agentReloadKey.current = null;
    if (namedView.session.revision === selectedSessionRecord.revision) return;
    setNamedView(current => current ? { ...current, session: selectedSessionRecord } : current);
  }, [loadNamedSession, namedView, selectedSessionRecord]);

  const handleNamedOverviewUpdate = useCallback(async (input: OrchestrationSessionUpdateInput): Promise<OrchestrationSessionRecord> => {
    if (!namedView) throw new Error('No Session selected');
    const sessionId = namedView.session.id;
    const generation = requestGeneration.current;
    const record = await updateSession({ sessionId }, {
      ...input,
      expectedRevision: namedView.session.revision,
    });
    if (generation !== requestGeneration.current || useOrchestrationSessionStore.getState().selectedSessionId !== sessionId) {
      throw new Error('Session selection changed while saving the overview');
    }
    setNamedView(current => current ? { ...current, session: record } : current);
    setStatusAnnouncement(`${record.name} overview saved`);
    return record;
  }, [namedView, updateSession]);

  if (isLoading && !legacyState && !namedView) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary text-text-secondary">
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
          <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" />
          <span>{availability === 'unavailable' ? 'Opening Pane Chat…' : 'Opening Sessions…'}</span>
        </div>
      </div>
    );
  }

  if (legacyState) {
    return (
      <LegacyPaneChatWorkspace
        state={legacyState}
        error={error}
        statusAnnouncement={statusAnnouncement}
        onRetry={loadLegacyPaneChat}
      />
    );
  }

  if (!namedView) {
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
                onClick={() => void loadNamedSession()}
              >
                Retry
              </Button>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-text-primary">Choose a Session</h2>
              <p className="mt-2 text-sm text-text-secondary">
                {hasActiveSessions
                  ? 'Choose a Session from the sidebar to open its chat.'
                  : 'Create a new Session or restore one from Archived to start a chat.'}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <NamedSessionWorkspace
      key={namedView.session.id}
      view={namedView}
      error={error}
      statusAnnouncement={statusAnnouncement}
      onOverviewUpdate={handleNamedOverviewUpdate}
      onRetry={() => void loadNamedSession(namedView.session.id)}
    />
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
  statusAnnouncement: string;
  onRetry: () => void;
}

function LegacyPaneChatWorkspace({ state, error, statusAnnouncement, onRetry }: LegacyPaneChatWorkspaceProps) {
  return (
    <div className="pane-chat-shell flex-1 flex flex-col overflow-hidden bg-bg-primary">
      <LiveRegion>{statusAnnouncement}</LiveRegion>
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
  statusAnnouncement: string;
  onOverviewUpdate: (input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
  onRetry: () => void;
}

function NamedSessionWorkspace({ view, error, statusAnnouncement, onOverviewUpdate, onRetry }: NamedSessionWorkspaceProps) {
  const [overview, setOverview] = useState<OrchestrationSessionOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const overviewRequestId = useRef(0);
  const overviewRefreshTimer = useRef<number | null>(null);
  const isMounted = useRef(false);

  const refreshOverview = useCallback(async () => {
    const sessionId = view.session.id;
    const requestId = ++overviewRequestId.current;
    const isCurrentRequest = () => isMounted.current
      && requestId === overviewRequestId.current
      && useOrchestrationSessionStore.getState().selectedSessionId === sessionId;

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
      if (state.selectedSessionId !== view.session.id) return [];
      return state.sessions.find(session => session.id === state.selectedSessionId)?.associations ?? [];
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
      <div className="flex min-h-11 flex-shrink-0 items-center justify-between gap-3 border-b border-border-primary px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 flex-shrink-0 text-text-tertiary" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-text-primary">{view.session.name}</h1>
          </div>
          {error && <span role="alert" className="truncate text-xs text-status-error">{error}</span>}
        </div>
      </div>
      {showSettings && <SessionSettingsDialog record={view.session} onClose={() => setShowSettings(false)} onSave={onOverviewUpdate} />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SessionProvider session={view.internalSession}>
          <SessionWorkspacePanels agentPanel={view.panel} agentPanelIds={Object.values(view.session.panelIds)}
            toolbarActions={sessionControls}
            overviewContent={<SessionOverviewPanel
            record={view.session}
            overview={overview}
            error={overviewError}
            onRefresh={refreshOverview}
            onUpdate={async input => {
              const record = await onOverviewUpdate(input);
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
          <div className="space-y-2">
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
