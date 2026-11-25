import { useReadOnlyHost } from '../stores/readOnlyHostStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { List, PanelRight, Pencil, RefreshCw, X } from 'lucide-react';
import { API } from '../utils/api';
import type {
  OrchestrationActivityKind,
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
  OrchestrationSessionUpdateInput,
} from '../../../shared/types/orchestrationSession';
import type { ToolPanelType } from '../../../shared/types/panels';
import { Button } from './ui/Button';
import { Bone, LoadingStatus, Skeleton, SkeletonSwap } from './ui/Skeleton';
import { Input } from './ui/Input';
import { SessionStatusPage } from './SessionStatusPage';
import { openBesideChat, useSessionStatusPage } from '../hooks/useSessionStatusPage';
import { cn } from '../utils/cn';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { getPanelIcon } from './panels/panelIcon';
import { OPEN_INSPECTOR_EVENT, type InspectorRequest, type InspectorTab } from './InspectorTabs';
import { openPaneTarget } from './terminal/openPaneLink';

// A Session's Overview and Changes tabs and the loader they share, moved out of PaneChatView so a
// to-do's split shows the same Overview (round 8, T-4).

function responseError(response: { success: boolean; error?: string }, fallback: string): Error | null {
  return response.success ? null : new Error(response.error || fallback);
}

export interface SessionOverviewState {
  overview: OrchestrationSessionOverview | null;
  error: string | null;
  /** Loads it again; `required` rethrows a failure, which a remote workspace restore retries on. */
  refresh: (required?: boolean) => Promise<void>;
}

/**
 * A Session's overview, loaded and kept fresh: when its Panes, tabs or git status change, and on
 * orchestration-sessions-changed or -overview-updated for it, batched 50 ms apart.
 */
export function useSessionOverview(sessionId: string): SessionOverviewState {
  const [overview, setOverview] = useState<OrchestrationSessionOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const overviewRequestId = useRef(0);
  const overviewRefreshTimer = useRef<number | null>(null);
  const isMounted = useRef(false);

  const refreshOverview = useCallback(async (required = false) => {
    const requestId = ++overviewRequestId.current;
    const isCurrentRequest = () => isMounted.current && requestId === overviewRequestId.current;

    try {
      const response = await API.orchestrationSessions.overview({ sessionId });
      const responseFailure = responseError(response, 'Failed to refresh Session overview');
      if (responseFailure || !response.data) throw responseFailure ?? new Error('Failed to refresh Session overview');
      if (!isCurrentRequest()) {
        if (required && isMounted.current) throw new Error('Session overview changed during restoration; retrying the current view.');
        return;
      }
      setOverview(response.data);
      setOverviewError(null);
    } catch (cause) {
      if (!isCurrentRequest()) { if (required && isMounted.current) throw cause; return; }
      setOverviewError(cause instanceof Error ? cause.message : 'Failed to refresh Session overview');
      if (required) throw cause;
    }
  }, [sessionId]);

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
      return state.sessions.find(session => session.id === sessionId)?.associations ?? [];
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
    const unsubscribePanelDeleted = events.onPanelDeleted(({ panelId, sessionId: paneId }) => {
      if (isAssociatedPanel(panelId, paneId)) scheduleOverviewRefresh();
    });
    const unsubscribeGitStatusUpdated = events.onGitStatusUpdated(({ sessionId: paneId }) => {
      if (isAssociatedPane(paneId)) scheduleOverviewRefresh();
    });
    const unsubscribeGitStatusUpdatedBatch = events.onGitStatusUpdatedBatch?.(updates => {
      if (updates.some(({ sessionId: paneId }) => isAssociatedPane(paneId))) scheduleOverviewRefresh();
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
  }, [scheduleOverviewRefresh, sessionId]);

  useEffect(() => {
    const handleRefresh = (event: Event) => {
      const changed = event instanceof CustomEvent ? event.detail?.sessionId : undefined;
      if (changed && changed !== sessionId) return;
      scheduleOverviewRefresh();
    };
    window.addEventListener('orchestration-sessions-changed', handleRefresh);
    window.addEventListener('orchestration-sessions-overview-updated', handleRefresh);
    return () => {
      window.removeEventListener('orchestration-sessions-changed', handleRefresh);
      window.removeEventListener('orchestration-sessions-overview-updated', handleRefresh);
    };
  }, [scheduleOverviewRefresh, sessionId]);

  return { overview, error: overviewError, refresh: refreshOverview };
}

/**
 * A Session's Overview on its own, outside the Session: a to-do's split shows it (round 8, T-4).
 * It is the Session's Overview tab, read from this machine's Sessions; renaming saves there too.
 */
export function SessionOverviewOf({ sessionId }: { sessionId: string }) {
  const record = useOrchestrationSessionStore(state => state.sessions.find(session => session.id === sessionId));
  const { overview, error, refresh } = useSessionOverview(sessionId);
  const update = useCallback(async (input: OrchestrationSessionUpdateInput) => {
    const store = useOrchestrationSessionStore.getState();
    const current = store.sessions.find(session => session.id === sessionId);
    if (!current) throw new Error('This Session is no longer on this machine, so its name was not saved. Reopen the to-do to see its Session again.');
    const next = await store.update({ sessionId }, { ...input, expectedRevision: current.revision });
    await refresh();
    return next;
  }, [refresh, sessionId]);
  if (!record) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-overview-of">
      <SessionOverviewPanel record={record} folderSessionId={record.internalSessionId} overview={overview} error={error}
        onRefresh={refresh} onUpdate={update} onRetry={() => void refresh()} />
    </div>
  );
}

// Agent state flips are shown by the status dot; the Activity list keeps Session events.
const AGENT_STATE_ACTIVITY_KINDS = new Set<OrchestrationActivityKind>(['working', 'blocked', 'idle', 'unknown']);

const OVERVIEW_HEADING = 'mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary';

export interface SessionOverviewPanelProps {
  record: OrchestrationSessionRecord;
  /** The Pane session whose worktree is the Session folder, where the status page lives. */
  folderSessionId: string;
  overview: OrchestrationSessionOverview | null;
  error: string | null;
  onRefresh: () => Promise<void>;
  onUpdate: (input: OrchestrationSessionUpdateInput) => Promise<OrchestrationSessionRecord>;
  onRetry: () => void;
}

const OVERVIEW_ACTION = 'rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive';

/**
 * The Overview tab, first in the Session's right split. With a status page in the Session folder it shows the page under this
 * header, and Show Session details brings back the record below; without one it is the record alone.
 */
export function SessionOverviewPanel({ record, folderSessionId, overview, error, onRefresh, onUpdate, onRetry }: SessionOverviewPanelProps) {
  const statusPage = useSessionStatusPage(folderSessionId, overview);
  const [showDetails, setShowDetails] = useState(false);
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

  const renameForm = <>
    <Input label="Name" value={name} onChange={event => setName(event.target.value)} fullWidth />
    {saveError && <p role="alert" className="text-status-error">{saveError}</p>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
      <Button type="button" size="sm" loading={isSaving} loadingText="Saving…" onClick={() => void save()}>Save name</Button>
    </div>
  </>;

  return (
    <div className={cn('flex h-full min-w-0 flex-col bg-surface-primary', !statusPage && 'overflow-y-auto')}>
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border-primary px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-text-primary">{record.name}</h2>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button type="button" aria-label="Refresh Session overview" title="Refresh" onClick={() => void onRefresh()} className={OVERVIEW_ACTION}><RefreshCw className="h-3.5 w-3.5" /></button>
          <button type="button" aria-label={editing ? 'Cancel renaming Session' : 'Rename Session'} title={editing ? 'Cancel renaming' : 'Rename Session'} onClick={() => setEditing(value => !value)} className={cn('needs-full-access', OVERVIEW_ACTION)}>{editing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}</button>
          {statusPage && <>
            <button type="button" aria-label="Open as a browser tab" title="Open as a browser tab" className={OVERVIEW_ACTION}
              onClick={() => void openBesideChat(folderSessionId, statusPage).catch((cause: unknown) => console.error('[SessionOverview] Did not open the status page beside chat:', cause))}>
              <PanelRight className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label={showDetails ? 'Show status page' : 'Show Session details'} title={showDetails ? 'Show status page' : 'Show Session details'} aria-pressed={showDetails}
              onClick={() => setShowDetails(value => !value)} className={cn(OVERVIEW_ACTION, showDetails && 'bg-surface-hover text-text-primary')}>
              <List className="h-3.5 w-3.5" />
            </button>
          </>}
        </div>
      </div>
      {statusPage && !showDetails && editing && <div className="flex-shrink-0 space-y-3 border-b border-border-primary p-3 text-xs">{renameForm}</div>}
      {statusPage && !showDetails ? <SessionStatusPage url={statusPage} folderSessionId={folderSessionId} /> : <div className={cn('space-y-3 p-3 text-xs', statusPage && 'min-h-0 flex-1 overflow-y-auto')}>
        {editing ? renameForm : null}

        {overview?.terminalReason && (
          <div className="rounded-md border border-border-primary bg-surface-secondary px-2 py-2" data-testid="session-terminal-reason">
            <h3 className={cn(OVERVIEW_HEADING, 'text-text-primary')}>Runs in a terminal</h3>
            <p className="select-text text-text-secondary">{overview.terminalReason}</p>
          </div>
        )}
        {record.blockers.length > 0 && (
          <div className="rounded-md border border-status-error/30 bg-status-error/10 px-2 py-2">
            <h3 className={cn(OVERVIEW_HEADING, 'text-text-primary')}>Blockers</h3>
            <ul className="select-text list-disc space-y-1 pl-4 text-text-primary">
              {record.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
            </ul>
          </div>
        )}
        {record.goal && (
          <div>
            <h3 className={OVERVIEW_HEADING}>Goal</h3>
            <p className="select-text whitespace-pre-wrap text-text-secondary">{record.goal}</p>
          </div>
        )}
        {record.nextAction && (
          <div>
            <h3 className={OVERVIEW_HEADING}>Next step</h3>
            <p className="select-text whitespace-pre-wrap text-text-secondary">{record.nextAction}</p>
          </div>
        )}
        {record.decisions.length > 0 && (
          <div>
            <h3 className={OVERVIEW_HEADING}>Decisions</h3>
            <ul className="select-text list-disc space-y-1 pl-4 text-text-secondary">
              {record.decisions.map((decision, index) => <li key={index}>{decision}</li>)}
            </ul>
          </div>
        )}

        <div>
          <h3 className={OVERVIEW_HEADING}>Associated Panes</h3>
          {error && <div className="space-y-1"><p role="alert" className="text-status-error">{error}</p><button type="button" className="underline text-text-secondary" onClick={onRetry}>Retry</button></div>}
          {!error && <SkeletonSwap loading={!overview} skeleton={<><LoadingStatus label="Loading the Session's Panes" /><PaneCardsSkeleton /></>}>
            {overview?.panes.length === 0 && <p className="text-text-muted">No Panes in this Session yet.</p>}
            {overview?.panes.map(pane => <PaneOverviewCard key={pane.paneId} pane={pane} />)}
          </SkeletonSwap>}
        </div>

        <div className="border-t border-border-primary pt-3">
          <h3 className={OVERVIEW_HEADING}>Activity</h3>
          <div className="select-text space-y-2">
            {(overview?.activity ?? record.activity).filter(activity => !AGENT_STATE_ACTIVITY_KINDS.has(activity.kind)).slice(0, 12).map(activity => (
              <div key={activity.id} className="border-l-2 border-border-primary pl-2">
                <p className="text-text-secondary">{activity.message}</p>
                <p className="mt-0.5 text-[10px] text-text-muted">{formatActivityTime(activity.at)} · {activity.source}</p>
              </div>
            ))}
          </div>
        </div>
      </div>}
    </div>
  );
}

export function SessionChangesPanel({ overview, error, onRetry }: {
  overview: OrchestrationSessionOverview | null;
  error: string | null;
  onRetry: () => void;
}) {
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const panes = overview?.panes ?? [];

  return (
    <div className="flex flex-col gap-2 p-3 text-[12px] text-text-secondary">
      {error && <div role="alert" className="space-y-1"><p className="text-status-error">{error}</p><button type="button" className="underline" onClick={onRetry}>Retry</button></div>}
      {!error && <SkeletonSwap loading={!overview} skeleton={<><LoadingStatus label="Loading the Session's Panes" /><PaneChangeRowsSkeleton /></>}>
      {overview && panes.length === 0 && <p className="text-text-muted">No Panes in this Session yet.</p>}
      {panes.map(pane => (
        <div key={pane.paneId} className="rounded-md bg-surface-secondary px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-medium text-text-primary">{pane.name}</span>
            {!pane.missing && <button type="button" className="shrink-0 text-interactive hover:underline"
              onClick={() => { setActiveSession(pane.paneId); navigateToSessions(); }}>Open Pane</button>}
          </div>
          <p className="mt-1 text-[11px] text-text-tertiary">
            {pane.missing ? 'Pane unavailable' : pane.git?.hasUncommittedChanges || pane.git?.hasUntrackedFiles ? 'Uncommitted changes' : 'No uncommitted changes'}
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
      </SkeletonSwap>}
    </div>
  );
}

/** Two of PaneOverviewCard's cards: the Pane's name and its branch line. */
function PaneCardsSkeleton() {
  return (
    <Skeleton>
      {[40, 55].map(width => (
        <div key={width} className="mt-2 rounded border border-border-primary bg-surface-secondary p-2">
          <div className="flex h-5 items-center"><Bone className="h-3" style={{ width: `${width}%` }} /></div>
          <div className="flex h-[15px] items-center"><Bone className="h-2" style={{ width: `${width - 15}%` }} /></div>
        </div>
      ))}
    </Skeleton>
  );
}

/** Two of SessionChangesPanel's Pane rows: name and Open Pane, then the changes line. */
function PaneChangeRowsSkeleton() {
  return (
    <Skeleton className="space-y-2">
      {[45, 60].map(width => (
        <div key={width} className="rounded-md bg-surface-secondary px-2 py-2">
          <div className="flex h-[18px] items-center justify-between gap-2"><Bone className="h-3" style={{ width: `${width}%` }} /><Bone className="h-3 w-14" /></div>
          <div className="mt-1 flex h-4 items-center"><Bone className="h-2.5 w-2/3" /></div>
        </div>
      ))}
    </Skeleton>
  );
}

/** Explorer and Diff live in a Pane's inspector, under these tabs. */
const INSPECTOR_TABS = {
  explorer: { tab: 'files', label: 'Files' },
  diff: { tab: 'changes', label: 'Changes' },
} satisfies Record<string, { tab: InspectorTab; label: string }>;
/** What a tab is, shown when it has no live agent state. A terminal's title already says it; Files and Changes are their own label. */
const PANEL_TYPE_LABELS = {
  terminal: null, chat: null, explorer: null, diff: null,
  browser: 'Page', editor: 'File', logs: 'Logs', notes: 'Notes', dashboard: 'Dashboard', 'setup-tasks': 'Setup tasks', device: 'Device',
} satisfies Record<ToolPanelType, string | null>;

/** What a remote member's row adds after its machine's name. */
const REMOTE_STATE_NOTES = {
  online: '',
  unreachable: ' · unreachable',
  'older-pane': ' · needs a Pane update',
} satisfies Record<NonNullable<OrchestrationSessionOverview['panes'][number]['machine']>['state'], string>;

function PaneOverviewCard({ pane }: { pane: OrchestrationSessionOverview['panes'][number] }) {
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  // A Pane on another saved machine is read-only here; it opens from All machines.
  const remote = pane.machine;
  const readOnly = pane.missing || remote !== undefined;
  // A read-only viewer gets no state for members on the owner's other computers.
  const hostReadOnly = useReadOnlyHost();
  const openPane = () => {
    if (readOnly) return;
    setActiveSession(pane.paneId);
    navigateToSessions();
  };
  return (
    <div className="mt-2 rounded border border-border-primary bg-surface-secondary p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><p className="truncate font-medium text-text-primary">{pane.name}</p><p className="truncate text-[10px] text-text-muted">{remote ? `On ${remote.label}${pane.branch ? ` · ${pane.branch}` : ''}` : pane.branch || 'Branch unknown'}{pane.archived ? ' · archived' : pane.missing ? ' · missing' : ''}{remote && (hostReadOnly ? ' · not shared with you' : REMOTE_STATE_NOTES[remote.state])}</p></div>
        {!readOnly && <button type="button" onClick={openPane} className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-interactive hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive">Open Pane</button>}
      </div>
      {pane.panels.length > 0 && <div className="-mx-1 mt-1">{pane.panels.map(panel => {
        const inspector = panel.type === 'explorer' || panel.type === 'diff' ? INSPECTOR_TABS[panel.type] : undefined;
        const stateLabel = panel.missing
          ? 'Missing'
          : panel.state !== 'unknown'
            ? `${panel.state.charAt(0).toUpperCase()}${panel.state.slice(1)}`
            : panel.type && PANEL_TYPE_LABELS[panel.type];
        const openPanel = () => {
          if (inspector) {
            const request: InspectorRequest = { sessionId: pane.paneId, tab: inspector.tab };
            window.dispatchEvent(new CustomEvent(OPEN_INSPECTOR_EVENT, { detail: request }));
            openPane();
          } else {
            void openPaneTarget({ paneId: pane.paneId, panelId: panel.panelId });
          }
        };
        return (
          <button key={panel.panelId} type="button" disabled={readOnly || panel.missing} onClick={openPanel}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] enabled:hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
            <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-text-muted" aria-hidden="true">{panel.type && getPanelIcon(panel.type, { title: panel.title }, 'h-3.5 w-3.5')}</span>
            <span className="min-w-0 flex-1 truncate text-text-secondary">{inspector?.label ?? panel.title}</span>
            {stateLabel && <span className={cn('flex-shrink-0', panel.state === 'blocked' ? 'text-status-error' : panel.state === 'working' ? 'text-status-warning' : 'text-text-muted')}>{stateLabel}</span>}
          </button>
        );
      })}</div>}
      {pane.git && <p className="mt-1 text-[10px] text-text-muted">{pane.git.hasUncommittedChanges ? 'Uncommitted changes' : 'Clean working tree'}{pane.git.prNumber ? ` · PR #${pane.git.prNumber}` : ''}</p>}
    </div>
  );
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
