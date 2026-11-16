import { existsSync } from 'node:fs';
import { DatabaseService } from '../database/database';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { decodeHostNavigationMemory } from '../../../shared/types/hostNavigation';
import type { HostNavigationMemory, LaunchChat, LaunchChatOutline } from '../../../shared/types/hostNavigation';
import { getDockTerminalPanel } from '../../../shared/utils/terminalDock';
import type { ToolPanel } from '../../../shared/types/panels';
import { decodeSessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import type { SessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import { decodeSessionPanelLayout } from '../../../shared/types/panels';
import type { PanelLayoutNode, SessionPanelLayout } from '../../../shared/types/panels';

type SidebarSection = 'pinned' | 'repositories' | 'sshHosts' | 'sessions' | 'archived';

const SIDEBAR_SECTION_KEYS = {
  pinned: 'treeView.pinnedSectionExpanded',
  repositories: 'treeView.repositoriesSectionExpanded',
  sshHosts: 'treeView.sshHostsSectionExpanded',
  sessions: 'treeView.sessionsSectionExpanded',
  archived: 'treeView.archivedSectionExpanded'
} satisfies Record<SidebarSection, string>;

interface ExpandedUiState {
  expandedProjects: number[];
  expandedFolders: string[];
  sessionSortAscending: boolean;
  pinnedSectionExpanded: boolean;
  repositoriesSectionExpanded: boolean;
  sshHostsSectionExpanded: boolean;
  sessionsSectionExpanded: boolean;
  expandedSessions: string[];
  archivedSectionExpanded: boolean;
  expandedArchivedProjects: number[];
}

type UiStateStore = Pick<DatabaseService, 'getUIState' | 'setUIState' | 'deleteUIState'>;

/** What the launch check reads about a Pane and its tabs. */
interface LaunchPanes {
  getSession(id: string): { archived?: boolean; worktree_path: string } | undefined;
  getPanel(id: string): { sessionId: string; type: string } | null;
}

/** The launch outline also reads the Pane's tabs, for its terminal strip. */
interface LaunchOutlinePanes extends LaunchPanes {
  getPanelsForSession(sessionId: string): ToolPanel[];
}

function groupTab(node: PanelLayoutNode, groupId: string | undefined): string | null {
  if (node.type === 'group') return !groupId || node.id === groupId ? node.activePanelId : null;
  for (const child of node.children) {
    const tab = groupTab(child, groupId);
    if (tab) return tab;
  }
  return null;
}

class UIStateManager {
  private db: UiStateStore;

  /** `getRemoteHostId` names the active remote host, or returns null for this computer. */
  constructor(db: UiStateStore, private readonly getRemoteHostId: () => string | null = () => null) {
    this.db = db;
  }

  // Repository ids are per host, so each remote host keeps its own expanded repositories.
  private expandedProjectsKey(): string {
    const hostId = this.getRemoteHostId();
    return hostId ? `treeView.expandedProjects@${hostId}` : 'treeView.expandedProjects';
  }

  getExpandedProjects(): number[] {
    const value = this.db.getUIState(this.expandedProjectsKey());
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  // Session ids are per host too, so each host keeps the Sessions you opened. A Session not in
  // the list shows collapsed. The older `treeView.collapsedSessions` rows are left unread: they
  // only recorded collapses, so they cannot say which Sessions were opened on purpose.
  private expandedSessionsKey(): string {
    const hostId = this.getRemoteHostId();
    return hostId ? `treeView.expandedSessions@${hostId}` : 'treeView.expandedSessions';
  }

  getExpandedSessions(): string[] {
    const value = this.db.getUIState(this.expandedSessionsKey());
    if (!value) return [];
    try {
      return decodeBoundary(JSON.parse(value), boundary.array(boundary.string));
    } catch {
      return [];
    }
  }

  saveExpandedSessions(sessionIds: string[]): void {
    this.db.setUIState(this.expandedSessionsKey(), JSON.stringify(sessionIds));
  }

  // Archived groups are keyed by repository id, so they are per host like expanded repositories.
  private expandedArchivedProjectsKey(): string {
    const hostId = this.getRemoteHostId();
    return hostId ? `treeView.expandedArchivedProjects@${hostId}` : 'treeView.expandedArchivedProjects';
  }

  getExpandedArchivedProjects(): number[] {
    const value = this.db.getUIState(this.expandedArchivedProjectsKey());
    if (!value) return [];
    try {
      return decodeBoundary(JSON.parse(value), boundary.array(boundary.number));
    } catch {
      return [];
    }
  }

  saveExpandedArchivedProjects(projectIds: number[]): void {
    this.db.setUIState(this.expandedArchivedProjectsKey(), JSON.stringify(projectIds));
  }

  getExpandedFolders(): string[] {
    const value = this.db.getUIState('treeView.expandedFolders');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  getSessionSortAscending(): boolean {
    const value = this.db.getUIState('treeView.sessionSortAscending');
    // Unset means the person never chose: newest first. A saved value is their choice.
    if (!value) return false;
    try {
      return JSON.parse(value);
    } catch {
      return false;
    }
  }

  // Sections start open, except Archived.
  getSidebarSectionExpanded(section: SidebarSection): boolean {
    const fallback = section !== 'archived';
    const value = this.db.getUIState(SIDEBAR_SECTION_KEYS[section]);
    if (!value) return fallback;
    try {
      return decodeBoundary(JSON.parse(value), boundary.boolean);
    } catch {
      return fallback;
    }
  }

  saveExpandedProjects(projectIds: number[]): void {
    this.db.setUIState(this.expandedProjectsKey(), JSON.stringify(projectIds));
  }

  saveExpandedFolders(folderIds: string[]): void {
    this.db.setUIState('treeView.expandedFolders', JSON.stringify(folderIds));
  }

  saveSessionSortAscending(ascending: boolean): void {
    this.db.setUIState('treeView.sessionSortAscending', JSON.stringify(ascending));
  }

  saveSidebarSectionExpanded(section: SidebarSection, expanded: boolean): void {
    this.db.setUIState(SIDEBAR_SECTION_KEYS[section], JSON.stringify(expanded));
  }

  saveExpandedState(projectIds: number[], folderIds: string[]): void {
    this.saveExpandedProjects(projectIds);
    this.saveExpandedFolders(folderIds);
  }

  // Unlike the keys above, navigation memory takes the host id from the caller:
  // the renderer still shows the outgoing host while main has already switched
  // to the incoming one, so only the renderer knows which host a location
  // belongs to. Both sides resolve the id with getActiveRemoteHostId.
  private navigationMemoryKey(hostId: string | null): string {
    return hostId ? `navigation.lastLocation@${hostId}` : 'navigation.lastLocation';
  }

  getNavigationMemory(hostId: string | null): HostNavigationMemory | null {
    const value = this.db.getUIState(this.navigationMemoryKey(hostId));
    if (!value) return null;
    try {
      return decodeHostNavigationMemory(JSON.parse(value));
    } catch {
      return null;
    }
  }

  saveNavigationMemory(hostId: string | null, memory: HostNavigationMemory): void {
    this.db.setUIState(this.navigationMemoryKey(hostId), JSON.stringify(memory));
  }

  // How the window was divided between that host's Sessions. The sibling of
  // navigation memory: once Sessions can be tiled, "where you were" is a layout
  // as well as a location, and it takes the host id from the caller for the
  // same reason.
  private sessionWorkspaceLayoutKey(hostId: string | null): string {
    return hostId ? `sessions.workspaceLayout@${hostId}` : 'sessions.workspaceLayout';
  }

  getSessionWorkspaceLayout(hostId: string | null): SessionWorkspaceLayout | null {
    const value = this.db.getUIState(this.sessionWorkspaceLayoutKey(hostId));
    if (!value) return null;
    try {
      return decodeSessionWorkspaceLayout(JSON.parse(value));
    } catch {
      return null;
    }
  }

  /** A null layout clears the memory: this host has nothing tiled worth keeping. */
  saveSessionWorkspaceLayout(hostId: string | null, layout: SessionWorkspaceLayout | null): void {
    const key = this.sessionWorkspaceLayoutKey(hostId);
    if (!layout) {
      this.db.deleteUIState(key);
      return;
    }
    this.db.setUIState(key, JSON.stringify(layout));
  }

  // This computer's own split and tabs for one Pane. The host keeps the layout
  // last used by any client; this copy is what this desktop shows when it
  // returns. Keyed by host like navigation memory, for the same reason.
  private paneLayoutKey(hostId: string | null, paneId: string): string {
    return hostId ? `paneLayout.${paneId}@${hostId}` : `paneLayout.${paneId}`;
  }

  getPaneLayout(hostId: string | null, paneId: string): SessionPanelLayout | null {
    const value = this.db.getUIState(this.paneLayoutKey(hostId, paneId));
    if (!value) return null;
    try {
      return decodeSessionPanelLayout(JSON.parse(value));
    } catch {
      return null;
    }
  }

  /** A null layout forgets the Pane, as when it is archived or deleted. */
  savePaneLayout(hostId: string | null, paneId: string, layout: SessionPanelLayout | null): void {
    const key = this.paneLayoutKey(hostId, paneId);
    if (!layout) {
      this.db.deleteUIState(key);
      return;
    }
    this.db.setUIState(key, JSON.stringify(layout));
  }

  /**
   * The chat a launch reopens: the tab that was in front in the last Pane this
   * computer showed, when that tab is a chat. Null (launch shows Home) for any
   * other last view, a terminal tab, an archived Pane, a Pane whose folder is
   * gone, or while another computer is the active host. Restoring a Pane only
   * for a chat keeps launch from starting terminals: a chat starts its agent
   * when shown, and only the tab in front is shown.
   */
  getLaunchChat(panes: LaunchPanes): LaunchChat | null {
    if (this.getRemoteHostId() !== null) return null;
    const memory = this.getNavigationMemory(null);
    if (memory?.view !== 'sessions' || !memory.paneId) return null;
    const pane = panes.getSession(memory.paneId);
    if (!pane || pane.archived || !existsSync(pane.worktree_path)) return null;
    const layout = this.getPaneLayout(null, memory.paneId);
    if (!layout) return null;
    const panelId = groupTab(layout.root, layout.focusedGroupId) ?? groupTab(layout.root, undefined);
    const panel = panelId ? panes.getPanel(panelId) : null;
    if (!panelId || panel?.sessionId !== memory.paneId || panel.type !== 'chat') return null;
    return { paneId: memory.paneId, panelId };
  }

  /** The launch chat for the window's first frame, when its Pane shows one group of tabs. */
  getLaunchChatOutline(panes: LaunchOutlinePanes): LaunchChatOutline | null {
    const chat = this.getLaunchChat(panes);
    if (!chat || this.getPaneLayout(null, chat.paneId)?.root.type !== 'group') return null;
    return { panelId: chat.panelId, dockTerminal: !!getDockTerminalPanel(panes.getPanelsForSession(chat.paneId)) };
  }

  getExpandedState(): ExpandedUiState {
    return {
      expandedProjects: this.getExpandedProjects(),
      expandedFolders: this.getExpandedFolders(),
      sessionSortAscending: this.getSessionSortAscending(),
      pinnedSectionExpanded: this.getSidebarSectionExpanded('pinned'),
      repositoriesSectionExpanded: this.getSidebarSectionExpanded('repositories'),
      sshHostsSectionExpanded: this.getSidebarSectionExpanded('sshHosts'),
      sessionsSectionExpanded: this.getSidebarSectionExpanded('sessions'),
      expandedSessions: this.getExpandedSessions(),
      archivedSectionExpanded: this.getSidebarSectionExpanded('archived'),
      expandedArchivedProjects: this.getExpandedArchivedProjects()
    };
  }

  clear(): void {
    this.db.deleteUIState('treeView.expandedProjects');
    this.db.deleteUIState('treeView.expandedFolders');
    this.db.deleteUIState('treeView.sessionSortAscending');
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.pinned);
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.repositories);
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.sshHosts);
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.sessions);
    this.db.deleteUIState('treeView.expandedSessions');
    this.db.deleteUIState('treeView.collapsedSessions');
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.archived);
    this.db.deleteUIState('treeView.expandedArchivedProjects');
  }
}

export { UIStateManager };
