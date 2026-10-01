import type { DatabaseService } from '../database/database';
import type { Session as SessionRow } from '../database/models';
import type { SessionManager } from './sessionManager';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { canReadClaudeTranscripts, findClaudeSessionTranscript } from './claudeSessionTranscript';
import { panelManager } from './panelManager';
import { PanelResume, type PanelResumeSession } from './panelResume';
import { ScrollbackCheckpoint } from './panelResumeCheckpoint';
import { terminalPanelManager } from './terminalPanelManager';

function toResumeSession(row: SessionRow): PanelResumeSession {
  return { id: row.id, worktreePath: row.worktree_path, archived: Boolean(row.archived) };
}

/** Wire PanelResume to the daemon's session, panel and terminal services. */
export function createPanelResume(
  databaseService: DatabaseService,
  sessionManager: SessionManager,
  log: (message: string, error?: Error) => void,
): PanelResume {
  // getAllSessions leaves out each repo's main-checkout Pane; add those back.
  const withMainRepoSessions = (rows: SessionRow[]): PanelResumeSession[] => {
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const project of databaseService.getAllProjects()) {
      const main = databaseService.getMainRepoSession(project.id);
      if (main && !byId.has(main.id)) byId.set(main.id, main);
    }
    return [...byId.values()].map(toResumeSession);
  };

  return new PanelResume({
    listSessions: () => withMainRepoSessions(databaseService.getAllSessions()),
    listSessionsForRecovery: () => withMainRepoSessions(databaseService.getAllSessions(undefined, { includeHidden: true })),
    getSession: sessionId => {
      const row = databaseService.getSession(sessionId);
      return row ? toResumeSession(row) : undefined;
    },
    getPanelsForSession: sessionId => panelManager.getPanelsForSession(sessionId),
    getPanel: panelId => panelManager.getPanel(panelId),
    updateCustomState: async (panel, customState: TerminalPanelState) => {
      const state = { ...panel.state, customState };
      panel.state = state;
      await panelManager.updatePanel(panel.id, { state });
    },
    isRunning: panelId => terminalPanelManager.isTerminalInitialized(panelId),
    startTerminal: async (panel, cwd) => {
      const wslContext = sessionManager.getProjectContext(panel.sessionId)?.commandRunner.wslContext ?? null;
      await terminalPanelManager.initializeTerminal(panel, cwd, wslContext);
    },
    waitForLaunch: (panelId, timeoutMs) => terminalPanelManager.waitForLaunch(panelId, timeoutMs),
    claudeTranscriptExists: sessionId => canReadClaudeTranscripts()
      ? findClaudeSessionTranscript(sessionId) !== undefined
      : undefined,
    log,
  });
}

/** Persist live terminal scrollback on a timer, so a power-off keeps recent output. */
export function createScrollbackCheckpoint(intervalMs: number, log: (message: string, error?: Error) => void): ScrollbackCheckpoint {
  return new ScrollbackCheckpoint({
    intervalMs,
    listRunningPanelIds: () => terminalPanelManager.getAllPanelIds(),
    getOutputGeneration: panelId => terminalPanelManager.getOutputGeneration(panelId),
    save: panelId => terminalPanelManager.saveTerminalState(panelId),
    log,
  });
}
