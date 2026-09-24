import { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import { ChevronDown, ChevronRight, Plus, GitBranch, MoreHorizontal, Home, Archive, ArchiveRestore, Trash2, GitPullRequest, GitPullRequestDraft, Pin, Monitor, MessageSquare, BarChart3, Settings } from 'lucide-react';
import { SessionDetailTooltip } from './SessionDetailTooltip';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { SETTINGS_PREFERENCE_KEYS, normalizeSidebarPaneRowLayout, type SidebarPaneRowLayout } from '../types/settings';
import { CreateSessionDialog } from './CreateSessionDialog';
import { AddProjectDialog } from './AddProjectDialog';
import ProjectSettings from './ProjectSettings';
import { Dropdown } from './ui/Dropdown';
import { Tooltip } from './ui/Tooltip';
import { StatusAccentBar } from './ui/StatusAccentBar';
import { AgentActivityDot, AgentStatusDot } from './ui/AgentStatusDot';
import type { DropdownItem } from './ui/Dropdown';
import { useSessionAgentDisplayStatus } from '../hooks/useAgentStatus';
import { rollupAgentDisplayStatus, rollupSessionAgentState, toAgentDisplayStatus } from '../utils/agentStatus';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import type { Session, GitStatus } from '../types/session';
import type { Project } from '../types/project';
import { usePanelStore } from '../stores/panelStore';
import { OrchestrationSessionNav } from './OrchestrationSessionNav';
import {
  isArchivedOrchestrationSession,
  useOrchestrationSessionStore,
} from '../stores/orchestrationSessionStore';
import type { SidebarNavigationScope } from '../stores/navigationStore';
import {
  createProjectById,
  flattenSessionsByProjects,
  getPinnedSessions,
  groupSessionsByProject,
} from '../utils/sessionOrdering';

const SIDEBAR_ROW_BASE = 'flex w-full items-center text-left transition-colors';
const SIDEBAR_ROW_PADDING = 'px-4';
const SIDEBAR_ROW_GAP = 'gap-2';
const SIDEBAR_SECTION_ROW = 'mt-1.5 flex w-full items-center justify-between gap-2 pl-3.5 pr-2 py-0.5';
const SIDEBAR_SECTION_LABEL = 'truncate text-[11px] font-semibold uppercase tracking-wide leading-4 text-text-tertiary';
const SIDEBAR_SECTION_TOGGLE = 'group/section relative z-20 -my-1 flex min-h-6 min-w-0 flex-1 items-center justify-between gap-2 py-1 text-left text-sm text-text-tertiary transition-colors hover:text-text-primary focus-visible:text-text-primary';

interface ProjectSessionListProps {
  projects: Project[];
  onProjectsChange: (update: (projects: Project[]) => Project[]) => void;
  onProjectsRefresh: () => void;
  sessionSortAscending: boolean;
  pinnedSectionExpanded: boolean;
  repositoriesSectionExpanded: boolean;
  onPinnedSectionExpandedChange: (expanded: boolean) => void;
  onRepositoriesSectionExpandedChange: (expanded: boolean) => void;
  /** Lets the sidebar footer's "Add repository" open this list's dialog. */
  onRegisterAddRepository?: (open: () => void) => void;
  showRemoteDesktopLink?: boolean;
  onRemoteDesktopClick?: () => void;
  remoteDesktopTooltip?: string;
}

export function ProjectSessionList({
  projects,
  onProjectsChange,
  onProjectsRefresh,
  sessionSortAscending,
  pinnedSectionExpanded,
  repositoriesSectionExpanded,
  onPinnedSectionExpandedChange,
  onRepositoriesSectionExpandedChange,
  onRegisterAddRepository,
  showRemoteDesktopLink = false,
  onRemoteDesktopClick,
  remoteDesktopTooltip,
}: ProjectSessionListProps) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForProject, setCreateForProject] = useState<Project | null>(null);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [sidebarPaneRowLayout, setSidebarPaneRowLayout] = useState<SidebarPaneRowLayout>('single');
  const knownSessionIdsRef = useRef<Set<string> | null>(null);

  // Add project dialog state
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  useEffect(() => {
    onRegisterAddRepository?.(() => setShowAddProjectDialog(true));
  }, [onRegisterAddRepository]);

  // Drag-to-reorder state
  const [dragProjectId, setDragProjectId] = useState<number | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<number | null>(null);

  const sessions = useSessionStore(s => s.sessions);
  const sessionsLoaded = useSessionStore(s => s.isLoaded);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const activeView = useNavigationStore(s => s.activeView);
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);
  const navigateToPaneChat = useNavigationStore(s => s.navigateToPaneChat);
  const paneChatStatus = useSessionAgentDisplayStatus(PANE_CHAT_SESSION_ID);
  const orchestrationAvailability = useOrchestrationSessionStore(s => s.availability);
  const selectOrchestrationSession = useOrchestrationSessionStore(s => s.select);
  const navigateToProject = useNavigationStore(s => s.navigateToProject);
  const navigateToUsage = useNavigationStore(s => s.navigateToUsage);
  const setSidebarNavigationScope = useNavigationStore(s => s.setSidebarNavigationScope);
  // Expansion state lives in the navigation store so the always-mounted
  // session hotkeys (useSessionNavigationHotkeys) see the same visible ordering
  const expandedProjects = useNavigationStore(s => s.expandedProjects);
  const toggleProjectExpanded = useNavigationStore(s => s.toggleProjectExpanded);
  const expandProject = useNavigationStore(s => s.expandProject);
  const agentStatusByPanel = usePanelStore(s => s.agentStatus);
  const agentPanelSessions = usePanelStore(s => s.agentStatusSession);
  const unviewedBySession = usePanelStore(s => s.unviewedCompletedActivity);

  useEffect(() => {
    let cancelled = false;

    const loadSidebarPaneRowLayout = async () => {
      try {
        // SAFETY: The named IPC/API channel contract establishes this response payload type.
        const result = await window.electron?.invoke(
          'preferences:get',
          SETTINGS_PREFERENCE_KEYS.sidebarPaneRowLayout
        ) as { success?: boolean; data?: string } | undefined;
        if (!cancelled) {
          setSidebarPaneRowLayout(normalizeSidebarPaneRowLayout(result?.data));
        }
      } catch {
        if (!cancelled) setSidebarPaneRowLayout('single');
      }
    };

    const handlePreferenceChanged = (event: Event) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      const detail = (event as CustomEvent<{ layout?: SidebarPaneRowLayout }>).detail;
      setSidebarPaneRowLayout(normalizeSidebarPaneRowLayout(detail?.layout));
    };

    void loadSidebarPaneRowLayout();
    window.addEventListener('sidebar-pane-row-layout-changed', handlePreferenceChanged);

    return () => {
      cancelled = true;
      window.removeEventListener('sidebar-pane-row-layout-changed', handlePreferenceChanged);
    };
  }, []);

  // Group sessions by project
  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sessions, sessionSortAscending),
    [sessions, sessionSortAscending]
  );

  const projectById = useMemo(() => createProjectById(projects), [projects]);

  const pinnedSessions = useMemo(() => {
    return getPinnedSessions(sessions, projectById);
  }, [sessions, projectById]);

  // mod+1-9 session switch hotkeys are registered in useSessionNavigationHotkeys
  // (always mounted in Sidebar), and new-project auto-expansion lives there too.

  const persistExpandedProjects = useCallback((projectIds: number[]) => {
    void window.electronAPI.uiState.saveExpandedProjects(projectIds).catch(error => {
      console.error('Failed to save expanded projects:', error);
    });
  }, []);

  // Auto-expand only for sessions created after the initial session list is known.
  // Restoring the previously active session on app launch should not override
  // the user's saved collapsed project preferences.
  useEffect(() => {
    if (!sessionsLoaded) return;

    const currentIds = new Set(sessions.map(session => session.id));
    const previousIds = knownSessionIdsRef.current;

    if (!previousIds) {
      knownSessionIdsRef.current = currentIds;
      return;
    }

    if (activeSessionId && !previousIds.has(activeSessionId)) {
      const session = sessions.find(item => item.id === activeSessionId);
      if (session?.projectId) {
        const expandedProjectIds = expandProject(session.projectId);
        if (expandedProjectIds) persistExpandedProjects(expandedProjectIds);
      }
    }

    knownSessionIdsRef.current = currentIds;
  }, [activeSessionId, expandProject, persistExpandedProjects, sessions, sessionsLoaded]);

  const toggleProject = (id: number) => {
    const expandedProjectIds = toggleProjectExpanded(id);
    persistExpandedProjects(expandedProjectIds);
  };

  const handleSessionClick = useCallback((sessionId: string, scope: SidebarNavigationScope = 'repositories') => {
    setSidebarNavigationScope(scope);
    setActiveSession(sessionId);
    navigateToSessions();
  }, [navigateToSessions, setActiveSession, setSidebarNavigationScope]);

  const handleNewSession = (project: Project) => {
    setCreateForProject(project);
    setShowCreateDialog(true);
  };

  const handleOpenProjectSettings = (project: Project) => {
    setSettingsProject(project);
    setShowProjectSettings(true);
  };

  const handleProjectUpdated = () => {
    onProjectsRefresh();
    window.dispatchEvent(new Event('project-changed'));
  };

  const handleProjectSettingsDeleted = () => {
    setShowProjectSettings(false);
    setSettingsProject(null);
    onProjectsRefresh();
    window.dispatchEvent(new Event('project-changed'));
  };

  // Session operations
  const handleArchiveSession = useCallback(async (sessionId: string) => {
    try {
      await API.sessions.delete(sessionId);
    } catch (e) {
      console.error('Failed to archive session:', e);
    }
  }, []);

  const handleTogglePinnedSession = useCallback(async (sessionId: string) => {
    try {
      await API.sessions.toggleFavorite(sessionId);
    } catch (e) {
      console.error('Failed to toggle pinned session:', e);
    }
  }, []);

  // Project operations
  const handleDeleteProject = async (projectId: number) => {
    try {
      await API.projects.delete(String(projectId));
      onProjectsRefresh();
      window.dispatchEvent(new Event('project-changed'));
    } catch (e) {
      console.error('Failed to delete project:', e);
    }
  };

  // Drag-to-reorder handlers
  const handleProjectDragStart = (e: React.DragEvent, projectId: number) => {
    setDragProjectId(projectId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(projectId));
  };

  const handleProjectDragOver = (e: React.DragEvent, projectId: number) => {
    e.preventDefault();
    if (dragProjectId !== null && dragProjectId !== projectId) {
      setDragOverProjectId(projectId);
    }
  };

  const handleProjectDrop = async (e: React.DragEvent, targetProjectId: number) => {
    e.preventDefault();
    if (dragProjectId === null || dragProjectId === targetProjectId) {
      setDragProjectId(null);
      setDragOverProjectId(null);
      return;
    }

    let payload: Array<{ id: number; displayOrder: number }> = [];
    onProjectsChange(current => {
      const newProjects = [...current];
      const fromIndex = newProjects.findIndex(p => p.id === dragProjectId);
      const toIndex = newProjects.findIndex(p => p.id === targetProjectId);
      if (fromIndex === -1 || toIndex === -1) return current;

      const [moved] = newProjects.splice(fromIndex, 1);
      newProjects.splice(toIndex, 0, moved);

      payload = newProjects.map((p, i) => ({ id: p.id, displayOrder: i }));
      return newProjects;
    });

    setDragProjectId(null);
    setDragOverProjectId(null);

    if (payload.length > 0) {
      try {
        await API.projects.reorder(payload);
        window.dispatchEvent(new Event('project-changed'));
      } catch (err) {
        console.error('Failed to reorder projects:', err);
        onProjectsRefresh();
      }
    }
  };

  const handleProjectDragEnd = () => {
    setDragProjectId(null);
    setDragOverProjectId(null);
  };

  // Compute global index for each session (for hotkey labels in tooltips)
  const globalSessionIndex = useMemo(() => {
    const map = new Map<string, number>();
    flattenSessionsByProjects(projects, sessionsByProject, expandedProjects).forEach((session, index) => {
      map.set(session.id, index);
    });
    return map;
  }, [projects, expandedProjects, sessionsByProject]);

  const paneById = useMemo(
    () => new Map(sessions.map(session => [session.id, session])),
    [sessions],
  );

  const availablePaneIds = useMemo(
    () => new Set(sessions.filter(session => !session.archived && !session.isHidden).map(session => session.id)),
    [sessions],
  );

  const handleManagedPaneClick = useCallback(async (paneId: string, parentSessionId: string) => {
    try {
      // Keep the parent Session selected so the top-level Sessions shortcut
      // returns to the conversation that owns the focused Pane.
      await selectOrchestrationSession({ sessionId: parentSessionId });
    } catch {
      // The Pane remains navigable if the orchestration selection cannot refresh.
    }
    handleSessionClick(paneId, 'repositories');
  }, [handleSessionClick, selectOrchestrationSession]);

  const renderManagedPane = useCallback((paneId: string, parentSessionId: string) => {
    const pane = paneById.get(paneId);
    if (!pane || pane.archived || pane.isHidden) return null;

    return (
      <SessionRow
        key={`orchestration-${parentSessionId}-${pane.id}`}
        session={pane}
        isActive={pane.id === activeSessionId}
        globalIndex={globalSessionIndex.get(pane.id) ?? -1}
        onClick={() => void handleManagedPaneClick(pane.id, parentSessionId)}
        onArchive={() => void handleArchiveSession(pane.id)}
        onTogglePinned={() => void handleTogglePinnedSession(pane.id)}
        rowLayout={sidebarPaneRowLayout}
      />
    );
  }, [activeSessionId, globalSessionIndex, handleArchiveSession, handleManagedPaneClick, handleTogglePinnedSession, paneById, sidebarPaneRowLayout]);

  const pinnedPaneRows = pinnedSessions.length > 0 ? (
    <div className="mt-0.5">
      {pinnedSessions.map(({ session, label }) => (
        <SessionRow
          key={`pinned-${session.id}`}
          session={session}
          isActive={session.id === activeSessionId}
          globalIndex={-1}
          displayName={label}
          onClick={() => handleSessionClick(session.id, 'pinned')}
          onArchive={() => handleArchiveSession(session.id)}
          onTogglePinned={() => handleTogglePinnedSession(session.id)}
          rowLayout={sidebarPaneRowLayout}
        />
      ))}
    </div>
  ) : null;

  return (
    <>
      <div className="flex flex-col py-1.5">
        {/* Home */}
        <button
          type="button"
          onClick={() => {
            setSidebarNavigationScope('repositories');
            setActiveSession(null);
            navigateToSessions();
          }}
          className={cn(SIDEBAR_ROW_BASE, SIDEBAR_ROW_GAP, SIDEBAR_ROW_PADDING, 'h-8 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary')}
        >
          <Home className="w-4 h-4" />
          <span>Home</span>
        </button>

        {orchestrationAvailability === 'unavailable' || orchestrationAvailability === 'idle' ? (
          <button
            type="button"
            onClick={() => {
              setSidebarNavigationScope('repositories');
              setActiveSession(null);
              navigateToPaneChat();
            }}
            className={cn(
              SIDEBAR_ROW_BASE,
              SIDEBAR_ROW_GAP,
              SIDEBAR_ROW_PADDING,
              'h-8 text-[13px] hover:bg-surface-hover hover:text-text-primary',
              activeView === 'pane-chat'
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-secondary',
            )}
          >
            <MessageSquare className="w-4 h-4" />
            <span>Pane Chat</span>
            <AgentStatusDot status={paneChatStatus} size="sm" className="ml-auto" />
          </button>
        ) : null}

        <button
          type="button"
          data-testid="usage-nav"
          onClick={() => {
            setSidebarNavigationScope('repositories');
            navigateToUsage();
          }}
          className={cn(
            SIDEBAR_ROW_BASE,
            SIDEBAR_ROW_GAP,
            SIDEBAR_ROW_PADDING,
            'py-2 text-sm hover:bg-surface-hover hover:text-text-primary',
            activeView === 'usage'
              ? 'bg-surface-hover text-text-primary'
              : 'text-text-secondary',
          )}
        >
          <BarChart3 className="w-4 h-4" />
          <span>Usage &amp; Limits</span>
        </button>

        {showRemoteDesktopLink && onRemoteDesktopClick && (
          <Tooltip content={remoteDesktopTooltip} side="right" className="block w-full">
            <button
              type="button"
              onClick={onRemoteDesktopClick}
              className={cn(SIDEBAR_ROW_BASE, SIDEBAR_ROW_GAP, SIDEBAR_ROW_PADDING, 'h-8 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary')}
            >
              <Monitor className="w-4 h-4" />
              <span>Remote Desktop</span>
            </button>
          </Tooltip>
        )}

        <div className="mx-2 my-2 border-t border-border-primary" aria-hidden="true" />

        <OrchestrationSessionNav
          availablePaneIds={availablePaneIds}
          renderPane={renderManagedPane}
          pinnedPaneRows={pinnedPaneRows}
          pinnedSectionExpanded={pinnedSectionExpanded}
          onPinnedSectionExpandedChange={onPinnedSectionExpandedChange}
        />

        <div className={SIDEBAR_SECTION_ROW}>
          <button
            type="button"
            onClick={() => onRepositoriesSectionExpandedChange(!repositoriesSectionExpanded)}
            className={SIDEBAR_SECTION_TOGGLE}
          >
            <span className={SIDEBAR_SECTION_LABEL}>Repositories</span>
            <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-visible/section:opacity-100">
              {repositoriesSectionExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-current" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-current" />
              )}
            </span>
          </button>
        </div>

        {/* Projects */}
        {repositoriesSectionExpanded && projects.map((project, projectIndex) => {
          const isExpanded = expandedProjects.has(project.id);
          const projectSessions = sessionsByProject.get(project.id) || [];

          // Display status rolled up across the project's sessions
          // (blocked > working > done > idle), so unseen completion shows blue
          // at the project level too.
          const projectAgentState = rollupAgentDisplayStatus(
            projectSessions.map(s => toAgentDisplayStatus(
              rollupSessionAgentState(agentStatusByPanel, agentPanelSessions, s.id),
              Boolean(unviewedBySession[s.id]),
            ))
          );

          const projectMenuItems: DropdownItem[] = [
            {
              id: 'main-workspace',
              label: 'Open session on main',
              icon: GitBranch,
              onClick: () => navigateToProject(project.id),
            },
            {
              id: 'project-settings',
              label: 'Project Settings',
              icon: Settings,
              onClick: () => handleOpenProjectSettings(project),
            },
            {
              id: 'delete',
              label: 'Delete Project',
              icon: Trash2,
              variant: 'danger',
              onClick: () => {
                if (confirm(`Delete project "${project.name}"? Panes will be archived.`)) {
                  handleDeleteProject(project.id);
                }
              },
            },
          ];

          return (
            <div key={project.id} className={cn(projectIndex > 0 && "mt-1 border-t border-border-primary pt-1")}>
              {/* Project header */}
              <div
                className={cn(
                  "group/project relative flex items-center gap-1.5 pl-3 pr-2 py-1 hover:bg-surface-hover transition-colors",
                  dragOverProjectId === project.id && dragProjectId !== project.id && "bg-interactive/20",
                  dragProjectId === project.id && "opacity-50"
                )}
                draggable
                onDragStart={(e) => handleProjectDragStart(e, project.id)}
                onDragOver={(e) => handleProjectDragOver(e, project.id)}
                onDrop={(e) => handleProjectDrop(e, project.id)}
                onDragEnd={handleProjectDragEnd}
                onDragLeave={() => setDragOverProjectId(null)}
              >
                <Tooltip
                  content={<span className="text-[10px] text-text-tertiary font-mono break-all">{project.path}</span>}
                  side="right"
                >
                  <button
                    type="button"
                    onClick={() => toggleProject(project.id)}
                    aria-expanded={isExpanded}
                    aria-controls={`project-sessions-${project.id}`}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} repository ${project.name}`}
                    className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
                  />
                </Tooltip>
                <div className="relative z-10 pointer-events-none flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="min-w-0 truncate text-xs font-semibold text-text-primary">{project.name}</span>
                    {projectAgentState === 'unknown' ? (
                      <AgentActivityDot active={false} size="sm" className="flex-shrink-0" />
                    ) : (
                      <AgentStatusDot status={projectAgentState} size="sm" className="flex-shrink-0" />
                    )}
                  </div>
                </div>
                <div
                  className="relative z-10 flex-shrink-0 opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 transition-opacity ml-auto"
                >
                  <Dropdown
                    trigger={
                      <button
                        type="button"
                        aria-label={`Repository actions for ${project.name}`}
                        className="p-1 rounded text-text-muted hover:text-text-tertiary hover:bg-surface-hover transition-colors"
                      >
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </button>
                    }
                    items={projectMenuItems}
                    position="auto"
                    width="sm"
                  />
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNewSession(project);
                  }}
                  className="relative z-10 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  aria-label={`New pane in ${project.name}`}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleProject(project.id);
                  }}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="relative z-10 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-surface-hover transition-colors"
                >
                  {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
              </div>

              {isExpanded && projectSessions.length > 0 && (
                <div id={`project-sessions-${project.id}`} className="mt-0.5">
                  {projectSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      isActive={session.id === activeSessionId}
                      globalIndex={globalSessionIndex.get(session.id) ?? -1}
                      onClick={() => handleSessionClick(session.id, 'repositories')}
                      onArchive={() => handleArchiveSession(session.id)}
                      onTogglePinned={() => handleTogglePinnedSession(session.id)}
                      rowLayout={sidebarPaneRowLayout}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Create Session Dialog */}
      {showCreateDialog && createForProject && (
        <CreateSessionDialog
          isOpen={showCreateDialog}
          onClose={() => {
            setShowCreateDialog(false);
            setCreateForProject(null);
          }}
          projectName={createForProject.name}
          projectId={createForProject.id}
        />
      )}

      {/* Add Project Dialog */}
      <AddProjectDialog
        isOpen={showAddProjectDialog}
        onClose={() => setShowAddProjectDialog(false)}
      />

      {settingsProject && (
        <ProjectSettings
          project={settingsProject}
          isOpen={showProjectSettings}
          onClose={() => {
            setShowProjectSettings(false);
            setSettingsProject(null);
          }}
          onUpdate={handleProjectUpdated}
          onDelete={handleProjectSettingsDeleted}
        />
      )}
    </>
  );
}



// --- Session row button content ---

function SessionRowContent({
  session,
  gs,
  iconColor,
  hasDiff,
  adds,
  dels,
  displayName,
  showActivity,
  showUnviewedCompleted,
  rowLayout,
}: {
  session: Session;
  gs: GitStatus | undefined;
  iconColor: string;
  hasDiff: boolean;
  adds: number;
  dels: number;
  displayName?: string;
  showActivity: boolean;
  showUnviewedCompleted: boolean;
  rowLayout: SidebarPaneRowLayout;
}) {
  const title = displayName || gs?.prTitle || session.name || 'Untitled';
  const prNumber = gs?.prNumber;
  const PullRequestIcon = gs?.prIsDraft ? GitPullRequestDraft : GitPullRequest;
  const showMetadata = Boolean(prNumber || hasDiff || session.worktreeOwnership === 'external');

  if (rowLayout === 'single') {
    return (
      <div className="flex min-w-0 w-full items-center gap-1.5">
        {prNumber ? (
          <PullRequestIcon className={`w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
        ) : (
          <GitBranch className={`w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
        )}
        <span className={cn(
          'min-w-0 flex-1 truncate text-sm font-medium text-text-primary decoration-status-info decoration-2 underline-offset-4',
          showActivity && 'animate-sidebar-active-label',
          showUnviewedCompleted && 'underline decoration-dashed'
        )}>
          {title}
        </span>
        {showMetadata && (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-xs tabular-nums">
            {hasDiff && (
              <span className="flex items-center gap-1">
                <span className="font-semibold text-status-success">+{adds}</span>
                <span className="font-semibold text-status-error">-{dels}</span>
              </span>
            )}
            {prNumber && <span className="text-text-tertiary">#{prNumber}</span>}
            {session.worktreeOwnership === 'external' && <span className="text-text-tertiary">External</span>}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 w-full items-start gap-1.5">
      {prNumber ? (
        <PullRequestIcon className={`mt-0.5 w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
      ) : (
        <GitBranch className={`mt-0.5 w-3.5 h-3.5 flex-shrink-0 ${iconColor}`} />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn(
          'min-w-0 truncate text-sm font-medium leading-5 text-text-primary decoration-status-info decoration-2 underline-offset-4',
          showActivity && 'animate-sidebar-active-label',
          showUnviewedCompleted && 'underline decoration-dashed'
        )}>
          {title}
        </span>
        {showMetadata && (
          <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] font-semibold leading-3">
            {prNumber && (
              <span className="text-text-tertiary">#{prNumber}</span>
            )}
            {hasDiff && (
              <>
                <span className="text-status-success">+{adds}</span>
                <span className="text-status-error">-{dels}</span>
              </>
            )}
            {session.worktreeOwnership === 'external' && (
              <span className="text-text-tertiary">External</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// --- Session row sub-component ---

interface SessionRowProps {
  session: Session;
  isActive: boolean;
  globalIndex: number;
  onClick: () => void;
  onArchive: () => void;
  onTogglePinned: () => void;
  displayName?: string;
  rowLayout: SidebarPaneRowLayout;
}

interface GitStatusIPCResponse {
  success: boolean;
  gitStatus?: GitStatus;
}

function SessionRow({
  session, isActive, globalIndex, onClick,
  onArchive, onTogglePinned, displayName, rowLayout,
}: SessionRowProps) {
  const [localGitStatus, setLocalGitStatus] = useState<GitStatus | undefined>(session.gitStatus);
  const initialGitStatusRequestRef = useRef<string | null>(null);

  const hasUnviewedCompletedActivity = usePanelStore(s => Boolean(s.unviewedCompletedActivity[session.id]));
  const agentDisplayStatus = useSessionAgentDisplayStatus(session.id);

  // Queue the initial refresh even when cached status is available, so cached
  // PR state is corrected by the background git/PR refresh path.
  useEffect(() => {
    if (initialGitStatusRequestRef.current === session.id || session.archived || session.status === 'error') return;
    initialGitStatusRequestRef.current = session.id;
    const fetchStatus = async () => {
      try {
        if (!window.electron?.invoke) return;
        // SAFETY: The named IPC/API channel contract establishes this response payload type.
        const res = await window.electron.invoke(
          'sessions:get-git-status',
          session.id,
          false,
          true
        ) as GitStatusIPCResponse;
        if (res?.success && res.gitStatus) {
          setLocalGitStatus(res.gitStatus);
        }
      } catch {
        // Silently fail
      }
    };
    fetchStatus();
  }, [session.id, session.archived, session.status]);

  // Sync from session prop when store updates
  useEffect(() => {
    if (session.gitStatus) setLocalGitStatus(session.gitStatus);
  }, [session.gitStatus]);

  // Listen for background git status updates (e.g., PR enrichment)
  useEffect(() => {
    const handler = (e: Event) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      const detail = (e as CustomEvent<{ sessionId: string; gitStatus: GitStatus }>).detail;
      if (detail?.sessionId === session.id && detail?.gitStatus) {
        setLocalGitStatus(detail.gitStatus);
      }
    };
    window.addEventListener('git-status-updated', handler);
    return () => window.removeEventListener('git-status-updated', handler);
  }, [session.id]);

  const gs = localGitStatus;

  const iconColor = gs?.prState
    ? gs.prState === 'MERGED' ? 'text-purple-400'
    : gs.prState === 'CLOSED' ? 'text-red-400'
    : 'text-green-400'
    : session.status === 'running' || session.status === 'initializing'
    ? 'text-status-success'
    : session.status === 'error'
    ? 'text-status-error'
    : 'text-text-tertiary';

  const adds = (gs?.commitAdditions ?? 0) + (gs?.additions ?? 0);
  const dels = (gs?.commitDeletions ?? 0) + (gs?.deletions ?? 0);
  const hasDiff = adds > 0 || dels > 0;
  const showActivity = agentDisplayStatus === 'working';
  const accessibleName = displayName || gs?.prTitle || session.name || 'Untitled';

  return (
    <div
      className={cn(
        'group/session relative w-full text-left pl-3 pr-2 transition-colors flex items-center gap-1',
        rowLayout === 'single' ? 'py-1' : 'py-1.5',
        isActive ? 'bg-surface-selected' : 'hover:bg-surface-hover'
      )}
    >
      {/* Always-present left accent bar reflecting the agent status. */}
      <StatusAccentBar status={agentDisplayStatus} />
      <Tooltip
        content={<SessionDetailTooltip session={session} gitStatus={localGitStatus} showName showDiffStats={false} globalIndex={globalIndex} />}
        side="right"
        interactive
      >
        <button
          type="button"
          onClick={onClick}
          aria-current={isActive ? 'page' : undefined}
          aria-label={accessibleName}
          className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
        />
      </Tooltip>
      <div className="pointer-events-none contents">
        <SessionRowContent
          session={session}
          gs={gs}
          iconColor={iconColor}
          hasDiff={hasDiff}
          adds={adds}
          dels={dels}
          displayName={accessibleName}
          showActivity={showActivity}
          showUnviewedCompleted={hasUnviewedCompletedActivity && !isActive && !showActivity}
          rowLayout={rowLayout}
        />

        <div className="relative z-10 pointer-events-auto flex flex-shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onArchive(); }}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-muted hover:text-status-error hover:bg-surface-hover transition-all opacity-0 group-hover/session:opacity-100"
            title="Archive"
            aria-label={`Archive ${accessibleName}`}
          >
            <Archive className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onTogglePinned(); }}
            className={`inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded transition-all ${
              session.isFavorite
                ? 'text-text-muted hover:text-text-tertiary hover:bg-surface-hover opacity-100'
                : 'text-text-muted hover:text-text-tertiary hover:bg-surface-hover opacity-0 group-hover/session:opacity-100'
            }`}
            title={session.isFavorite ? 'Unpin' : 'Pin'}
            aria-label={`${session.isFavorite ? 'Unpin' : 'Pin'} ${accessibleName}`}
          >
            <Pin className="w-3.5 h-3.5 rotate-45" />
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Archived Sessions panel (pinned to sidebar bottom) ---

export function ArchivedSessions() {
  const archivedContentId = useId();
  const [showArchived, setShowArchived] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<Array<Project & { sessions: Session[] }>>([]);
  const [expandedArchivedProjects, setExpandedArchivedProjects] = useState<Set<number>>(new Set());
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const [hasLoadedArchived, setHasLoadedArchived] = useState(false);
  const [orchestrationRestoreError, setOrchestrationRestoreError] = useState<string | null>(null);

  const setActiveSession = useSessionStore(s => s.setActiveSession);
  const activeSessionId = useSessionStore(s => s.activeSessionId);
  const navigateToSessions = useNavigationStore(s => s.navigateToSessions);
  const orchestrationSessions = useOrchestrationSessionStore(s => s.sessions);
  const orchestrationAvailability = useOrchestrationSessionStore(s => s.availability);
  const refreshOrchestrationSessions = useOrchestrationSessionStore(s => s.refresh);
  const updateOrchestrationSession = useOrchestrationSessionStore(s => s.update);
  const archivedOrchestrationSessions = useMemo(
    () => orchestrationSessions
      .filter(session => isArchivedOrchestrationSession(session))
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [orchestrationSessions],
  );
  const archivedPaneCount = useMemo(
    () => archivedProjects.reduce((sum, project) => sum + project.sessions.length, 0),
    [archivedProjects],
  );
  const archivedSessionCount = archivedPaneCount + archivedOrchestrationSessions.length;
  const hasLoadedAnyArchived = hasLoadedArchived || orchestrationAvailability === 'ready';

  const loadArchivedSessions = useCallback(async () => {
    try {
      setIsLoadingArchived(true);
      const response = await API.sessions.getArchivedWithProjects();
      if (response.success && response.data) {
        // SAFETY: The named IPC/API channel contract establishes this response payload type.
        setArchivedProjects(response.data as Array<Project & { sessions: Session[] }>);
      }
    } catch (e) {
      console.error('Failed to load archived sessions:', e);
    } finally {
      setIsLoadingArchived(false);
      setHasLoadedArchived(true);
    }
  }, []);

  const toggleArchived = useCallback(() => {
    const next = !showArchived;
    if (next && !hasLoadedArchived) {
      void loadArchivedSessions();
    }
    if (next && orchestrationAvailability !== 'unavailable') {
      void refreshOrchestrationSessions();
    }
    setShowArchived(next);
  }, [hasLoadedArchived, loadArchivedSessions, orchestrationAvailability, refreshOrchestrationSessions, showArchived]);

  const toggleArchivedProject = (id: number) => {
    setExpandedArchivedProjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRestoreSession = async (sessionId: string) => {
    try {
      await API.sessions.restore(sessionId);
      loadArchivedSessions();
    } catch (e) {
      console.error('Failed to restore session:', e);
    }
  };

  const handleRestoreOrchestrationSession = async (sessionId: string) => {
    setOrchestrationRestoreError(null);
    try {
      await updateOrchestrationSession(
        { sessionId },
        { archived: false },
      );
      // Keep the current chat selected when a historical Session is restored.
      await refreshOrchestrationSessions();
    } catch (cause) {
      setOrchestrationRestoreError(
        cause instanceof Error ? cause.message : 'Failed to restore Session',
      );
    }
  };

  const handlePermanentDeleteSession = async (session: Session) => {
    const sessionName = session.name || 'Untitled';
    const confirmed = window.confirm(
      `Permanently delete archived pane "${sessionName}"?\n\nThis removes it from Pane history and cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const response = await API.sessions.permanentDelete(session.id);
      if (!response.success) {
        console.error('Failed to permanently delete session:', response.error);
        return;
      }
      if (activeSessionId === session.id) {
        await setActiveSession(null);
        navigateToSessions();
      }
      loadArchivedSessions();
    } catch (e) {
      console.error('Failed to permanently delete session:', e);
    }
  };

  const handlePermanentDeleteAllArchived = async () => {
    if (archivedPaneCount === 0) return;

    const confirmed = window.confirm(
      `Permanently delete all ${archivedPaneCount} archived panes?\n\nThis removes them from Pane history and cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const response = await API.sessions.permanentDeleteArchived();
      if (!response.success) {
        console.error('Failed to permanently delete archived sessions:', response.error);
        return;
      }
      const deletedActiveSession = archivedProjects.some(project =>
        project.sessions.some(session => session.id === activeSessionId),
      );
      if (deletedActiveSession) {
        await setActiveSession(null);
        navigateToSessions();
      }
      loadArchivedSessions();
    } catch (e) {
      console.error('Failed to permanently delete archived sessions:', e);
    }
  };

  const handleSessionClick = (sessionId: string) => {
    setActiveSession(sessionId);
    navigateToSessions();
  };

  return (
    <div className="border-t border-border-primary">
      <div className="group/archived-header flex items-center hover:bg-surface-hover focus-within:bg-surface-hover transition-colors">
        <button
          type="button"
          onClick={toggleArchived}
          aria-expanded={showArchived}
          aria-controls={archivedContentId}
          className="min-w-0 flex-1 flex h-10 items-center gap-2 pl-4 pr-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
        >
          {showArchived ? (
            <ChevronDown className="w-3 h-3 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 flex-shrink-0" />
          )}
          <Archive className="w-3 h-3 flex-shrink-0" />
          <span>Archived</span>
        </button>
        {hasLoadedAnyArchived && archivedPaneCount > 0 && (
          <button
            type="button"
            onClick={handlePermanentDeleteAllArchived}
            className="flex-shrink-0 p-1 rounded text-text-muted hover:text-status-error hover:bg-surface-hover transition-all opacity-0 group-hover/archived-header:opacity-100 group-focus-within/archived-header:opacity-100"
            title="Permanently delete all archived panes"
            aria-label="Permanently delete all archived panes"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
        {hasLoadedAnyArchived && archivedSessionCount > 0 && (
          <span className="w-8 pr-3 text-right text-[10px] text-text-muted font-normal tabular-nums">
            {archivedSessionCount}
          </span>
        )}
      </div>
      {orchestrationRestoreError && (
        <p role="alert" className="mx-4 py-1 text-xs text-status-error">{orchestrationRestoreError}</p>
      )}

      {showArchived && (
        <div id={archivedContentId} className="pb-2 max-h-[40vh] overflow-y-auto">
          {isLoadingArchived ? (
            <div className="px-4 py-2 space-y-2 animate-pulse">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-7 bg-surface-tertiary rounded" />
              ))}
            </div>
          ) : archivedProjects.length === 0 && archivedOrchestrationSessions.length === 0 ? (
            <div className="px-5 py-3 text-xs text-text-tertiary">
              No archived panes
            </div>
          ) : (
            <>
              {archivedOrchestrationSessions.length > 0 && (
                <div data-testid="archived-orchestration-sessions" className="pb-1">
                  <p className="px-5 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Archived Sessions</p>
                  {archivedOrchestrationSessions.map(session => (
                    <div
                      key={`archived-orchestration-${session.id}`}
                      data-testid={`archived-orchestration-session-${session.id}`}
                      className="group/archived relative flex items-center gap-2 pl-8 pr-1 py-1.5 hover:bg-surface-hover transition-colors"
                    >
                      <Archive className="h-3 w-3 flex-shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">
                        {session.name || 'Untitled'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleRestoreOrchestrationSession(session.id)}
                        className="relative z-10 flex-shrink-0 rounded p-1 text-text-muted hover:bg-surface-hover hover:text-status-success transition-all opacity-0 group-hover/archived:opacity-100 group-focus-within/archived:opacity-100"
                        title={`Restore Session ${session.name || 'Untitled'}`}
                        aria-label={`Restore Session ${session.name || 'Untitled'}`}
                      >
                        <ArchiveRestore className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {archivedProjects.map(project => {
                const isExpanded = expandedArchivedProjects.has(project.id);
                return (
                  <div key={`archived-${project.id}`}>
                    <button
                      type="button"
                      onClick={() => toggleArchivedProject(project.id)}
                      aria-expanded={isExpanded}
                      aria-controls={`archived-project-${project.id}`}
                      className="w-full flex items-center gap-2 pl-5 pr-4 py-1.5 text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-3 h-3 flex-shrink-0" />
                      )}
                      <span className="truncate">{project.name}</span>
                      <span className="ml-auto text-text-muted text-[10px]">{project.sessions.length}</span>
                    </button>
                    {isExpanded && <div id={`archived-project-${project.id}`}>{project.sessions.map(session => (
                      <div
                        key={session.id}
                        className="group/archived relative flex items-center gap-1 pl-8 pr-1 py-1.5 hover:bg-surface-hover transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => handleSessionClick(session.id)}
                          aria-label={`Open archived pane ${session.name || 'Untitled'}`}
                          className="absolute inset-0 z-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-interactive"
                        />
                        <div className="relative z-10 pointer-events-none flex-1 text-left min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <Archive className="w-3 h-3 flex-shrink-0 text-text-muted" />
                            <span className="text-xs text-text-tertiary truncate">
                              {session.name || 'Untitled'}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleRestoreSession(session.id); }}
                          className="relative z-10 flex-shrink-0 p-1 rounded text-text-muted hover:text-status-success hover:bg-surface-hover transition-all opacity-0 group-hover/archived:opacity-100 group-focus-within/archived:opacity-100"
                          title={`Restore ${session.name || 'Untitled'}`}
                          aria-label={`Restore ${session.name || 'Untitled'}`}
                        >
                          <ArchiveRestore className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handlePermanentDeleteSession(session); }}
                          className="relative z-10 flex-shrink-0 p-1 rounded text-text-muted hover:text-status-error hover:bg-surface-hover transition-all opacity-0 group-hover/archived:opacity-100 group-focus-within/archived:opacity-100"
                          title={`Permanently delete ${session.name || 'Untitled'}`}
                          aria-label={`Permanently delete ${session.name || 'Untitled'}`}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}</div>}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
