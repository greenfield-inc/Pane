import type { App, BrowserWindow } from 'electron';
import type { CoreServices } from '../core/services';
import type { TaskQueue } from '../services/taskQueue';
import type { AnalyticsManager } from '../services/analyticsManager';
import type { SpotlightManager } from '../services/spotlightManager';
import type { SessionPrMonitor } from '../services/sessionPrMonitor';
import type { WorkspaceJournal } from '../services/workspaceJournal';
import type { WorkspaceStateReader } from '../services/workspaceStateReader';
import type { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import type { NamedLockService } from '../services/namedLockService';
import type { SessionInbox } from '../services/sessionInbox';
import type { ExpectedReportTracker } from '../services/expectedReports';

export interface DaemonHostServices extends CoreServices {
  taskQueue: TaskQueue | null;
  getMainWindow: () => BrowserWindow | null;
  analyticsManager?: AnalyticsManager;
  spotlightManager: SpotlightManager;
  workspaceJournal?: WorkspaceJournal;
  sessionPrMonitor?: SessionPrMonitor;
  workspaceStateReader?: WorkspaceStateReader;
  workspaceCursorStore?: WorkspaceCursorStore;
  namedLockService?: NamedLockService;
  sessionInbox?: SessionInbox;
  expectedReportTracker?: ExpectedReportTracker;
}

export interface AppServices extends DaemonHostServices {
  app: App;
}
