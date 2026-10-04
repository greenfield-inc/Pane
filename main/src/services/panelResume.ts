/**
 * Bring agent panels back after the headless daemon starts again.
 *
 * A cloud sandbox stops with a hard power-off (no SIGTERM), so the headless
 * daemon treats every start as recovery from power loss:
 *
 * 1. `recoverAfterRestart` runs once, before any terminal starts. No PTY of
 *    this process exists yet, so persisted `isInitialized`/`isCliReady` are
 *    stale and are cleared. An agent panel that was running is marked
 *    `wasInterrupted`, which the launch resolver in terminalPanelManager
 *    turns into `claude --resume <id>`, `codex resume <id>` and so on the
 *    next time the panel starts (when the app opens it, for one).
 * 2. `resumeInterruptedAgents` starts those agent panels right away, for
 *    Panes that are not archived, so a woken sandbox has its agents back
 *    before anyone opens them. The daemon runs it only when
 *    PANE_RESUME_AGENTS_ON_START=1. A restart without a power-off can leave
 *    the old agent running with nobody attached; it is stopped before its
 *    panel resumes, so one conversation never has two agents.
 *
 * Plain shells are never started here: their processes died with the
 * machine, and they start fresh when someone opens them.
 */
import type { ToolPanel, TerminalPanelState } from '../../../shared/types/panels';
import { resolveAgentTypeFromCommand } from './agents/agentIdentity';

export interface PanelResumeSession {
  id: string;
  worktreePath: string;
  archived: boolean;
}

export interface PanelResumeDeps {
  /** Panes whose agents come back on start (not hidden). */
  listSessions(): PanelResumeSession[];
  /** Every Pane that still owns panels, hidden ones included. */
  listSessionsForRecovery(): PanelResumeSession[];
  getSession(sessionId: string): PanelResumeSession | undefined;
  getPanelsForSession(sessionId: string): ToolPanel[];
  getPanel(panelId: string): ToolPanel | undefined;
  updateCustomState(panel: ToolPanel, customState: TerminalPanelState): Promise<void>;
  isRunning(panelId: string): boolean;
  startTerminal(panel: ToolPanel, cwd: string): Promise<void>;
  isDirectory(directoryPath: string): boolean;
  /** True or false when Pane can read Claude's transcripts; undefined when it cannot tell. */
  claudeTranscriptExists(sessionId: string): boolean | undefined;
  /**
   * Stop processes an earlier Pane process left running for this panel.
   * Returns the pids it signalled and any that are still alive.
   */
  stopStrayProcesses(panelId: string): Promise<{ stopped: number[]; survivors: number[] }>;
  log(message: string, error?: Error): void;
}

export interface PanelResumeResult {
  panelId: string;
  paneId: string;
  state: 'running' | 'failed';
  error?: string;
}

export function terminalState(panel: ToolPanel): TerminalPanelState {
  // SAFETY: terminal panels persist TerminalPanelState in customState exclusively.
  return (panel.state.customState ?? {}) as TerminalPanelState;
}

/** The CLI agent a panel launches, or undefined for a plain shell or tool. */
function panelAgentType(state: TerminalPanelState): string | undefined {
  if (state.customResume) return state.agentType ?? 'custom';
  return state.agentType ?? resolveAgentTypeFromCommand(state.initialCommand);
}

export class PanelResume {
  private extraPaneIds: () => readonly string[] = () => [];

  constructor(private readonly deps: PanelResumeDeps) {}

  /**
   * Hidden Panes whose agents come back on start too: a named Session's orchestrator lives in a
   * hidden Pane, and `listSessions` leaves hidden Panes out (they are mostly worktree reserves).
   */
  alsoResumePanes(source: () => readonly string[]): void {
    this.extraPaneIds = source;
  }

  /**
   * Clear runtime flags that cannot be true in a new process and mark agent
   * panels that were running as interrupted. Returns the interrupted panel ids.
   */
  async recoverAfterRestart(): Promise<string[]> {
    const interrupted: string[] = [];
    for (const session of this.deps.listSessionsForRecovery()) {
      for (const panel of this.deps.getPanelsForSession(session.id)) {
        if (panel.type !== 'terminal' || this.deps.isRunning(panel.id)) continue;
        const state = terminalState(panel);
        const isAgent = Boolean(panelAgentType(state));
        if (state.isInitialized !== true && state.isCliReady !== true) {
          if (state.wasInterrupted === true && isAgent) interrupted.push(panel.id);
          continue;
        }
        const next: TerminalPanelState = { ...state, isInitialized: false, isCliReady: false };
        if (isAgent) next.wasInterrupted = true;
        try {
          await this.deps.updateCustomState(panel, next);
          if (isAgent) interrupted.push(panel.id);
        } catch (error) {
          this.deps.log(`[PanelResume] Could not clear stale state for panel ${panel.id}`, error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    return interrupted;
  }

  /** Start every interrupted agent panel of a Pane that is not archived. */
  async resumeInterruptedAgents(): Promise<PanelResumeResult[]> {
    const sessions = new Map(this.deps.listSessions().map(session => [session.id, session]));
    for (const paneId of this.extraPaneIds()) {
      const session = sessions.has(paneId) ? undefined : this.deps.getSession(paneId);
      if (session) sessions.set(session.id, session);
    }
    const candidates: Array<{ panel: ToolPanel; session: PanelResumeSession }> = [];
    for (const session of sessions.values()) {
      if (session.archived) continue;
      for (const panel of this.deps.getPanelsForSession(session.id)) {
        if (panel.type !== 'terminal' || this.deps.isRunning(panel.id)) continue;
        const state = terminalState(panel);
        if (state.wasInterrupted === true && panelAgentType(state)) candidates.push({ panel, session });
      }
    }

    this.deps.log(`[PanelResume] Resuming ${candidates.length} interrupted agent panel(s)`);
    // initializeTerminal caps concurrent spawns itself.
    return Promise.all(candidates.map(({ panel, session }) => this.start(panel.id, session)));
  }

  private async start(panelId: string, session: PanelResumeSession): Promise<PanelResumeResult> {
    try {
      // Re-read: recovery may have updated the state.
      const panel = this.deps.getPanel(panelId);
      if (!panel) throw new Error(`Panel ${panelId} not found`);
      await this.stopStrayAgent(panel);
      await this.forgetMissingClaudeConversation(panel);
      const current = this.deps.getPanel(panelId) ?? panel;
      const cwd = this.launchDirectory(current, session);
      await this.deps.startTerminal(current, cwd);
      if (!this.deps.isRunning(panelId)) throw new Error('the terminal did not start');
      this.deps.log(`[PanelResume] Started panel ${panelId} in ${cwd}`);
      return { panelId, paneId: session.id, state: 'running' };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.deps.log(`[PanelResume] Could not start panel ${panelId}`, failure);
      return { panelId, paneId: session.id, state: 'failed', error: failure.message };
    }
  }

  /**
   * The folder the panel's terminal ran in (recorded when it started). An agent
   * finds its conversation by that folder (Claude keeps transcripts per folder),
   * so resuming elsewhere starts an empty one. Falls back to the Pane's worktree
   * when nothing was recorded or the folder is gone.
   */
  private launchDirectory(panel: ToolPanel, session: PanelResumeSession): string {
    const recorded = terminalState(panel).cwd;
    return recorded && this.deps.isDirectory(recorded) ? recorded : session.worktreePath;
  }

  /**
   * A daemon that was SIGKILLed (or crashed) can leave the panel's shell and
   * agent running with nobody attached. Resuming next to it would run two
   * agents on one conversation, so stop the old one first, and refuse to
   * start while any of it survives.
   */
  private async stopStrayAgent(panel: ToolPanel): Promise<void> {
    const { stopped, survivors } = await this.deps.stopStrayProcesses(panel.id);
    if (stopped.length > 0) {
      this.deps.log(`[PanelResume] Panel ${panel.id} still had ${stopped.length} process(es) from an earlier Pane process (pids ${stopped.join(', ')}); stopped them before resuming`);
    }
    if (survivors.length > 0) {
      throw new Error(`an earlier process for this panel is still running (pids ${survivors.join(', ')})`);
    }
  }

  /**
   * `claude --resume <id>` exits with "No conversation found" when Claude
   * never wrote a transcript (for example, it stopped at the trust prompt).
   * Start that panel as a new conversation with the same id instead.
   */
  private async forgetMissingClaudeConversation(panel: ToolPanel): Promise<void> {
    const state = terminalState(panel);
    if (panelAgentType(state) !== 'claude' || state.customResume || state.launchMode === 'wrapped') return;
    if (state.hasClaudeSessionId !== true || !state.agentSessionId) return;
    let exists: boolean | undefined;
    try {
      exists = this.deps.claudeTranscriptExists(state.agentSessionId);
    } catch (error) {
      this.deps.log(`[PanelResume] Could not look up the Claude transcript for panel ${panel.id}`, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (exists !== false) return;
    this.deps.log(`[PanelResume] Panel ${panel.id} has no Claude transcript for ${state.agentSessionId}; starting a new conversation with that id`);
    await this.deps.updateCustomState(panel, { ...state, hasClaudeSessionId: false });
  }
}
