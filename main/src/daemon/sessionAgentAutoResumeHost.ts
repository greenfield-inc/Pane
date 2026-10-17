import { powerMonitor } from 'electron';
import type { PaneCommandRegistry } from './commandRegistry';
import type { ConfigManager } from '../services/configManager';
import type { OrchestrationSessionManager } from '../services/orchestrationSessionManager';
import type { SessionManager } from '../services/sessionManager';
import type { WorkspaceJournal } from '../services/workspaceJournal';
import type { WorkspaceStateReader } from '../services/workspaceStateReader';
import type { Logger } from '../utils/logger';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { SessionAgentAutoResume, type AutoResumeWorker } from '../services/sessionAgentAutoResume';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PanelAgentStatusEvent } from '../../../shared/types/agentStatus';

const RESUME_READY_TIMEOUT_MS = 120_000;
const SCREEN_LINES = 60;

const panelStateSchema = boundary.object({
  agentType: boundary.optional(boundary.string),
  wasInterrupted: boundary.optional(boundary.boolean),
  interruptedAt: boundary.optional(boundary.string),
  lastActivityTime: boundary.optional(boundary.string),
  updateResumeHold: boundary.optional(boundary.string),
  agentReport: boundary.optional(boundary.object({ state: boundary.string })),
});
const resumeResultSchema = boundary.object({
  ok: boundary.boolean,
  readiness: boundary.optional(boundary.object({ ok: boundary.boolean, blocked: boundary.optional(boundary.jsonObject) })),
});
const screenResultSchema = boundary.object({
  text: boundary.string,
  composer: boundary.object({ isPresent: boundary.boolean, hasUndeliveredText: boundary.boolean }),
});
const submitResultSchema = boundary.object({ ok: boundary.boolean });

interface AutoResumeHostOptions {
  commandRegistry: PaneCommandRegistry;
  configManager: ConfigManager;
  sessionManager: SessionManager;
  orchestrationSessionManager: OrchestrationSessionManager;
  workspaceStateReader: WorkspaceStateReader;
  workspaceJournal: WorkspaceJournal;
  logger: Logger;
}

/**
 * Connects `SessionAgentAutoResume` to the daemon: Session membership, the same restart and
 * submit `runpane panels resume|submit` run, the journal, power events and agent status.
 */
export function startSessionAgentAutoResume(options: AutoResumeHostOptions) {
  const { commandRegistry, configManager, sessionManager, orchestrationSessionManager, workspaceStateReader, workspaceJournal, logger } = options;

  const panelState = (panelId: string) => {
    const panel = panelManager.getPanel(panelId);
    if (panel?.type !== 'terminal') return undefined;
    try {
      return decodeBoundary(panel.state.customState ?? {}, panelStateSchema);
    } catch {
      return undefined;
    }
  };
  const toWorker = (panel: { panelId: string; paneId: string; panelTitle?: string; agentType?: string }): AutoResumeWorker => {
    const state = panelState(panel.panelId);
    return {
      panelId: panel.panelId,
      paneId: panel.paneId,
      panelTitle: panel.panelTitle,
      agentType: panel.agentType,
      interruptedAt: (state?.wasInterrupted ? state.interruptedAt : undefined) ?? state?.lastActivityTime,
    };
  };
  // A worker that reported done or failed has finished, and an update holds its panels for review.
  const wantsResume = (panelId: string) => {
    const state = panelState(panelId);
    if (!state || state.updateResumeHold) return false;
    return state.agentReport?.state !== 'done' && state.agentReport?.state !== 'failed';
  };
  const workers = () => workspaceStateReader.listManagedCliPanels()
    .filter(panel => orchestrationSessionManager.isActiveSessionWorker(panel.paneId, panel.panelId));

  const autoResume = new SessionAgentAutoResume({
    isEnabled: () => configManager.getConfig().autoResumeSessionAgents !== false,
    listStoppedWorkers: async () => workers()
      .filter(panel => !panel.running && wantsResume(panel.panelId))
      .map(toWorker),
    listRunningWorkers: () => workers().filter(panel => panel.running).map(toWorker),
    worker: panelId => {
      const panel = panelManager.getPanel(panelId);
      if (panel?.type !== 'terminal' || sessionManager.getSession(panel.sessionId)?.archived) return undefined;
      if (!orchestrationSessionManager.isActiveSessionWorker(panel.sessionId, panelId)) return undefined;
      return toWorker({ panelId, paneId: panel.sessionId, panelTitle: panel.title, agentType: panelState(panelId)?.agentType });
    },
    resume: async panelId => {
      const result = decodeBoundary(await commandRegistry.invoke('runpane:panels:resume', [{
        panelId, waitReady: true, readyTimeoutMs: RESUME_READY_TIMEOUT_MS,
      }]), resumeResultSchema);
      const blocked = result.readiness?.blocked !== undefined || terminalPanelManager.getAgentStatus(panelId) === 'blocked';
      return { ready: result.ok || blocked, blocked };
    },
    agentState: panelId => terminalPanelManager.getAgentStatus(panelId),
    readScreen: async panelId => {
      const screen = decodeBoundary(await commandRegistry.invoke('runpane:panels:screen', [{ panelId, limit: SCREEN_LINES }]), screenResultSchema);
      return { text: screen.text, composerPresent: screen.composer.isPresent, composerHasText: screen.composer.hasUndeliveredText };
    },
    submit: async (panelId, text) =>
      decodeBoundary(await commandRegistry.invoke('runpane:panels:submit', [{ panelId, input: text }]), submitResultSchema).ok,
    record: entry => {
      workspaceJournal.appendPaneEntry(entry.paneId, entry);
      logger.info(`[AutoResume] panel.resumed ${entry.panelId} (${entry.reason}) nudged=${entry.nudged === true}`);
    },
    log: (message, error) => logger.warn(message, error),
  });

  const onAgentStatus = (change: PanelAgentStatusEvent) => autoResume.handleAgentStatus(change.panelId, change.state, change.reason);
  const onSuspend = () => autoResume.handleSuspend();
  const onResume = () => autoResume.handleSystemResume();
  terminalPanelManager.on('agent-status', onAgentStatus);
  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('resume', onResume);
  autoResume.captureStartupWorkers();

  return {
    resumeStartupWorkers: () => {
      // Sessions repair saved launch state on first use, before any of their terminals restarts.
      void orchestrationSessionManager.list().then(() => autoResume.resumeStartupWorkers()).catch(error => logger.warn('[AutoResume] Startup resume failed', error instanceof Error ? error : undefined));
    },
    dispose: () => {
      terminalPanelManager.removeListener('agent-status', onAgentStatus);
      powerMonitor.removeListener('suspend', onSuspend);
      powerMonitor.removeListener('resume', onResume);
      autoResume.dispose();
    },
  };
}
