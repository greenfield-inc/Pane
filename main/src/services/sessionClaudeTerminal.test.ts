import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import type { Session } from '../types/session';
import type { SessionManager } from './sessionManager';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { AbstractCliManager } from './panels/cli/AbstractCliManager';
import { runSessionClaude, stopSessionProcesses, setupSessionTerminalLifecycle } from './sessionClaudeTerminal';
import { panelEventBus } from './panelEventBus';

const session: Session = {
  id: 'session-a', name: 'Example', worktreePath: '/worktree', prompt: '',
  status: 'stopped', createdAt: new Date(), output: [], jsonMessages: [], permissionMode: 'approve',
};
function terminal(id: string, agentType?: 'claude' | 'codex', isActive = false): ToolPanel {
  return { id, sessionId: session.id, type: 'terminal', title: id,
    state: { isActive, customState: { agentType, isCliReady: true, agentSessionId: '22222222-2222-4222-8222-222222222222' } },
    metadata: { createdAt: '', lastActiveAt: '', position: 0 },
  };
}
function services() {
  return {
    getSession: vi.fn(() => session),
    getDbSession: vi.fn<SessionManager['getDbSession']>(() => undefined),
    getProjectContext: vi.fn<SessionManager['getProjectContext']>(() => null),
    updateSession: vi.fn<SessionManager['updateSession']>(),
  };
}

const cli = {
  prepareTerminalLaunch: vi.fn<AbstractCliManager['prepareTerminalLaunch']>(async options => ({
    executable: 'claude', args: options.model ? ['--model', options.model] : [], environment: {}, prompt: options.prompt,
  })),
};

beforeEach(() => {
  vi.spyOn(panelManager, 'getPanelsForSession').mockReturnValue([]);
  vi.spyOn(panelManager, 'createPanel').mockImplementation(async request => ({
    ...terminal('new-panel', 'claude'), state: { isActive: true, customState: request.initialState },
  }));
  vi.spyOn(panelManager, 'updatePanel').mockResolvedValue(undefined);
  vi.spyOn(terminalPanelManager, 'initializeTerminal').mockResolvedValue(undefined);
  vi.spyOn(terminalPanelManager, 'isCommandBoundTerminal').mockReturnValue(true);
  vi.spyOn(terminalPanelManager, 'isTerminalInitialized').mockReturnValue(false);
  vi.spyOn(terminalPanelManager, 'getAgentStatus').mockReturnValue('idle');
  vi.spyOn(terminalPanelManager, 'writeToTerminal').mockImplementation(() => {});
  vi.spyOn(terminalPanelManager, 'stopTerminal').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('session Claude terminal lifecycle', () => {
  it('creates an owned terminal without commandeering shell or other-agent panels', async () => {
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([terminal('shell'), terminal('codex', 'codex', true)]);
    await runSessionClaude(services(), session.id, '/do a task', { mode: 'start', model: 'sonnet' }, cli);
    expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id, type: 'terminal',
      initialState: expect.objectContaining({ agentLaunch: { executable: 'claude', args: ['--model', 'sonnet'] }, initialInput: '/do a task' }),
    }));
    expect(terminalPanelManager.initializeTerminal).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-panel' }), '/worktree', null);
  });

  it('allows an explicit Git-assistance start in a session created without an agent', async () => {
    const manager = services();
    manager.getSession.mockReturnValue({ ...session, toolType: 'none' });
    await runSessionClaude(manager, session.id, 'resolve rebase conflicts', { mode: 'start' }, cli);
    expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal', initialState: expect.objectContaining({ agentType: 'claude' }),
    }));
  });

  it('routes input to the active Claude panel using its real ID', async () => {
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([terminal('claude-one', 'claude'), terminal('claude-two', 'claude', true)]);
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(true);
    await runSessionClaude(services(), session.id, 'next step', { mode: 'input' }, cli);
    expect(terminalPanelManager.writeToTerminal).toHaveBeenCalledWith('claude-two', 'next step\r');
    expect(panelManager.createPanel).not.toHaveBeenCalled();
  });

  it('rejects continuation while the chosen panel is working', async () => {
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([terminal('claude', 'claude')]);
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(true);
    vi.mocked(terminalPanelManager.getAgentStatus).mockReturnValue('working');
    await expect(runSessionClaude(services(), session.id, 'again', { mode: 'continue' }, cli)).rejects.toThrow('already processing');
    expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
  });

  it('refuses to submit prompts to a shell which may have outlived Claude', async () => {
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([terminal('claude', 'claude')]);
    vi.mocked(terminalPanelManager.isTerminalInitialized).mockReturnValue(true);
    vi.mocked(terminalPanelManager.isCommandBoundTerminal).mockReturnValue(false);
    await expect(runSessionClaude(services(), session.id, 'remove everything', { mode: 'input' }, cli))
      .rejects.toThrow('Use the Claude panel directly');
    expect(terminalPanelManager.writeToTerminal).not.toHaveBeenCalled();
  });

  it('waits for a stopped terminal snapshot before a continuation changes its prompt', async () => {
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([terminal('claude', 'claude')]);
    const snapshot = Promise.withResolvers<void>();
    vi.mocked(terminalPanelManager.stopTerminal).mockReturnValue(snapshot.promise);
    const stopping = stopSessionProcesses({ stopSession: vi.fn() }, session.id, { killSessionProcesses: vi.fn() });
    const continuing = runSessionClaude(services(), session.id, 'new prompt', { mode: 'continue' }, cli);
    await Promise.resolve();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    snapshot.resolve();
    await Promise.all([stopping, continuing]);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('claude', expect.objectContaining({
      state: expect.objectContaining({ customState: expect.objectContaining({ initialInput: 'new prompt', initialInputSentAt: undefined }) }),
    }));
  });

  it('clears session busy state on idle or exit while respecting another running panel', () => {
    const manager = services();
    const panel = terminal('claude', 'claude');
    panel.state.customState = { agentType: 'claude', agentLaunch: { executable: 'claude', args: [] } };
    vi.spyOn(panelManager, 'getPanel').mockReturnValue(panel);
    const state = vi.spyOn(terminalPanelManager, 'getSessionAgentState');
    const dispose = setupSessionTerminalLifecycle(manager);
    try {
      const source = { panelId: panel.id, sessionId: session.id, panelType: 'terminal' as const };
      state.mockReturnValue('idle');
      panelEventBus.emitPanelEvent({ type: 'terminal:agent_status', source, data: { state: 'idle' }, timestamp: '' });
      expect(manager.updateSession).toHaveBeenLastCalledWith(session.id, { status: 'ready' });
      state.mockReturnValue('working');
      panelEventBus.emitPanelEvent({ type: 'terminal:exit', source, data: { exitCode: 0 }, timestamp: '' });
      expect(manager.updateSession).toHaveBeenLastCalledWith(session.id, { status: 'running' });
      state.mockReturnValue(undefined);
      panelEventBus.emitPanelEvent({ type: 'terminal:exit', source, data: { exitCode: 1 }, timestamp: '' });
      expect(manager.updateSession).toHaveBeenLastCalledWith(session.id, { status: 'error' });
    } finally {
      dispose();
    }
  });

  it('reuses panel-local conversation IDs when resuming a stopped terminal', async () => {
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([terminal('claude', 'claude')]);
    await runSessionClaude(services(), session.id, 'continue', { mode: 'continue' }, cli);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('claude', expect.objectContaining({
      state: expect.objectContaining({ customState: expect.objectContaining({ agentSessionId: '22222222-2222-4222-8222-222222222222', hasClaudeSessionId: true }) }),
    }));
    expect(panelManager.createPanel).not.toHaveBeenCalled();
  });

  it('imports a legacy session resume ID without rewriting history', async () => {
    const manager = services();
    // SAFETY: The controller only reads these fields from the persisted legacy session.
    manager.getDbSession.mockReturnValue({ claude_session_id: '33333333-3333-4333-8333-333333333333' } as ReturnType<SessionManager['getDbSession']>);
    await runSessionClaude(manager, session.id, 'continue', { mode: 'continue' }, cli);
    expect(panelManager.createPanel).toHaveBeenCalledWith(expect.objectContaining({
      initialState: expect.objectContaining({ agentSessionId: '33333333-3333-4333-8333-333333333333', hasClaudeSessionId: true }),
    }));
    expect(manager.updateSession).toHaveBeenCalledWith(session.id, { status: 'initializing', run_started_at: null });
  });

  it('stops all session terminals plus legacy processes without deleting persisted panels', async () => {
    const panels = [terminal('claude-one', 'claude'), terminal('claude-two', 'claude'), terminal('shell')];
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue(panels);
    const cliManager = { killSessionProcesses: vi.fn().mockResolvedValue(undefined) };
    const sessionManager = { stopSession: vi.fn() };
    await stopSessionProcesses(sessionManager, session.id, cliManager);
    expect(sessionManager.stopSession).toHaveBeenCalledWith(session.id);
    expect(panelManager.getPanelsForSession).toHaveBeenCalledWith(session.id);
    expect(vi.mocked(terminalPanelManager.stopTerminal).mock.calls.map(([id]) => id)).toEqual(panels.map(panel => panel.id));
    expect(cliManager.killSessionProcesses).toHaveBeenCalledWith(session.id);
  });
});

it('stops every legacy manager process belonging to the selected session', async () => {
  const stopPanel = vi.fn().mockResolvedValue(undefined);
  // SAFETY: Exercise only the base method's process-ownership selection, without spawning PTYs.
  const fixture = {
    processes: new Map([
      ['one', { panelId: 'one', sessionId: 'target' }],
      ['two', { panelId: 'two', sessionId: 'target' }],
      ['other', { panelId: 'other', sessionId: 'elsewhere' }],
    ]),
    stopPanel,
    killSessionProcesses: AbstractCliManager.prototype.killSessionProcesses,
  };
  await fixture.killSessionProcesses('target');
  expect(stopPanel.mock.calls).toEqual([['one'], ['two']]);
});
