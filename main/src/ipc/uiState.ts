import { ipcMain } from 'electron';
import { UIStateManager } from '../services/uiStateManager';
import type { AppServices } from './types';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { decodeHostNavigationMemory } from '../../../shared/types/hostNavigation';
import type { HostNavigationMemory } from '../../../shared/types/hostNavigation';
import { decodeSessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import type { SessionWorkspaceLayout } from '../../../shared/types/sessionWorkspaceLayout';
import { decodeSessionPanelLayout } from '../../../shared/types/panels';
import type { SessionPanelLayout } from '../../../shared/types/panels';

export function registerUIStateHandlers(services: AppServices) {
  const uiStateManager = new UIStateManager(
    services.databaseService,
    () => getActiveRemoteHostId(services.configManager.getConfig().remoteDaemon),
  );

  ipcMain.handle('ui-state:get-expanded', async () => {
    try {
      return {
        success: true,
        data: uiStateManager.getExpandedState()
      };
    } catch (error) {
      console.error('Error getting expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-expanded', async (_, projectIds: number[], folderIds: string[]) => {
    try {
      uiStateManager.saveExpandedState(projectIds, folderIds);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-expanded-projects', async (_, projectIds: number[]) => {
    try {
      uiStateManager.saveExpandedProjects(projectIds);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving expanded projects:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-expanded-folders', async (_, folderIds: string[]) => {
    try {
      uiStateManager.saveExpandedFolders(folderIds);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving expanded folders:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-session-sort-ascending', async (_, ascending: boolean) => {
    try {
      uiStateManager.saveSessionSortAscending(ascending);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving session sort order:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-sidebar-section-expanded', async (_, section: 'pinned' | 'repositories', expanded: boolean) => {
    try {
      if (section !== 'pinned' && section !== 'repositories') {
        throw new Error(`Invalid sidebar section: ${section}`);
      }

      uiStateManager.saveSidebarSectionExpanded(section, expanded);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving sidebar section expanded state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // The renderer names the host: it can still be showing the outgoing one while
  // this process has already switched runtimes. Null means this computer.
  ipcMain.handle('ui-state:get-navigation-memory', async (_, hostId: string | null) => {
    try {
      return {
        success: true,
        data: uiStateManager.getNavigationMemory(hostId)
      };
    } catch (error) {
      console.error('Error getting host navigation memory:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:get-session-workspace-layout', async (_, hostId: string | null) => {
    try {
      return {
        success: true,
        data: uiStateManager.getSessionWorkspaceLayout(hostId)
      };
    } catch (error) {
      console.error('Error getting Session workspace layout:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-session-workspace-layout', async (_, hostId: string | null, layout: SessionWorkspaceLayout | null) => {
    try {
      // Decoded on the way in, so a stored layout is always readable back and a
      // tree past the tile or depth bounds never reaches the database.
      const decoded = layout === null ? null : decodeSessionWorkspaceLayout(layout);
      if (layout !== null && !decoded) {
        throw new Error('Invalid Session workspace layout');
      }
      uiStateManager.saveSessionWorkspaceLayout(hostId, decoded);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving Session workspace layout:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:get-pane-layout', async (_, hostId: string | null, paneId: string) => {
    try {
      return {
        success: true,
        data: uiStateManager.getPaneLayout(hostId, paneId)
      };
    } catch (error) {
      console.error('Error getting Pane layout memory:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-pane-layout', async (_, hostId: string | null, paneId: string, layout: SessionPanelLayout | null) => {
    try {
      // Decoded on the way in, so a stored layout is always readable back.
      const decoded = layout === null ? null : decodeSessionPanelLayout(layout);
      if (!paneId || (layout !== null && !decoded)) {
        throw new Error('Invalid Pane layout');
      }
      uiStateManager.savePaneLayout(hostId, paneId, decoded);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving Pane layout memory:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  ipcMain.handle('ui-state:save-navigation-memory', async (_, hostId: string | null, memory: HostNavigationMemory) => {
    try {
      // Decoded on the way in so a stored location is always readable back.
      const decoded = decodeHostNavigationMemory(memory);
      if (!decoded) {
        throw new Error('Invalid host navigation memory');
      }
      uiStateManager.saveNavigationMemory(hostId, decoded);
      return {
        success: true
      };
    } catch (error) {
      console.error('Error saving host navigation memory:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });
}
