import type { App, BrowserWindow } from 'electron';
import type { CoreServices } from '../core/services';
import type { TaskQueue } from '../services/taskQueue';
import type { AnalyticsManager } from '../services/analyticsManager';
import type { SpotlightManager } from '../services/spotlightManager';
import type { SessionPrMonitor } from '../services/sessionPrMonitor';
import type { WorkspaceJournal } from '../services/workspaceJournal';
import type { WorkspaceStateReader } from '../services/workspaceStateReader';
import type { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import type { WorkspaceWatchLeases } from '../services/workspaceWatchLeases';
import type { NamedLockService } from '../services/namedLockService';
import type { BackgroundActivity } from '../services/backgroundActivity';
import type { LoopManager } from '../services/loops/loopManager';
import type { SessionInbox } from '../services/sessionInbox';
import type { ExpectedReportTracker } from '../services/expectedReports';
import type { NotifyService } from '../services/notify/notifyService';
import type { MachineHealthService } from '../services/machineHealth/machineHealthService';
import type { CleanupEngine } from '../services/machineHealth/cleanupEngine';
import type { ApprovalStore } from '../services/approvals/approvalStore';
import type { JsonStoreImportOutcome } from '../database/jsonStoreImport';

export interface DaemonHostServices extends CoreServices {
  taskQueue: TaskQueue | null;
  getMainWindow: () => BrowserWindow | null;
  analyticsManager?: AnalyticsManager;
  spotlightManager: SpotlightManager;
  workspaceJournal?: WorkspaceJournal;
  sessionPrMonitor?: SessionPrMonitor;
  loopManager?: LoopManager;
  workspaceStateReader?: WorkspaceStateReader;
  workspaceCursorStore?: WorkspaceCursorStore;
  workspaceWatchLeases?: WorkspaceWatchLeases;
  namedLockService?: NamedLockService;
  /** Desktop only: whether Pane is away, so background checks that serve only the person's eyes pause. */
  backgroundActivity?: BackgroundActivity;
  sessionInbox?: SessionInbox;
  /** This machine's approvals (sessions.db). */
  approvalStore?: ApprovalStore;
  /** How moving session-inbox.json into it went on this start. */
  approvalImport?: JsonStoreImportOutcome;
  expectedReportTracker?: ExpectedReportTracker;
  notifyService?: NotifyService;
  /** Free disk, memory pressure and per-Pane process cost, sampled every minute. */
  machineHealth?: MachineHealthService;
  /** The one path machine health deletes through. */
  machineCleanup?: CleanupEngine;
}

export interface AppServices extends DaemonHostServices {
  app: App;
}
