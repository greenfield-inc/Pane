import type { App, BrowserWindow } from 'electron';
import type { CoreServices } from '../core/services';
import type { TaskQueue } from '../services/taskQueue';
import type { AnalyticsManager } from '../services/analyticsManager';
import type { SpotlightManager } from '../services/spotlightManager';
import type { WorkspaceJournal } from '../services/workspaceJournal';
import type { WorkspaceStateReader } from '../services/workspaceStateReader';
import type { WorkspaceCursorStore } from '../services/workspaceCursorStore';

export interface DaemonHostServices extends CoreServices {
  taskQueue: TaskQueue | null;
  getMainWindow: () => BrowserWindow | null;
  analyticsManager?: AnalyticsManager;
  spotlightManager: SpotlightManager;
  workspaceJournal: WorkspaceJournal;
  workspaceStateReader?: WorkspaceStateReader;
  workspaceCursorStore?: WorkspaceCursorStore;
}

export interface AppServices extends DaemonHostServices {
  app: App;
}
