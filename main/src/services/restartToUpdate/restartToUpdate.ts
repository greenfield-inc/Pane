import { app, powerMonitor, type BrowserWindow } from 'electron';
import { PaneError } from '../../../../shared/paneError';
import type {
  RestartToUpdateSource,
  RestartToUpdateState,
  RestoredNavigation,
  UpdateBusyState,
  UpdateRestoreResult,
} from '../../../../shared/types/updater';
import type { PanelAgentStatusEvent } from '../../../../shared/types/agentStatus';
import { getAppDirectory } from '../../utils/appDirectory';
import { getAutoUpdater } from '../../autoUpdater';
import { terminalPanelManager } from '../terminalPanelManager';
import { scriptExecutionTracker } from '../scriptExecutionTracker';
import type { ArchiveProgressManager } from '../archiveProgressManager';
import type { AnalyticsManager } from '../analyticsManager';
import type { DatabaseService } from '../../database/database';
import type { SessionManager } from '../sessionManager';
import type { ConfigManager } from '../configManager';
import type { AppConfig } from '../../types/config';
import { DEFAULT_UPDATE_IDLE_TIMING, UpdateIdleGate, type UpdateIdleTiming } from './updateIdleGate';
import { discardRestoreNote, takeRestoreNote, writeRestoreNote } from './restoreNote';

const TICK_MS = 15_000;

interface RestartToUpdateDeps {
  getMainWindow: () => BrowserWindow | null;
  configManager: ConfigManager;
  /** Where the user is now, saved into the restore note. */
  readNavigation: () => RestoredNavigation | null;
  archiveProgressManager?: ArchiveProgressManager;
}

interface RestoreDeps {
  sessionManager: SessionManager;
  databaseService: DatabaseService;
  analyticsManager?: AnalyticsManager;
}

let gate: UpdateIdleGate | null = null;
let readNavigation: () => RestoredNavigation | null = () => null;
let restoreTaken = false;

/** Shortened timers and the Tonight window, for local update testing only. */
function testTiming(): UpdateIdleTiming {
  if (process.env.TEST_UPDATES !== 'true') return DEFAULT_UPDATE_IDLE_TIMING;
  const seconds = (name: string, fallbackMs: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value * 1000 : fallbackMs;
  };
  const [start, end] = (process.env.PANE_TEST_UPDATE_TONIGHT_HOURS ?? '').split('-').map(Number);
  const hasWindow = Number.isInteger(start) && Number.isInteger(end);
  return {
    quietHoldMs: seconds('PANE_TEST_UPDATE_IDLE_SECONDS', DEFAULT_UPDATE_IDLE_TIMING.quietHoldMs),
    snoozeMs: DEFAULT_UPDATE_IDLE_TIMING.snoozeMs,
    tonightQuietMs: seconds('PANE_TEST_UPDATE_TONIGHT_IDLE_SECONDS', DEFAULT_UPDATE_IDLE_TIMING.tonightQuietMs),
    tonightInputIdleMs: seconds('PANE_TEST_UPDATE_TONIGHT_INPUT_IDLE_SECONDS', DEFAULT_UPDATE_IDLE_TIMING.tonightInputIdleMs),
    tonightStartHour: hasWindow ? start : DEFAULT_UPDATE_IDLE_TIMING.tonightStartHour,
    tonightEndHour: hasWindow ? end : DEFAULT_UPDATE_IDLE_TIMING.tonightEndHour,
  };
}

function isBusyAgentState(state: string | undefined): boolean {
  return state === 'working' || state === 'blocked';
}

function readBusy(archiveProgressManager?: ArchiveProgressManager): UpdateBusyState | null {
  const agentCount = terminalPanelManager.getAllPanelIds()
    .filter(panelId => isBusyAgentState(terminalPanelManager.getAgentStatus(panelId))).length;
  if (agentCount > 0) return { reason: 'agents', agentCount };
  if (scriptExecutionTracker.getRunningScript()) return { reason: 'run-script', agentCount };
  if (archiveProgressManager?.hasActiveTasks()) return { reason: 'archive', agentCount };
  return null;
}

/** Starts watching for idle time. Call once, after the main window exists. */
export function startRestartToUpdate({ getMainWindow, configManager, readNavigation: navigation, archiveProgressManager }: RestartToUpdateDeps): void {
  if (gate) return;
  readNavigation = navigation;
  const idleGate = new UpdateIdleGate({
    now: Date.now,
    readBusy: () => readBusy(archiveProgressManager),
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    restartTonight: () => {
      try {
        restartToUpdate('tonight');
      } catch (error) {
        console.error('[RestartToUpdate] Tonight restart failed:', error);
      }
    },
    timing: testTiming(),
  });
  gate = idleGate;
  idleGate.setEnabled(configManager.getConfig().autoCheckUpdates !== false);
  configManager.on('config-updated', (config: AppConfig) => idleGate.setEnabled(config.autoCheckUpdates !== false));
  idleGate.on('state', (state: RestartToUpdateState) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send('updater:restart-state', state);
  });
  terminalPanelManager.on('agent-status', (event: PanelAgentStatusEvent) => {
    if (isBusyAgentState(event.state)) idleGate.markBusy();
    else idleGate.tick();
  });
  setInterval(() => idleGate.tick(), TICK_MS).unref();
}

function requireGate(): UpdateIdleGate {
  if (!gate) throw new PaneError('UPDATE_NOT_STARTED', 'Restart to update is not ready yet because Pane is still starting.', 'Try again in a few seconds.');
  return gate;
}

export function setUpdateReady(version: string): void {
  gate?.setReady(version);
}

export function setUpdateAvailable(version: string): void {
  gate?.setAvailable(version);
}

export function getRestartToUpdateState(): RestartToUpdateState {
  return requireGate().getState();
}

export function snoozeRestartToUpdate(): RestartToUpdateState {
  requireGate().snooze();
  return requireGate().getState();
}

export function setRestartToUpdateTonight(enabled: boolean): RestartToUpdateState {
  requireGate().setTonight(enabled);
  return requireGate().getState();
}

/**
 * The one way Pane restarts into a downloaded update. Writes the restore note,
 * then quits through the normal shutdown, which marks running agents
 * interrupted so the next launch can resume them.
 */
export function restartToUpdate(source: RestartToUpdateSource): void {
  const toVersion = requireGate().getState().readyVersion;
  if (!toVersion) {
    throw new PaneError(
      'UPDATE_NOT_DOWNLOADED',
      'Pane cannot restart to update because no update has finished downloading.',
      'Open Settings and choose Check Now.',
    );
  }
  writeRestoreNote(getAppDirectory(), { source, fromVersion: app.getVersion(), toVersion, navigation: readNavigation() });
  if (!app.isPackaged && process.env.TEST_UPDATES === 'true') {
    // A dev build cannot install the update, so it relaunches in place to exercise the restore.
    app.relaunch();
    app.quit();
    return;
  }
  getAutoUpdater().quitAndInstall(false, true);
}

/** The quit was cancelled, so the next launch is not a restart to update. */
export function cancelRestartToUpdate(): void {
  discardRestoreNote(getAppDirectory());
}

/**
 * On the launch after a restart to update: resumes every interrupted agent in
 * every project and reports what came back. Returns the result to the first
 * caller only; null on any other launch.
 */
export async function takeUpdateRestoreResult({ sessionManager, databaseService, analyticsManager }: RestoreDeps): Promise<UpdateRestoreResult | null> {
  if (restoreTaken) return null;
  restoreTaken = true;
  const note = takeRestoreNote(getAppDirectory());
  if (!note) return null;

  const sessionIds = databaseService.getAllProjects()
    .flatMap(project => sessionManager.getResumableSessions(project.id))
    .map(session => session.sessionId);
  let panesFailed: number;
  try {
    panesFailed = (await sessionManager.resumeInterruptedSessions(sessionIds)).failedSessionIds.length;
  } catch (error) {
    console.error('[RestartToUpdate] Failed to resume Panes after the restart:', error);
    panesFailed = sessionIds.length;
  }

  const toVersion = app.getVersion();
  const result: UpdateRestoreResult = {
    source: note.source,
    fromVersion: note.fromVersion,
    toVersion,
    installed: toVersion !== note.fromVersion,
    panesRestored: databaseService.getAllSessions().length - panesFailed,
    panesFailed,
    navigation: note.navigation,
  };
  analyticsManager?.track('update_restart_restored', {
    source: result.source,
    from_version: result.fromVersion,
    to_version: result.toVersion,
    installed: result.installed,
    panes_restored: result.panesRestored,
    panes_failed: result.panesFailed,
  });
  return result;
}
