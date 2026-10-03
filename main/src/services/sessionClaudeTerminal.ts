import type { PanelEvent, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { randomUUID } from 'node:crypto';
import type { SessionManager } from './sessionManager';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { resolveAgentTypeFromCommand } from './agents/agentIdentity';
import { withLock } from '../utils/mutex';
import type { AbstractCliManager } from './panels/cli/AbstractCliManager';
import { panelEventBus } from './panelEventBus';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

function claudeState(panel: ToolPanel): TerminalPanelState | undefined {
  if (panel.type !== 'terminal') return undefined;
  // SAFETY: Terminal panel state is persisted by TerminalPanelManager.
  const state = panel.state.customState as TerminalPanelState | undefined;
  return (state?.agentType ?? resolveAgentTypeFromCommand(state?.initialCommand)) === 'claude'
    ? state
    : undefined;
}

/** Legacy session commands use the same persisted terminals as panel commands. */
export async function runSessionClaude(
  sessionManager: Pick<SessionManager, 'getSession' | 'getDbSession' | 'getProjectContext' | 'updateSession'>,
  sessionId: string,
  prompt: string,
  options: { mode: 'start' | 'continue' | 'input'; model?: string; permissionMode?: 'approve' | 'ignore' },
  cliManager: Pick<AbstractCliManager, 'prepareTerminalLaunch'>,
): Promise<void> {
  await withLock(`session-claude-${sessionId}`, async () => {
    const session = sessionManager.getSession(sessionId);
    if (!session || session.archived) throw new Error('Active session not found');
    if (session.toolType === 'none' && options.mode !== 'start') throw new Error('Session has no tool configured');

    const panels = panelManager.getPanelsForSession(sessionId).filter(panel => claudeState(panel));
    let panel = panels.find(candidate => candidate.state.isActive)
      ?? panels.find(candidate => terminalPanelManager.isTerminalInitialized(candidate.id))
      ?? panels[0];
    const dbSession = sessionManager.getDbSession(sessionId);
    const startFresh = options.mode === 'start' || Boolean(dbSession?.skip_continue_next);

    if (panel && !startFresh && terminalPanelManager.isTerminalInitialized(panel.id)) {
      if (!terminalPanelManager.isCommandBoundTerminal(panel.id)) {
        throw new Error('Use the Claude panel directly, or stop it before continuing this session');
      }
      if (options.mode === 'continue' && terminalPanelManager.getAgentStatus(panel.id) === 'working') {
        throw new Error('Session is already processing a request');
      }
      if (!claudeState(panel)?.isCliReady) throw new Error('Claude terminal is still starting');
      if (prompt) terminalPanelManager.writeToTerminal(panel.id, `${prompt}\r`);
      await sessionManager.updateSession(sessionId, { status: 'running' });
      return;
    }

    const previousState = panel && !startFresh ? claudeState(panel) : undefined;
    // Only import the session-wide ID when there is no panel-local conversation.
    // Existing history rows remain untouched and available through history/export APIs.
    const resumeId = startFresh ? undefined : previousState?.agentSessionId
      ?? (previousState?.hasClaudeSessionId ? panel?.id : undefined)
      ?? (!panel ? dbSession?.claude_session_id : undefined);
    const launch = await cliManager.prepareTerminalLaunch({
      sessionId, prompt, isResume: Boolean(resumeId),
      model: options.model ?? session.model,
      permissionMode: options.permissionMode ?? session.permissionMode,
    });
    const agentSessionId = resumeId ?? randomUUID();
    await sessionManager.updateSession(sessionId, { status: 'initializing', run_started_at: null });
    const initialState: TerminalPanelState = {
      ...previousState,
      initialCommand: launch.executable,
      agentLaunch: { executable: launch.executable, args: launch.args },
      environmentVars: launch.environment,
      initialInput: launch.prompt,
      initialInputMode: resumeId ? 'stdin' : 'argument',
      initialInputSentAt: undefined,
      initialInputError: undefined,
      isCliPanel: true,
      isCliReady: false,
      agentType: 'claude',
      agentSessionId,
      hasClaudeSessionId: Boolean(resumeId),
    };
    if (panel && !startFresh) {
      await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: initialState } });
      panel = { ...panel, state: { ...panel.state, customState: initialState } };
    } else {
      panel = await panelManager.createPanel({ sessionId, type: 'terminal', title: 'Claude', initialState });
    }
    const context = sessionManager.getProjectContext(sessionId);
    try {
      await terminalPanelManager.initializeTerminal(panel, session.worktreePath, context?.commandRunner.wslContext ?? null);
      if (!terminalPanelManager.isCommandBoundTerminal(panel.id)) throw new Error('Claude exited during startup');
      await sessionManager.updateSession(sessionId, { status: 'running', run_started_at: 'CURRENT_TIMESTAMP' });
      if (dbSession?.skip_continue_next) await sessionManager.updateSession(sessionId, { skip_continue_next: false });
    } catch (error) {
      await sessionManager.updateSession(sessionId, { status: 'error', error: String(error) });
      throw error;
    }
  });
}

/** Share the launch lock so stop cannot race an in-flight session launch. */
export async function stopSessionProcesses(
  sessionManager: Pick<SessionManager, 'stopSession'>,
  sessionId: string,
  cliManager: Pick<AbstractCliManager, 'killSessionProcesses'>,
): Promise<void> {
  await withLock(`session-claude-${sessionId}`, async () => {
    for (const panel of panelManager.getPanelsForSession(sessionId)) {
      if (panel.type === 'terminal') await terminalPanelManager.stopTerminal(panel.id);
    }
    await cliManager.killSessionProcesses(sessionId);
    sessionManager.stopSession(sessionId);
  });
}

/** Keep legacy session busy state in sync with its owned, independently running panels. */
export function setupSessionTerminalLifecycle(sessionManager: Pick<SessionManager, 'getSession' | 'updateSession'>): () => void {
  const update = (event: PanelEvent) => {
    const panel = panelManager.getPanel(event.source.panelId);
    if (!panel || !claudeState(panel)?.agentLaunch) return;
    const session = sessionManager.getSession(event.source.sessionId);
    if (!session || session.archived) return;
    const state = terminalPanelManager.getSessionAgentState(session.id);
    const exit = event.type === 'terminal:exit'
      ? decodeOptionalBoundary(event.data, boundary.object({ exitCode: boundary.number })) : undefined;
    const failed = exit !== undefined && exit.exitCode !== 0;
    const status = state === 'working' ? 'running' : state === 'blocked' ? 'waiting'
      : state === 'unknown' ? 'initializing' : state === 'idle' ? 'ready' : failed ? 'error' : 'stopped';
    sessionManager.updateSession(session.id, { status });
  };
  panelEventBus.on('terminal:agent_status', update);
  panelEventBus.on('terminal:exit', update);
  return () => {
    panelEventBus.off('terminal:agent_status', update);
    panelEventBus.off('terminal:exit', update);
  };
}
