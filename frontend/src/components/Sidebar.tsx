import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CreateSessionDialog } from './CreateSessionDialog';
import { ProjectSessionList, ArchivedSessions } from './ProjectSessionList';
import { ArchiveProgress } from './ArchiveProgress';
import { ArrowUpDown, BookOpen, ChevronDown, ChevronRight, Info, FolderGit2, Home, Monitor, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, Settings as SettingsIcon, Plus, RefreshCw, MessageSquare, SquareTerminal } from 'lucide-react';
import { SessionDetailTooltip } from './SessionDetailTooltip';
import { IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Kbd } from './ui/Kbd';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { Dropdown } from './ui/Dropdown';
import type { DropdownItem } from './ui/Dropdown';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { SessionStatusBadge } from './SessionStatusBadge';
import { AgentActivityDot, AgentStatusDot } from './ui/AgentStatusDot';
import { useSessionAgentDisplayStatus } from '../hooks/useAgentStatus';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import { useSessionNavigationHotkeys } from '../hooks/useSessionNavigationHotkeys';
import { useRemoteRuntimeState } from '../hooks/useRemoteRuntimeState';
import { useAppBuildInfo } from '../hooks/useAppBuildInfo';
import { CompactSessionMenu, type CompactSessionMenuState } from './CompactSessionMenu';
import { getRemoteFooterStatus } from '../utils/remoteRuntimePresentation';
import { usePanelStore } from '../stores/panelStore';
import { rollupAgentDisplayStatus, rollupSessionAgentState, toAgentDisplayStatus } from '../utils/agentStatus';
import { createProjectById, getPinnedSessions, groupSessionsByProject } from '../utils/sessionOrdering';
import { DiscordIcon } from './DiscordIcon';
import { OrchestrationSessionNav } from './OrchestrationSessionNav';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';

// --- Collapsed sidebar tooltip content ---

function CollapsedProjectTooltip({ project, sessionCount }: { project: Project; sessionCount: number }) {
  return (
    <div className="max-w-xs space-y-1">
      <p className="text-[11px] text-text-primary font-medium">{project.name}</p>
      <p className="text-[10px] text-text-tertiary font-mono break-all">{project.path}</p>
      <p className="text-[10px] text-text-tertiary">
        {sessionCount} {sessionCount === 1 ? 'workspace' : 'workspaces'}
      </p>
    </div>
  );
}

function CompactSessionTooltip({
  session,
  label,
}: {
  session: Session;
  label: string;
}) {
  return (
    <div className="max-w-xs space-y-1.5">
      <p className="text-[11px] font-medium leading-snug text-text-primary whitespace-pre-wrap break-words">
        {label}
      </p>
      <div className="border-t border-border-primary" />
      <SessionDetailTooltip session={session} showName={false} />
    </div>
  );
}

interface SidebarProps {
  onAboutClick: () => void;
  onSettingsClick: () => void;
  onRemoteSettingsClick: () => void;
  width: number;
  onResize: (e: React.MouseEvent) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Title-bar slot the toggle and menu render into; null keeps them in the sidebar header. */
  titleBarControlsSlot?: HTMLDivElement | null;
  onHelpClick: () => void;
  onDocsClick: () => void;
  onFeedbackClick: () => void;
  onDiscordClick: () => void;
}

const REMOTE_DESKTOP_URL = 'https://remotedesktop.google.com/access';
const REMOTE_DESKTOP_TOOLTIP = 'Use Remote Desktop to access the host device for Electron apps, native windows, and UI running on the remote machine.';
type SidebarSection = 'pinned' | 'repositories';
const COMPACT_RAIL_BUTTON = 'relative flex h-9 min-h-9 w-9 min-w-9 shrink-0 items-center justify-center rounded transition-colors focus:outline-none focus:ring-2 focus:ring-interactive';
const COMPACT_RAIL_IDLE = 'text-text-tertiary hover:bg-surface-hover hover:text-text-primary';
const COMPACT_RAIL_ACTIVE = 'bg-surface-selected text-text-primary';


const HelpCircleIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

export function Sidebar({ onAboutClick, onSettingsClick, onRemoteSettingsClick, width, onResize, collapsed, onToggleCollapse, titleBarControlsSlot, onHelpClick, onDocsClick, onFeedbackClick, onDiscordClick }: SidebarProps) {
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);
  const { version, gitCommit, worktreeName } = useAppBuildInfo();
  const [sessionSortAscending, setSessionSortAscending] = useState<boolean>(true); // Default to ascending (newest at bottom)
  const [sidebarSectionExpansion, setSidebarSectionExpansion] = useState<Record<SidebarSection, boolean>>({
    pinned: true,
    repositories: true,
  });
  const { connectionState: remoteConnectionState, hostState: remoteHostState } = useRemoteRuntimeState();
  const hydrateExpandedProjects = useNavigationStore(s => s.hydrateExpandedProjects);

  useEffect(() => {
    let cancelled = false;

    const loadUIState = async () => {
      try {
        const result = await window.electronAPI.uiState.getExpanded();
        if (cancelled) return;
        if (result.success && result.data) {
          setSessionSortAscending(result.data.sessionSortAscending ?? true);
          hydrateExpandedProjects(result.data.expandedProjects ?? []);
          setSidebarSectionExpansion({
            pinned: result.data.pinnedSectionExpanded ?? true,
            repositories: result.data.repositoriesSectionExpanded ?? true,
          });
        }
      } catch (error) {
        console.error('Failed to load UI state:', error);
      }
    };

    void loadUIState();

    return () => {
      cancelled = true;
    };
  }, [hydrateExpandedProjects]);

  const toggleSessionSortOrder = async () => {
    const newValue = !sessionSortAscending;
    setSessionSortAscending(newValue);

    // Save to database via electronAPI
    try {
      await window.electronAPI.uiState.saveSessionSortAscending(newValue);
    } catch (error) {
      console.error('Failed to save session sort order:', error);
    }
  };

  const handleSidebarSectionExpandedChange = useCallback((section: SidebarSection, expanded: boolean) => {
    setSidebarSectionExpansion(prev => ({
      ...prev,
      [section]: expanded,
    }));

    void window.electronAPI.uiState.saveSidebarSectionExpanded(section, expanded).catch(error => {
      console.error('Failed to save sidebar section expanded state:', error);
    });
  }, []);

  const handlePinnedSectionExpandedChange = useCallback((expanded: boolean) => {
    handleSidebarSectionExpandedChange('pinned', expanded);
  }, [handleSidebarSectionExpandedChange]);

  const addRepositoryRef = useRef<(() => void) | null>(null);
  const registerAddRepository = useCallback((open: () => void) => {
    addRepositoryRef.current = open;
  }, []);

  const handleRepositoriesSectionExpandedChange = useCallback((expanded: boolean) => {
    handleSidebarSectionExpandedChange('repositories', expanded);
  }, [handleSidebarSectionExpandedChange]);



  const sessions = useSessionStore((state) => state.sessions);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const setActiveSession = useSessionStore((state) => state.setActiveSession);
  const remoteFooterStatus = useMemo(
    () => getRemoteFooterStatus(remoteConnectionState, remoteHostState),
    [remoteConnectionState, remoteHostState],
  );
  const remoteFooterTooltip = (
    <div className="max-w-[260px] space-y-1">
      <p className="text-[11px] font-medium text-text-primary">{remoteFooterStatus.title}</p>
      <p className="text-[10px] text-text-tertiary">{remoteFooterStatus.description}</p>
    </div>
  );
  const showRemoteDesktopLink = remoteConnectionState.mode === 'remote' && remoteConnectionState.status === 'connected';
  const handleOpenRemoteDesktop = useCallback(() => {
    void window.electronAPI.openExternal(REMOTE_DESKTOP_URL).catch(error => {
      console.error('Failed to open Remote Desktop:', error);
    });
  }, []);

  // State for collapsed sidebar
  const [projects, setProjects] = useState<Project[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [compactSessionMenu, setCompactSessionMenu] = useState<CompactSessionMenuState | null>(null);
  const activeProjectId = useNavigationStore((state) => state.activeProjectId);
  const activeView = useNavigationStore((state) => state.activeView);
  const expandedProjects = useNavigationStore((state) => state.expandedProjects);
  const navigateToProject = useNavigationStore((state) => state.navigateToProject);
  const navigateToSessions = useNavigationStore((state) => state.navigateToSessions);
  const navigateToPaneChat = useNavigationStore((state) => state.navigateToPaneChat);
  const paneChatStatus = useSessionAgentDisplayStatus(PANE_CHAT_SESSION_ID);
  const orchestrationAvailability = useOrchestrationSessionStore((state) => state.availability);
  const loadOrchestrationSessions = useOrchestrationSessionStore((state) => state.load);
  const setSidebarNavigationScope = useNavigationStore((state) => state.setSidebarNavigationScope);
  const agentStatusByPanel = usePanelStore((state) => state.agentStatus);
  const agentPanelSessions = usePanelStore((state) => state.agentStatusSession);
  const unviewedBySession = usePanelStore((state) => state.unviewedCompletedActivity);
  useSessionNavigationHotkeys({ projects, sessionSortAscending });

  useEffect(() => {
    void loadOrchestrationSessions();
  }, [loadOrchestrationSessions]);

  const handleRefreshGitStatus = async () => {
    try {
      if (activeProjectId) {
        await window.electronAPI.projects.refreshGitStatus(activeProjectId);
      }
    } catch (error) {
      console.error('Failed to refresh git status:', error);
    }
  };

  const loadProjects = useCallback(async () => {
    try {
      const response = await API.projects.getAll();
      if (response.success && response.data) {
        setProjects(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  }, []);

  // Fetch projects for collapsed sidebar rendering and always-mounted session hotkeys.
  useEffect(() => {
    loadProjects();
    window.addEventListener('project-changed', loadProjects);
    window.addEventListener('project-sessions-refresh', loadProjects);
    return () => {
      window.removeEventListener('project-changed', loadProjects);
      window.removeEventListener('project-sessions-refresh', loadProjects);
    };
  }, [loadProjects]);

  const activeProject = useMemo(() => {
    if (activeProjectId) return projects.find(p => p.id === activeProjectId);
    return projects.find(p => p.active) || projects[0];
  }, [projects, activeProjectId]);

  const sessionsByProject = useMemo(
    () => groupSessionsByProject(sessions, sessionSortAscending),
    [sessions, sessionSortAscending],
  );
  const projectById = useMemo(() => createProjectById(projects), [projects]);
  const pinnedSessions = useMemo(
    () => getPinnedSessions(sessions, projectById),
    [sessions, projectById],
  );

  const openCompactSession = useCallback((sessionId: string, scope: 'pinned' | 'repositories') => {
    setCompactSessionMenu(null);
    setSidebarNavigationScope(scope);
    void setActiveSession(sessionId);
    navigateToSessions();
  }, [navigateToSessions, setActiveSession, setSidebarNavigationScope]);

  const openCompactSessionMenu = useCallback((event: React.MouseEvent, session: Session) => {
    event.preventDefault();
    event.stopPropagation();
    setCompactSessionMenu({ session, x: event.clientX, y: event.clientY });
  }, []);

  const archiveCompactSession = useCallback(async () => {
    if (!compactSessionMenu) return;
    const { id } = compactSessionMenu.session;
    setCompactSessionMenu(null);
    try {
      await API.sessions.delete(id);
    } catch (error) {
      console.error('Failed to archive session:', error);
    }
  }, [compactSessionMenu]);

  const toggleCompactSessionPinned = useCallback(async () => {
    if (!compactSessionMenu) return;
    const { id } = compactSessionMenu.session;
    setCompactSessionMenu(null);
    try {
      await API.sessions.toggleFavorite(id);
    } catch (error) {
      console.error('Failed to toggle pinned session:', error);
    }
  }, [compactSessionMenu]);

  const sidebarMenuItems = [
        {
          id: 'home',
          label: 'Home',
          icon: Home,
          onClick: () => {
            setSidebarNavigationScope('repositories');
            void setActiveSession(null);
            navigateToSessions();
          }
        },
        {
          id: 'help',
          label: 'Help',
          icon: HelpCircleIcon,
          onClick: onHelpClick
        },
        {
          id: 'settings',
          label: 'Settings',
          icon: SettingsIcon,
          onClick: onSettingsClick
        },
        {
          id: 'sort',
          label: sessionSortAscending ? 'Sort: Oldest first' : 'Sort: Newest first',
          icon: ArrowUpDown,
          onClick: toggleSessionSortOrder
        },
        {
          id: 'refresh',
          label: 'Refresh git status',
          icon: RefreshCw,
          onClick: handleRefreshGitStatus
        },
        {
          id: 'remote',
          label: 'Remote',
          description: remoteFooterStatus.title,
          descriptionInTooltip: true,
          icon: Monitor,
          showDot: true,
          dotColor: remoteFooterStatus.dotClassName,
          onClick: onRemoteSettingsClick
        },
        {
          id: 'feedback',
          label: 'Feedback',
          icon: MessageSquare,
          onClick: onFeedbackClick
        },
        {
          id: 'discord',
          label: 'Discord',
          icon: DiscordIcon,
          onClick: onDiscordClick
        },
        {
          id: 'docs',
          label: 'Docs',
          icon: BookOpen,
          onClick: onDocsClick
        },
        {
          id: 'about',
          label: 'About Pane',
          description: [version ? `v${version}` : undefined, worktreeName, gitCommit].filter(Boolean).join(' · ') || undefined,
          descriptionInTooltip: true,
          icon: Info,
          onClick: onAboutClick
        }
  ] satisfies DropdownItem[];

  // The sidebar toggle stays beside the window controls; the menu lives in
  // the sidebar footer so tabs can use the title strip.
  const headerControls = (
    <>
      {onToggleCollapse && (
        <Tooltip content={hotkeyDisplay('toggle-sidebar') ? <Kbd>{hotkeyDisplay('toggle-sidebar')}</Kbd> : undefined} side="bottom">
          <IconButton
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            size="sm"
            icon={collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          />
        </Tooltip>
      )}
    </>
  );

  if (collapsed) {
    return (
      <>
        <div
          data-testid="sidebar"
          className="pane-sidebar-shell pane-sidebar-shell-collapsed bg-surface-secondary text-text-primary h-full flex flex-col flex-shrink-0"
          style={{ width: '48px' }}
        >
          {titleBarControlsSlot && createPortal(headerControls, titleBarControlsSlot)}
          {titleBarControlsSlot && <div className="h-[38px] flex-shrink-0" />}

          <div className="flex shrink-0 flex-col items-center gap-1 border-b border-border-primary py-2">
            <Tooltip content="Home" side="right">
              <button
                type="button"
                data-compact-rail-item
                onClick={() => {
                  setSidebarNavigationScope('repositories');
                  void setActiveSession(null);
                  navigateToSessions();
                }}
                aria-label="Home"
                className={`${COMPACT_RAIL_BUTTON} ${activeView === 'sessions' && !activeSessionId ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
              >
                <Home className="h-4 w-4" />
              </button>
            </Tooltip>

            {orchestrationAvailability === 'ready' || orchestrationAvailability === 'loading' || orchestrationAvailability === 'error' ? (
              <OrchestrationSessionNav compact />
            ) : (
              <Tooltip content="Pane Chat" side="right">
                <button
                  type="button"
                  data-testid="compact-pane-chat"
                  data-compact-rail-item
                  onClick={() => {
                    setSidebarNavigationScope('repositories');
                    void setActiveSession(null);
                    navigateToPaneChat();
                  }}
                  aria-label="Pane Chat"
                  className={`${COMPACT_RAIL_BUTTON} ${activeView === 'pane-chat' ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
                >
                  <MessageSquare className="h-4 w-4" />
                  <AgentStatusDot status={paneChatStatus} size="sm" className="absolute right-0 top-0" />
                </button>
              </Tooltip>
            )}

            {showRemoteDesktopLink && (
              <Tooltip content={REMOTE_DESKTOP_TOOLTIP} side="right">
                <button
                  type="button"
                  data-compact-rail-item
                  onClick={handleOpenRemoteDesktop}
                  aria-label="Open Remote Desktop"
                  className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                >
                  <Monitor className="h-4 w-4" />
                </button>
              </Tooltip>
            )}
          </div>

          <nav
            aria-label="Compact sidebar"
            className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-2"
          >
            {pinnedSessions.length > 0 && (
              <div role="group" aria-label="Pinned panes" className="flex w-full shrink-0 flex-col items-center gap-0.5">
                <Tooltip content={`${sidebarSectionExpansion.pinned ? 'Collapse' : 'Expand'} pinned panes`} side="right">
                  <button
                    type="button"
                    data-testid="compact-pinned-toggle"
                    data-compact-rail-item
                    onClick={() => handlePinnedSectionExpandedChange(!sidebarSectionExpansion.pinned)}
                    aria-label={`${sidebarSectionExpansion.pinned ? 'Collapse' : 'Expand'} pinned panes`}
                    aria-expanded={sidebarSectionExpansion.pinned}
                    className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                  >
                    <Pin className="h-4 w-4" />
                    {sidebarSectionExpansion.pinned
                      ? <ChevronDown className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />
                      : <ChevronRight className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />}
                  </button>
                </Tooltip>

                {sidebarSectionExpansion.pinned && pinnedSessions.map(({ session, label }) => (
                  <Tooltip
                    key={`compact-pinned-${session.id}`}
                    content={<CompactSessionTooltip session={session} label={label} />}
                    side="right"
                    interactive
                  >
                    <button
                      type="button"
                      data-testid={`compact-pinned-pane-${session.id}`}
                      data-compact-rail-item
                      onClick={() => openCompactSession(session.id, 'pinned')}
                      onContextMenu={(event) => openCompactSessionMenu(event, session)}
                      aria-label={`Open pinned pane ${label}`}
                      className={`${COMPACT_RAIL_BUTTON} ${session.id === activeSessionId && activeView === 'sessions' ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
                    >
                      <SessionStatusBadge
                        sessionId={session.id}
                        unknownFallback={(
                          <SquareTerminal
                            data-testid={`compact-pinned-pane-placeholder-${session.id}`}
                            aria-hidden="true"
                            className="h-4 w-4 text-text-tertiary"
                          />
                        )}
                      />
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}

            <div role="group" aria-label="Projects" className="flex w-full shrink-0 flex-col items-center gap-0.5">
              <Tooltip content={`${sidebarSectionExpansion.repositories ? 'Collapse' : 'Expand'} projects`} side="right">
                <button
                  type="button"
                  data-testid="compact-repositories-toggle"
                  data-compact-rail-item
                  onClick={() => handleRepositoriesSectionExpandedChange(!sidebarSectionExpansion.repositories)}
                  aria-label={`${sidebarSectionExpansion.repositories ? 'Collapse' : 'Expand'} projects`}
                  aria-expanded={sidebarSectionExpansion.repositories}
                  className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                >
                  <FolderGit2 className="h-4 w-4" />
                  {sidebarSectionExpansion.repositories
                    ? <ChevronDown className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />
                    : <ChevronRight className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5" />}
                </button>
              </Tooltip>

              {sidebarSectionExpansion.repositories && projects.map((project) => {
                const isActiveProject = project.id === activeProject?.id && activeView === 'project';
                const initial = project.name.charAt(0).toUpperCase();
                const projectSessions = sessionsByProject.get(project.id) ?? [];
                const projectAgentState = rollupAgentDisplayStatus(
                  projectSessions.map(session => toAgentDisplayStatus(
                    rollupSessionAgentState(agentStatusByPanel, agentPanelSessions, session.id),
                    Boolean(unviewedBySession[session.id]),
                  )),
                );

                return (
                  <div key={project.id} className="flex w-full shrink-0 flex-col items-center gap-0.5">
                    <Tooltip content={<CollapsedProjectTooltip project={project} sessionCount={projectSessions.length} />} side="right">
                      <button
                        type="button"
                        data-testid={`compact-repository-${project.id}`}
                        data-compact-rail-item
                        onClick={() => navigateToProject(project.id)}
                        aria-label={`Open main workspace for ${project.name}`}
                        className={`${COMPACT_RAIL_BUTTON} text-xs font-semibold ${isActiveProject ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
                      >
                        {initial}
                        {projectAgentState === 'unknown'
                          ? <AgentActivityDot active={false} size="sm" className="absolute bottom-0 right-0" />
                          : <AgentStatusDot status={projectAgentState} size="sm" className="absolute bottom-0 right-0" />}
                      </button>
                    </Tooltip>

                    {expandedProjects.has(project.id) && projectSessions.map((session) => (
                      <Tooltip
                        key={session.id}
                        content={<CompactSessionTooltip session={session} label={session.name || 'Untitled'} />}
                        side="right"
                        interactive
                      >
                        <button
                          type="button"
                          data-testid={`compact-repository-pane-${session.id}`}
                          data-compact-rail-item
                          onClick={() => openCompactSession(session.id, 'repositories')}
                          onContextMenu={(event) => openCompactSessionMenu(event, session)}
                          aria-label={`Open pane ${project.name}/${session.name || 'Untitled'}`}
                          className={`${COMPACT_RAIL_BUTTON} ${session.id === activeSessionId && activeView === 'sessions' ? COMPACT_RAIL_ACTIVE : COMPACT_RAIL_IDLE}`}
                        >
                          <SessionStatusBadge
                            sessionId={session.id}
                            unknownFallback={(
                              <SquareTerminal
                                data-testid={`compact-repository-pane-placeholder-${session.id}`}
                                aria-hidden="true"
                                className="h-4 w-4 text-text-tertiary"
                              />
                            )}
                          />
                        </button>
                      </Tooltip>
                    ))}
                  </div>
                );
              })}

              {sidebarSectionExpansion.repositories && activeProject && (
                <Tooltip content={`New pane in ${activeProject.name}`} side="right">
                  <button
                    type="button"
                    data-compact-rail-item
                    onClick={() => setShowCreateDialog(true)}
                    aria-label={`New pane in ${activeProject.name}`}
                    className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE} hover:text-interactive`}
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </Tooltip>
              )}
            </div>
          </nav>

          {/* Bottom actions */}
          <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border-primary py-2">
            <Tooltip content={remoteFooterTooltip} side="right" interactive delay={250}>
              <button
                type="button"
                data-compact-rail-item
                onClick={onRemoteSettingsClick}
                aria-label={remoteFooterStatus.ariaLabel}
                className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${remoteFooterStatus.dotClassName}`} />
              </button>
            </Tooltip>
            <Tooltip content={hotkeyDisplay('open-settings') ? <Kbd>{hotkeyDisplay('open-settings')}</Kbd> : undefined} side="right">
              <button
                type="button"
                data-compact-rail-item
                onClick={onSettingsClick}
                aria-label="Settings"
                className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
              >
                <SettingsIcon className="h-4 w-4" />
              </button>
            </Tooltip>
            <Dropdown
              trigger={
                <button
                  type="button"
                  data-compact-rail-item
                  aria-label="Sidebar menu"
                  className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              }
              items={sidebarMenuItems}
              position="top-right"
              width="sm"
            />
            {!titleBarControlsSlot && (<>
              <Tooltip content={hotkeyDisplay('toggle-sidebar') ? <Kbd>{hotkeyDisplay('toggle-sidebar')}</Kbd> : undefined} side="right">
                <button
                  type="button"
                  data-compact-rail-item
                  onClick={onToggleCollapse}
                  aria-label="Expand sidebar"
                  className={`${COMPACT_RAIL_BUTTON} ${COMPACT_RAIL_IDLE}`}
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              </Tooltip>
            </>)}
          </div>
        </div>

        {showCreateDialog && activeProject && (
          <CreateSessionDialog
            isOpen={showCreateDialog}
            onClose={() => setShowCreateDialog(false)}
            projectName={activeProject.name}
            projectId={activeProject.id}
          />
        )}

        <CompactSessionMenu
          menu={compactSessionMenu}
          onClose={() => setCompactSessionMenu(null)}
          onTogglePinned={() => void toggleCompactSessionPinned()}
          onArchive={() => void archiveCompactSession()}
        />
      </>
    );
  }

  return (
    <>
      <div
        data-testid="sidebar"
        className="pane-sidebar-shell bg-surface-secondary text-text-primary h-full flex flex-col relative flex-shrink-0"
        style={{ width: `${width}px` }}
      >
        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize group z-10"
          onMouseDown={onResize}
        >
          {/* Visual indicator: the theme's border-hover tone, not the accent */}
          <div className="absolute inset-0 group-hover:bg-border-hover group-active:bg-border-hover" />
          {/* Larger grab area */}
          <div className="absolute -left-2 -right-2 top-0 bottom-0" />
        </div>
        {titleBarControlsSlot
          ? createPortal(headerControls, titleBarControlsSlot)
          : (
            <div className="flex h-8 items-center justify-end gap-0.5 px-1.5">
              {headerControls}
            </div>
          )}
        {titleBarControlsSlot && (
          <div className="flex h-[38px] flex-shrink-0">
            <div className="w-[136px] flex-shrink-0" />
            <div className="pane-drag-area min-w-0 flex-1" />
          </div>
        )}

        <button
          type="button"
          onClick={() => addRepositoryRef.current?.()}
          className="mx-2 mt-1 flex h-7 flex-shrink-0 items-center gap-2 rounded-md bg-surface-hover px-2 text-[13px] font-medium text-text-secondary hover:text-text-primary"
        >
          <Plus className="h-3.5 w-3.5 flex-shrink-0" />
          <span>New project</span>
        </button>

        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <ProjectSessionList
            projects={projects}
            onProjectsChange={setProjects}
            onProjectsRefresh={loadProjects}
            sessionSortAscending={sessionSortAscending}
            pinnedSectionExpanded={sidebarSectionExpansion.pinned}
            repositoriesSectionExpanded={sidebarSectionExpansion.repositories}
            onPinnedSectionExpandedChange={handlePinnedSectionExpandedChange}
            onRepositoriesSectionExpandedChange={handleRepositoriesSectionExpandedChange}
            onRegisterAddRepository={registerAddRepository}
            showRemoteDesktopLink={showRemoteDesktopLink}
            onRemoteDesktopClick={handleOpenRemoteDesktop}
            remoteDesktopTooltip={REMOTE_DESKTOP_TOOLTIP}
          />
        </div>

        {/* Archived sessions - pinned above bottom */}
        <div className="flex-shrink-0">
          <ArchivedSessions />
        </div>

        {/* Home opens the footer menu, with navigation and account actions together. */}
        <div className="flex h-12 flex-shrink-0 items-center gap-1 px-2">
          <Dropdown
            trigger={
              <button
                type="button"
                aria-label="Home menu"
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md bg-surface-hover/40 px-2 text-[13px] font-medium text-text-secondary hover:bg-surface-hover/60 hover:text-text-primary"
              >
                <Home className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 text-left">Home</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
              </button>
            }
            items={sidebarMenuItems}
            position="top-left"
            width="sm"
            className="min-w-0 flex-1"
          />
          <IconButton
            aria-label="Settings"
            onClick={onSettingsClick}
            size="sm"
            variant="ghost"
            icon={<SettingsIcon className="h-4 w-4" />}
          />
        </div>

        {/* Bottom section - always visible */}
        <div className="flex-shrink-0">
          {/* Archive progress indicator above version */}
          <ArchiveProgress />

        </div>
    </div>
    </>
  );
}
