import { Archive, ArchiveRestore, ChevronDown, ChevronRight, MessageSquare, Monitor, Pin, PinOff, Plus, RefreshCw, TerminalSquare, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { OrchestrationSessionRecord } from '../../../../shared/types/orchestrationSession';
import type { RemoteProjectWithSessions } from '../runtime/remoteRuntimeAdapter';
import type { Session } from '../../types/session';
import { RemoteDesktopLink } from './RemoteDesktopLink';
import { createProjectById, getPinnedSessions } from '../../utils/sessionOrdering';
import { useRemoteSessionStore } from '../stores/remoteSessionStore';
import { useRemoteSidebarSectionsStore, type RemoteSidebarSection } from '../stores/remoteSidebarSectionsStore';

/** Sidebar actions. Panes are the PWA's "sessions"; Sessions are orchestration Sessions. */
export interface RemoteSidebarActions {
  /** `scope` names the sidebar row the tap came from, so only that copy of the Pane is highlighted. */
  selectPane: (paneId: string, scope: string) => void;
  togglePanePinned: (paneId: string) => void;
  archivePane: (paneId: string) => void;
  restorePane: (paneId: string) => void;
  /** Without a repository, the sheet starts in the default one and lets the person pick. */
  createPane: (project?: RemoteProjectWithSessions) => void;
  openSession: (sessionId: string) => void;
  createSession: () => void;
  toggleSessionPinned: (session: OrchestrationSessionRecord) => void;
  setSessionArchived: (session: OrchestrationSessionRecord, archived: boolean) => void;
  reloadSessions: () => void;
  loadArchived: () => void;
  refresh: () => void;
}

interface RemoteSidebarProps {
  loading: boolean;
  /** A Pane or Session id whose pin, archive or restore is in flight. */
  actionId?: string | null;
  actions: RemoteSidebarActions;
  /** The row scope of the last Pane tap; ignored once another Pane is selected. */
  selectedPane?: { paneId: string; scope: string } | null;
  onClose?: () => void;
  className?: string;
}

const SECTION_HEADER = 'flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-text-tertiary hover:text-text-primary md:min-h-0';
const CREATE_BUTTON = 'flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-interactive px-3 text-sm font-semibold text-text-on-interactive transition-colors hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9';
const ROW_ACTION = 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:w-8';

export function RemoteSidebar({
  loading,
  actionId = null,
  actions,
  selectedPane = null,
  onClose,
  className = 'flex w-80 shrink-0',
}: RemoteSidebarProps) {
  const projects = useRemoteSessionStore(state => state.projects);
  const selectedPaneId = useRemoteSessionStore(state => state.selectedSessionId);
  const openSessionId = useRemoteSessionStore(state => state.openOrchestrationSession?.session.id ?? null);
  const sessions = useRemoteSessionStore(state => state.orchestrationSessions);
  const sessionsAvailability = useRemoteSessionStore(state => state.orchestrationAvailability);
  const sessionsError = useRemoteSessionStore(state => state.orchestrationError);
  const archivedProjects = useRemoteSessionStore(state => state.archivedProjects);
  const expanded = useRemoteSidebarSectionsStore(state => state.expanded);
  const toggleSection = useRemoteSidebarSectionsStore(state => state.toggle);
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<ReadonlySet<string>>(new Set());
  const sessionsSupported = sessionsAvailability !== 'unavailable';

  const paneById = useMemo(
    () => new Map(projects.flatMap(project => (project.sessions ?? []).map(pane => [pane.id, pane] as const))),
    [projects],
  );
  const pinnedPanes = useMemo(
    () => getPinnedSessions([...paneById.values()], createProjectById(projects)),
    [paneById, projects],
  );
  const activeSessions = useMemo(() => sessions.filter(session => session.archived !== true), [sessions]);
  const pinnedSessions = useMemo(() => activeSessions.filter(session => session.isPinned === true), [activeSessions]);
  const archivedSessions = useMemo(
    () => sessions.filter(session => session.archived === true).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [sessions],
  );

  // Loaded up front so the collapsed Archived header can show its count.
  useEffect(() => {
    if (archivedProjects === null) actions.loadArchived();
  }, [actions, archivedProjects]);

  // Only one copy of the open Pane is highlighted: the row it was opened from,
  // else its first row in sidebar order.
  const selectedScope = useMemo(() => {
    if (!selectedPaneId || openSessionId) return null;
    const scopes: string[] = [];
    const addSessionScopes = (list: OrchestrationSessionRecord[], placement: 'pinned' | 'sessions') => {
      for (const session of list) {
        if (session.associations.some(association => association.paneId === selectedPaneId)) scopes.push(`${placement}:${session.id}`);
      }
    };
    addSessionScopes(pinnedSessions, 'pinned');
    if (pinnedPanes.some(({ session }) => session.id === selectedPaneId)) scopes.push('pinned');
    addSessionScopes(activeSessions, 'sessions');
    if (paneById.has(selectedPaneId)) scopes.push('repositories');
    const tapped = selectedPane?.paneId === selectedPaneId ? selectedPane.scope : null;
    return tapped && scopes.includes(tapped) ? tapped : scopes[0] ?? null;
  }, [activeSessions, openSessionId, paneById, pinnedPanes, pinnedSessions, selectedPane, selectedPaneId]);

  const paneRow = (pane: Session, label: string, scope: string, detail?: string) => (
    <RemotePaneRow
      key={`${scope}:${pane.id}`}
      pane={pane}
      label={label}
      detail={detail}
      selected={selectedPaneId === pane.id && selectedScope === scope}
      busy={actionId === pane.id}
      onSelect={() => actions.selectPane(pane.id, scope)}
      onTogglePinned={() => actions.togglePanePinned(pane.id)}
      onArchive={() => actions.archivePane(pane.id)}
    />
  );

  const sessionRow = (session: OrchestrationSessionRecord, placement: 'pinned' | 'sessions') => {
    const panes = session.associations
      .map(association => paneById.get(association.paneId))
      .filter((pane): pane is Session => pane !== undefined);
    const nestedKey = `${placement}:${session.id}`;
    const nestedExpanded = !collapsedSessionIds.has(nestedKey);
    const nestedId = `remote-session-panes-${placement}-${session.id}`;
    const name = session.name || 'Untitled';
    return (
      <div key={nestedKey}>
        <div className={`flex w-full items-stretch gap-1 rounded-md pl-1 pr-3 text-sm transition-colors ${
          openSessionId === session.id
            ? 'bg-interactive-surface text-text-primary'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
        }`}>
          {panes.length > 0 ? (
            <button
              type="button"
              onClick={() => setCollapsedSessionIds(current => toggleSetMember(current, nestedKey))}
              aria-expanded={nestedExpanded}
              aria-controls={nestedId}
              aria-label={`${nestedExpanded ? 'Hide' : 'Show'} panes in ${name}`}
              className={`${ROW_ACTION} self-center text-text-muted hover:text-text-primary`}
            >
              {nestedExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => actions.openSession(session.id)}
            aria-label={`Open Session ${name}`}
            className="flex min-h-8 min-w-0 flex-1 items-center gap-2 py-1.5 text-left md:py-2"
          >
            {/* Without Panes the icon sits inside the button, so tapping it opens the Session too. */}
            {panes.length === 0 && (
              <span className="-mr-1 inline-flex h-11 w-11 shrink-0 items-center justify-center text-text-tertiary md:h-8 md:w-8" aria-hidden="true">
                <MessageSquare className="h-3.5 w-3.5" />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
            {panes.length > 0 && <span className="shrink-0 text-[10px] tabular-nums text-text-muted">{panes.length}</span>}
          </button>
          <span className="flex shrink-0 items-center gap-0.5 py-1.5 md:py-2">
            <button
              type="button"
              disabled={actionId === session.id}
              onClick={() => actions.toggleSessionPinned(session)}
              className={`${ROW_ACTION} ${session.isPinned ? 'text-interactive hover:text-interactive-hover' : 'text-text-muted hover:text-text-primary'}`}
              title={session.isPinned ? 'Unpin' : 'Pin'}
              aria-label={`Pin Session ${name}`}
              aria-pressed={session.isPinned === true}
            >
              <PinIcon pinned={session.isPinned === true} />
            </button>
            <button
              type="button"
              disabled={actionId === session.id}
              onClick={() => actions.setSessionArchived(session, true)}
              className={`${ROW_ACTION} text-text-muted hover:text-status-error`}
              title="Archive"
              aria-label={`Archive Session ${name}`}
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        {panes.length > 0 && (
          <div id={nestedId} hidden={!nestedExpanded} className="ml-6 space-y-1 border-l border-border-primary pl-2 md:ml-5">
            {panes.map(pane => paneRow(pane, pane.name, nestedKey))}
          </div>
        )}
      </div>
    );
  };

  const hasPinned = pinnedSessions.length > 0 || pinnedPanes.length > 0;
  const archivedPaneCount = archivedProjects?.reduce((sum, project) => sum + (project.sessions?.length ?? 0), 0) ?? 0;

  return (
    <aside className={`${className} min-h-0 flex-col border-r border-border-primary bg-surface-primary`}>
      <div className="flex min-h-12 shrink-0 items-center justify-between border-b border-border-primary px-4 py-2">
        <div className="flex items-center gap-2">
          <TerminalSquare className="h-5 w-5 text-interactive" />
          <span className="font-semibold text-text-primary">Remote Pane</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={actions.refresh}
            className="rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
            aria-label="Refresh remote sessions"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-2 text-text-tertiary hover:bg-surface-hover hover:text-text-primary md:hidden"
              aria-label="Close remote panes"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-2 border-b border-border-primary p-3">
        <div className="flex gap-2">
          {sessionsSupported && (
            <button type="button" onClick={actions.createSession} className={CREATE_BUTTON}>
              <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
              New Session
            </button>
          )}
          <button type="button" onClick={() => actions.createPane()} disabled={projects.length === 0} className={CREATE_BUTTON}>
            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
            New Pane
          </button>
        </div>
        <RemoteDesktopLink />
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {hasPinned && (
          <SidebarSection section="pinned" label="Pinned" expanded={expanded.pinned} onToggle={toggleSection}>
            {pinnedSessions.map(session => sessionRow(session, 'pinned'))}
            {pinnedPanes.map(({ session, label, repositoryName }) => paneRow(session, label, 'pinned', repositoryName))}
          </SidebarSection>
        )}

        {sessionsSupported && (
          <SidebarSection section="sessions" label="Sessions" expanded={expanded.sessions} onToggle={toggleSection}>
            {sessionsError && (
              <div role="alert" className="mx-2 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
                <p>{sessionsError}</p>
                <button type="button" onClick={actions.reloadSessions} className="mt-1 underline">Retry</button>
              </div>
            )}
            {sessionsAvailability === 'ready' && activeSessions.length === 0 && (
              <p className="px-2 py-1 text-xs text-text-muted">Create a Session to keep intent and discussion together.</p>
            )}
            {activeSessions.map(session => sessionRow(session, 'sessions'))}
          </SidebarSection>
        )}

        <SidebarSection section="repositories" label="Repositories" expanded={expanded.repositories} onToggle={toggleSection}>
          {projects.length === 0 && !loading && (
            <div className="rounded-md border border-border-primary bg-surface-secondary p-4 text-sm text-text-secondary">
              No remote panes found on this host.
            </div>
          )}
          {projects.map(project => (
            <div key={project.id} className="pb-2">
              <div className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold text-text-tertiary">
                <Monitor className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                <button
                  type="button"
                  onClick={() => actions.createPane(project)}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-primary md:h-auto md:w-auto md:p-1"
                  title={`New pane in ${project.name}`}
                  aria-label={`New pane in ${project.name}`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-1">
                {(project.sessions ?? []).map(pane => paneRow(pane, pane.name, 'repositories'))}
              </div>
            </div>
          ))}
        </SidebarSection>

        <SidebarSection
          section="archived"
          label="Archived"
          expanded={expanded.archived}
          onToggle={toggleSection}
          count={archivedPaneCount + archivedSessions.length}
        >
          {archivedProjects === null ? (
            <p className="px-2 py-1 text-xs text-text-muted">Loading archived panes…</p>
          ) : archivedPaneCount + archivedSessions.length === 0 ? (
            <p className="px-2 py-1 text-xs text-text-muted">Nothing archived</p>
          ) : (
            <>
              {archivedSessions.map(session => (
                <ArchivedRow
                  key={session.id}
                  label={session.name || 'Untitled'}
                  restoreLabel={`Restore Session ${session.name || 'Untitled'}`}
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  busy={actionId === session.id}
                  onRestore={() => actions.setSessionArchived(session, false)}
                />
              ))}
              {archivedProjects.flatMap(project => (project.sessions ?? []).map(pane => (
                <ArchivedRow
                  key={pane.id}
                  label={pane.name || 'Untitled'}
                  detail={project.name}
                  restoreLabel={`Restore ${pane.name || 'Untitled'}`}
                  icon={<Archive className="h-3.5 w-3.5" />}
                  busy={actionId === pane.id}
                  onRestore={() => actions.restorePane(pane.id)}
                />
              )))}
            </>
          )}
        </SidebarSection>
      </div>
    </aside>
  );
}

function toggleSetMember(current: ReadonlySet<string>, member: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(member)) next.delete(member);
  else next.add(member);
  return next;
}

interface SidebarSectionProps {
  section: RemoteSidebarSection;
  label: string;
  expanded: boolean;
  count?: number;
  onToggle: (section: RemoteSidebarSection) => void;
  children: ReactNode;
}

function SidebarSection({ section, label, expanded, count, onToggle, children }: SidebarSectionProps) {
  const contentId = `remote-sidebar-${section}`;
  return (
    <section role="group" aria-label={label}>
      <button
        type="button"
        onClick={() => onToggle(section)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={SECTION_HEADER}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined && count > 0 && <span className="font-normal tabular-nums text-text-muted">{count}</span>}
      </button>
      <div id={contentId} hidden={!expanded} className="mt-1 space-y-1">
        {children}
      </div>
    </section>
  );
}

interface ArchivedRowProps {
  label: string;
  detail?: string;
  restoreLabel: string;
  icon: ReactNode;
  busy: boolean;
  onRestore: () => void;
}

function ArchivedRow({ label, detail, restoreLabel, icon, busy, onRestore }: ArchivedRowProps) {
  return (
    <div className="flex items-center gap-2 rounded-md pl-3 pr-3 text-sm text-text-tertiary md:py-1">
      <span className="shrink-0 text-text-muted" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 truncate">
        {label}
        {detail && <span className="ml-2 text-xs text-text-muted">{detail}</span>}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onRestore}
        className={`${ROW_ACTION} text-text-muted hover:text-status-success`}
        title="Restore"
        aria-label={restoreLabel}
      >
        <ArchiveRestore className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface RemotePaneRowProps {
  pane: Session;
  label: string;
  /** Secondary muted text, e.g. a pinned Pane's repository. */
  detail?: string;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}

function RemotePaneRow({
  pane,
  label,
  detail,
  selected,
  busy,
  onSelect,
  onTogglePinned,
  onArchive,
}: RemotePaneRowProps) {
  return (
    <div
      className={`group flex w-full items-stretch justify-between gap-2 rounded-md px-3 text-left text-sm transition-colors ${
        selected
          ? 'bg-interactive-surface text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left md:py-2"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{label}</span>
          {detail && <span className="ml-2 text-xs text-text-muted">{detail}</span>}
        </span>
        {pane.status === 'running' && (
          <span className="hidden shrink-0 rounded-sm border border-status-success/30 bg-status-success/10 px-1.5 py-0.5 text-[10px] text-status-success sm:inline">
            running
          </span>
        )}
      </button>
      <span className="flex shrink-0 items-center gap-0.5 py-1.5 md:py-2">
        <button
          type="button"
          disabled={busy}
          onClick={onTogglePinned}
          className={`${ROW_ACTION} ${pane.isFavorite ? 'text-interactive hover:text-interactive-hover' : 'text-text-muted hover:text-text-primary'}`}
          title={pane.isFavorite ? 'Unpin' : 'Pin'}
          aria-label="Pin pane"
          aria-pressed={Boolean(pane.isFavorite)}
        >
          <PinIcon pinned={Boolean(pane.isFavorite)} />
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onArchive}
          className={`${ROW_ACTION} text-text-muted hover:text-status-error`}
          title="Archive"
          aria-label="Archive pane"
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

/** Unpin glyph for a pinned row, pin glyph otherwise; both share one box. */
function PinIcon({ pinned }: { pinned: boolean }) {
  return pinned
    ? <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
    : <Pin className="h-3.5 w-3.5 rotate-45" aria-hidden="true" />;
}
