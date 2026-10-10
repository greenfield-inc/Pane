import { DatabaseService } from '../database/database';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { decodeHostNavigationMemory } from '../../../shared/types/hostNavigation';
import type { HostNavigationMemory } from '../../../shared/types/hostNavigation';
import { decodeSessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import type { SessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import { decodeSessionPanelLayout } from '../../../shared/types/panels';
import type { SessionPanelLayout } from '../../../shared/types/panels';

type SidebarSection = 'pinned' | 'repositories' | 'sshHosts';

const SIDEBAR_SECTION_KEYS = {
  pinned: 'treeView.pinnedSectionExpanded',
  repositories: 'treeView.repositoriesSectionExpanded',
  sshHosts: 'treeView.sshHostsSectionExpanded'
} satisfies Record<SidebarSection, string>;

interface ExpandedUiState {
  expandedProjects: number[];
  expandedFolders: string[];
  sessionSortAscending: boolean;
  pinnedSectionExpanded: boolean;
  repositoriesSectionExpanded: boolean;
  sshHostsSectionExpanded: boolean;
}

type UiStateStore = Pick<DatabaseService, 'getUIState' | 'setUIState' | 'deleteUIState'>;

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
    if (!value) return true; // Default to ascending (newest at bottom)
    try {
      return JSON.parse(value);
    } catch {
      return true;
    }
  }

  getSidebarSectionExpanded(section: SidebarSection): boolean {
    const value = this.db.getUIState(SIDEBAR_SECTION_KEYS[section]);
    if (!value) return true;
    try {
      return decodeBoundary(JSON.parse(value), boundary.boolean);
    } catch {
      return true;
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

  getExpandedState(): ExpandedUiState {
    return {
      expandedProjects: this.getExpandedProjects(),
      expandedFolders: this.getExpandedFolders(),
      sessionSortAscending: this.getSessionSortAscending(),
      pinnedSectionExpanded: this.getSidebarSectionExpanded('pinned'),
      repositoriesSectionExpanded: this.getSidebarSectionExpanded('repositories'),
      sshHostsSectionExpanded: this.getSidebarSectionExpanded('sshHosts')
    };
  }

  clear(): void {
    this.db.deleteUIState('treeView.expandedProjects');
    this.db.deleteUIState('treeView.expandedFolders');
    this.db.deleteUIState('treeView.sessionSortAscending');
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.pinned);
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.repositories);
    this.db.deleteUIState(SIDEBAR_SECTION_KEYS.sshHosts);
  }
}

export { UIStateManager };
