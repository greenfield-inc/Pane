/**
 * Bring terminal panels back after the headless daemon starts again.
 *
 * A Runpane Cloud sandbox stops with a hard power-off (no SIGTERM), so every
 * headless start is treated as recovery from power loss:
 *
 * 1. `recoverAfterRestart` runs once, before any terminal starts. No PTY of
 *    this process exists yet, so persisted `isInitialized`/`isCliReady` are
 *    stale and are cleared. An agent panel that was running is marked
 *    `wasInterrupted`, which the launch resolver in terminalPanelManager
 *    turns into `claude --resume <id>`, `codex resume <id>` and so on.
 * 2. `resumeInterruptedAgents` starts those agent panels right away (for
 *    Panes that are not archived), so a woken sandbox has its agents at their
 *    composers before anyone submits. A daemon restart without a power-off
 *    can leave the old agent running with nobody attached; it is stopped
 *    before its panel resumes, so one conversation never has two agents.
 * 3. `ensureRunning` starts any other terminal panel on first use (submit,
 *    input, wait). Plain shells cannot be resumed: their processes died with
 *    the machine, so they start fresh in the Pane's worktree.
 */
import type { ToolPanel, TerminalPanelState } from '../../../shared/types/panels';
import { resolveAgentTypeFromCommand } from './agents/agentIdentity';
import { PaneCommandError } from '../core/commandError';

export type PanelRunState = 'running' | 'resuming' | 'interrupted' | 'stopped';

export interface PanelResumeSession {
  id: string;
  worktreePath: string;
  archived: boolean;
}

export interface PanelResumeDeps {
  /** Panes whose agents come back on start (not archived, not hidden). */
  listSessions(): PanelResumeSession[];
  /** Every Pane that still owns panels, hidden ones included. */
  listSessionsForRecovery(): PanelResumeSession[];
  getSession(sessionId: string): PanelResumeSession | undefined;
  getPanelsForSession(sessionId: string): ToolPanel[];
  getPanel(panelId: string): ToolPanel | undefined;
  updateCustomState(panel: ToolPanel, customState: TerminalPanelState): Promise<void>;
  isRunning(panelId: string): boolean;
  startTerminal(panel: ToolPanel, cwd: string): Promise<void>;
  waitForLaunch(panelId: string, timeoutMs: number): Promise<boolean>;
  /** True or false when Pane can read Claude's transcripts; undefined when it cannot tell. */
  claudeTranscriptExists(sessionId: string): boolean | undefined;
  /**
   * Stop processes an earlier Pane process left running for this panel.
   * Returns the pids it signalled and any that are still alive.
   */
  stopStrayProcesses(panelId: string): Promise<{ stopped: number[]; survivors: number[] }>;
  log(message: string, error?: Error): void;
}

export interface PanelResumeEntry {
  panelId: string;
  paneId: string;
  agentType?: string;
  state: 'pending' | 'resuming' | 'running' | 'failed';
  error?: string;
}

export interface PanelResumeStatus {
  /** `idle` before start-up recovery ran (desktop mode never runs it). */
  phase: 'idle' | 'resuming' | 'done';
  startedAt?: string;
  finishedAt?: string;
  panels: PanelResumeEntry[];
}

const DEFAULT_LAUNCH_WAIT_MS = 30_000;

export function terminalState(panel: ToolPanel): TerminalPanelState {
  // SAFETY: terminal panels persist TerminalPanelState in customState exclusively.
  return (panel.state.customState ?? {}) as TerminalPanelState;
}

/** The CLI agent a panel launches, or undefined for a plain shell or tool. */
function panelAgentType(state: TerminalPanelState): string | undefined {
  if (state.customResume) return state.agentType ?? 'custom';
  return state.agentType ?? resolveAgentTypeFromCommand(state.initialCommand);
}

/** Whether a restart can bring back the agent's conversation, not only its program. */
export function hasResumableConversation(state: TerminalPanelState): boolean {
  const agentType = panelAgentType(state);
  if (!agentType || !state.initialCommand) return false;
  if (state.launchMode === 'wrapped') return false;
  if (state.customResume) return Boolean(state.agentSessionId);
  if (agentType === 'claude') return state.hasClaudeSessionId === true && Boolean(state.agentSessionId);
  return Boolean(state.agentSessionId);
}

/** A terminal panel's run state from its PTY and persisted state alone. */
export function panelRunState(panel: ToolPanel, isRunning: boolean): PanelRunState {
  if (isRunning) return 'running';
  return terminalState(panel).wasInterrupted === true ? 'interrupted' : 'stopped';
}

export class PanelResume {
  private enabled = false;
  private status: PanelResumeStatus = { phase: 'idle', panels: [] };
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly phaseListeners = new Set<(phase: PanelResumeStatus['phase']) => void>();
  private extraPaneIds: () => readonly string[] = () => [];

  constructor(private readonly deps: PanelResumeDeps) {}

  /**
   * Hidden Panes whose agents come back on start too: a named Session's orchestrator lives in a
   * hidden Pane, and `listSessions` leaves hidden Panes out (they are mostly worktree reserves).
   */
  alsoResumePanes(source: () => readonly string[]): void {
    this.extraPaneIds = source;
  }

  /** Lazily start panels on use. Only the headless daemon enables this. */
  enable(): void {
    this.enabled = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Called with `resuming` when start-up resume begins and `done` when every panel settled. */
  onPhaseChange(listener: (phase: PanelResumeStatus['phase']) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  getStatus(): PanelResumeStatus {
    return { ...this.status, panels: this.status.panels.map(entry => ({ ...entry })) };
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
        const wasRunning = state.isInitialized === true || state.isCliReady === true;
        if (!wasRunning) {
          if (state.wasInterrupted === true && panelAgentType(state)) interrupted.push(panel.id);
          continue;
        }
        const isAgent = Boolean(panelAgentType(state));
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
  async resumeInterruptedAgents(): Promise<PanelResumeStatus> {
    const candidates: Array<{ panel: ToolPanel; session: PanelResumeSession }> = [];
    const sessions = new Map(this.deps.listSessions().map(session => [session.id, session]));
    for (const paneId of this.extraPaneIds()) {
      const session = sessions.has(paneId) ? undefined : this.deps.getSession(paneId);
      if (session) sessions.set(session.id, session);
    }
    for (const session of sessions.values()) {
      if (session.archived) continue;
      for (const panel of this.deps.getPanelsForSession(session.id)) {
        if (panel.type !== 'terminal' || this.deps.isRunning(panel.id)) continue;
        const state = terminalState(panel);
        if (state.wasInterrupted === true && panelAgentType(state)) candidates.push({ panel, session });
      }
    }

    this.status = {
      phase: 'resuming',
      startedAt: new Date().toISOString(),
      panels: candidates.map(({ panel }) => ({
        panelId: panel.id,
        paneId: panel.sessionId,
        agentType: panelAgentType(terminalState(panel)),
        state: 'pending',
      })),
    };
    this.deps.log(`[PanelResume] Resuming ${candidates.length} interrupted agent panel(s)`);
    this.emitPhase();

    // initializeTerminal caps concurrent spawns itself.
    await Promise.all(candidates.map(({ panel, session }) => this.start(panel, session).catch(() => undefined)));
    this.status = { ...this.status, phase: 'done', finishedAt: new Date().toISOString() };
    this.emitPhase();
    return this.getStatus();
  }

  /**
   * Make sure a terminal panel has a live PTY before input reaches it. Waits
   * for the launch command (and an agent's CLI) to come up. Throws a
   * PaneCommandError with code ERR_PANEL_NOT_RUNNING when it cannot, when the
   * panel exits meanwhile, or when its launch does not settle within `waitMs`
   * (a `waitMs` of 0 only requires a live PTY).
   */
  async ensureRunning(panel: ToolPanel, options: { waitMs?: number } = {}): Promise<void> {
    const waitMs = options.waitMs ?? DEFAULT_LAUNCH_WAIT_MS;
    if (this.deps.isRunning(panel.id) && !this.inFlight.has(panel.id)) {
      // A panel resumed at start-up may still be bringing its agent up.
      await this.awaitLaunch(panel, waitMs);
      return;
    }
    const state = terminalState(panel);
    const details = {
      panelId: panel.id,
      paneId: panel.sessionId,
      runState: this.runState(panel),
      resumable: hasResumableConversation(state),
    };
    if (!this.enabled) {
      throw new PaneCommandError(`Terminal panel ${panel.id} is not initialized`, 'ERR_PANEL_NOT_RUNNING', details);
    }
    const session = this.deps.getSession(panel.sessionId);
    if (!session || session.archived) {
      throw new PaneCommandError(
        `Terminal panel ${panel.id} is not running and its Pane is ${session ? 'archived' : 'missing'}, so it cannot be restarted`,
        'ERR_PANEL_NOT_RUNNING',
        { ...details, resumable: false },
      );
    }
    try {
      await this.start(panel, session);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PaneCommandError(`Terminal panel ${panel.id} could not be restarted: ${reason}`, 'ERR_PANEL_NOT_RUNNING', details);
    }
    await this.awaitLaunch(panel, waitMs);
  }

  /** Wait for the panel's launch to settle, then confirm it is still running. */
  private async awaitLaunch(panel: ToolPanel, waitMs: number): Promise<void> {
    const launched = await this.deps.waitForLaunch(panel.id, waitMs);
    const running = this.deps.isRunning(panel.id);
    if (running && (launched || waitMs <= 0)) return;
    const details = {
      panelId: panel.id,
      paneId: panel.sessionId,
      runState: this.runState(panel),
      resumable: hasResumableConversation(terminalState(panel)),
    };
    const message = running
      ? `Terminal panel ${panel.id} did not finish launching within ${waitMs}ms`
      : `Terminal panel ${panel.id} exited while starting`;
    throw new PaneCommandError(message, 'ERR_PANEL_NOT_RUNNING', details);
  }

  /** What `panels list` reports for a terminal panel. */
  runState(panel: ToolPanel): PanelRunState {
    if (this.inFlight.has(panel.id)) return 'resuming';
    return panelRunState(panel, this.deps.isRunning(panel.id));
  }

  private start(panel: ToolPanel, session: PanelResumeSession): Promise<void> {
    const existing = this.inFlight.get(panel.id);
    if (existing) return existing;
    const run = this.startOnce(panel.id, session).finally(() => this.inFlight.delete(panel.id));
    this.inFlight.set(panel.id, run);
    return run;
  }

  private async startOnce(panelId: string, session: PanelResumeSession): Promise<void> {
    this.setEntry(panelId, { state: 'resuming' });
    try {
      // Re-read: recovery or another caller may have updated the state.
      const panel = this.deps.getPanel(panelId);
      if (!panel) throw new Error(`Panel ${panelId} not found`);
      await this.stopStrayAgent(panel);
      await this.forgetMissingClaudeConversation(panel);
      await this.deps.startTerminal(this.deps.getPanel(panelId) ?? panel, session.worktreePath);
      if (!this.deps.isRunning(panelId)) throw new Error('the terminal did not start');
      this.setEntry(panelId, { state: 'running' });
      this.deps.log(`[PanelResume] Started panel ${panelId} in ${session.worktreePath}`);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.setEntry(panelId, { state: 'failed', error: failure.message });
      this.deps.log(`[PanelResume] Could not start panel ${panelId}`, failure);
      throw error;
    }
  }

  /**
   * A daemon that was SIGKILLed (or crashed) can leave the panel's shell and
   * agent running with nobody attached. Resuming next to it would run two
   * agents on one conversation, so stop the old one first, and refuse to
   * start while any of it survives.
   */
  private async stopStrayAgent(panel: ToolPanel): Promise<void> {
    if (!panelAgentType(terminalState(panel))) return;
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

  private emitPhase(): void {
    for (const listener of this.phaseListeners) {
      try {
        listener(this.status.phase);
      } catch (error) {
        this.deps.log('[PanelResume] Phase listener failed', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private setEntry(panelId: string, update: Pick<PanelResumeEntry, 'state' | 'error'>): void {
    const entry = this.status.panels.find(item => item.panelId === panelId);
    if (!entry) return;
    entry.state = update.state;
    entry.error = update.error;
  }
}
