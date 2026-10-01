import { describe, expect, it, vi } from 'vitest';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { PaneCommandError } from '../core/commandError';
import { hasResumableConversation, PanelResume, terminalState, type PanelResumeDeps, type PanelResumeSession } from './panelResume';

function terminalPanel(id: string, sessionId: string, customState: TerminalPanelState): ToolPanel {
  return {
    id,
    sessionId,
    type: 'terminal',
    title: id,
    state: { isActive: false, customState },
    metadata: { createdAt: '2026-09-30T00:00:00.000Z', lastActiveAt: '2026-09-30T00:00:00.000Z', position: 0 },
  };
}

const CLAUDE_ID = '4135d392-c6c6-462d-a214-c339474ef77b';

/** In-memory panels and PTYs; startTerminal records what a real launch would read. */
function harness(
  sessions: PanelResumeSession[],
  panels: ToolPanel[],
  options: {
    transcript?: boolean;
    hidden?: PanelResumeSession[];
    /** Per panel: pids an earlier daemon left running, and which of them survive. */
    strays?: Record<string, { stopped: number[]; survivors?: number[] }>;
  } = {},
) {
  const withHidden = [...sessions, ...(options.hidden ?? [])];
  const running = new Set<string>();
  const launches: Array<{ panelId: string; cwd: string; state: TerminalPanelState }> = [];
  const byId = new Map(panels.map(panel => [panel.id, panel]));
  const deps: PanelResumeDeps = {
    listSessions: () => sessions,
    listSessionsForRecovery: () => withHidden,
    getSession: id => withHidden.find(session => session.id === id),
    getPanelsForSession: id => [...byId.values()].filter(panel => panel.sessionId === id),
    getPanel: id => byId.get(id),
    updateCustomState: async (panel, customState) => {
      const next = { ...panel, state: { ...panel.state, customState } };
      byId.set(panel.id, next);
    },
    isRunning: id => running.has(id),
    startTerminal: vi.fn(async (panel: ToolPanel, cwd: string) => {
      launches.push({ panelId: panel.id, cwd, state: terminalState(panel) });
      running.add(panel.id);
    }),
    waitForLaunch: vi.fn(async () => true),
    claudeTranscriptExists: () => options.transcript,
    stopStrayProcesses: vi.fn(async (panelId: string) => {
      const stray = options.strays?.[panelId];
      // A stray must be stopped before its panel starts.
      if (running.has(panelId)) throw new Error(`stray check ran after ${panelId} started`);
      return { stopped: stray?.stopped ?? [], survivors: stray?.survivors ?? [] };
    }),
    log: vi.fn(),
  };
  const state = (id: string): TerminalPanelState => {
    const panel = byId.get(id);
    return panel ? terminalState(panel) : {};
  };
  return { deps, running, launches, state };
}

const pane: PanelResumeSession = { id: 'pane-1', worktreePath: '/repo/worktrees/a', archived: false };

describe('PanelResume.recoverAfterRestart', () => {
  it('clears stale runtime flags and marks agents that were running as interrupted', async () => {
    const claude = terminalPanel('claude', pane.id, {
      initialCommand: 'claude', agentType: 'claude', isInitialized: true, isCliReady: true,
      hasClaudeSessionId: true, agentSessionId: CLAUDE_ID,
    });
    const shell = terminalPanel('shell', pane.id, { initialCommand: 'bash', isInitialized: true });
    const neverOpened = terminalPanel('terminal', pane.id, {});
    const h = harness([pane], [claude, shell, neverOpened]);

    const interrupted = await new PanelResume(h.deps).recoverAfterRestart();

    expect(interrupted).toEqual(['claude']);
    expect(h.state('claude')).toMatchObject({ isInitialized: false, isCliReady: false, wasInterrupted: true });
    expect(h.state('shell')).toMatchObject({ isInitialized: false });
    expect(h.state('shell').wasInterrupted).toBeUndefined();
    expect(h.state('terminal')).toEqual({});
  });

  it('leaves panels that are already running alone', async () => {
    const claude = terminalPanel('claude', pane.id, { initialCommand: 'claude', isInitialized: true });
    const h = harness([pane], [claude]);
    h.running.add('claude');

    expect(await new PanelResume(h.deps).recoverAfterRestart()).toEqual([]);
    expect(h.state('claude').isInitialized).toBe(true);
  });
});

describe('PanelResume.resumeInterruptedAgents', () => {
  it('starts interrupted agent panels of live Panes in their worktree, and skips archived Panes and shells', async () => {
    const archived: PanelResumeSession = { id: 'pane-2', worktreePath: '/repo/worktrees/b', archived: true };
    const panels = [
      terminalPanel('claude', pane.id, { initialCommand: 'claude', wasInterrupted: true, hasClaudeSessionId: true, agentSessionId: CLAUDE_ID }),
      terminalPanel('codex', pane.id, { initialCommand: 'codex', wasInterrupted: true, agentSessionId: 'abc' }),
      terminalPanel('shell', pane.id, { initialCommand: 'bash' }),
      terminalPanel('archived-claude', archived.id, { initialCommand: 'claude', wasInterrupted: true }),
    ];
    const h = harness([pane, archived], panels, { transcript: true });
    const resume = new PanelResume(h.deps);

    const status = await resume.resumeInterruptedAgents();

    expect(h.launches.map(launch => [launch.panelId, launch.cwd])).toEqual([
      ['claude', '/repo/worktrees/a'],
      ['codex', '/repo/worktrees/a'],
    ]);
    expect(status.phase).toBe('done');
    expect(status.panels.map(panel => [panel.panelId, panel.state])).toEqual([['claude', 'running'], ['codex', 'running']]);
    // The launch resolver turns these into `claude --resume <id>` and `codex resume <id>`.
    expect(h.launches[0]?.state).toMatchObject({ wasInterrupted: true, hasClaudeSessionId: true });
  });

  it('also resumes the orchestrator of a live Session, whose Pane is hidden, but no other hidden Pane', async () => {
    const orchestratorPane: PanelResumeSession = { id: '__orchestration_session_s1__terminal__', worktreePath: '/home/user/.pane_remote/sessions/s1', archived: false };
    const reservePane: PanelResumeSession = { id: 'reserve', worktreePath: '/repo/worktrees/_reserve', archived: false };
    const panels = [
      terminalPanel('orchestrator', orchestratorPane.id, { initialCommand: 'claude', agentType: 'claude', wasInterrupted: true, hasClaudeSessionId: true, agentSessionId: CLAUDE_ID }),
      terminalPanel('reserve-claude', reservePane.id, { initialCommand: 'claude', wasInterrupted: true }),
    ];
    const h = harness([pane], panels, { transcript: true, hidden: [orchestratorPane, reservePane] });
    const resume = new PanelResume(h.deps);
    resume.alsoResumePanes(() => [orchestratorPane.id, 'gone-pane']);

    const status = await resume.resumeInterruptedAgents();

    expect(h.launches.map(launch => [launch.panelId, launch.cwd])).toEqual([['orchestrator', orchestratorPane.worktreePath]]);
    expect(status.panels.map(panel => panel.panelId)).toEqual(['orchestrator']);
  });

  it('reports resuming, then done, to phase listeners', async () => {
    const h = harness([pane], [terminalPanel('claude', pane.id, { initialCommand: 'claude', wasInterrupted: true })]);
    const resume = new PanelResume(h.deps);
    const phases: string[] = [];
    resume.onPhaseChange(phase => phases.push(phase));

    const run = resume.resumeInterruptedAgents();
    expect(phases).toEqual(['resuming']);
    await run;
    expect(phases).toEqual(['resuming', 'done']);
  });

  it('starts a Claude panel without a transcript as a new conversation with the same id', async () => {
    const claude = terminalPanel('claude', pane.id, {
      initialCommand: 'claude', wasInterrupted: true, hasClaudeSessionId: true, agentSessionId: CLAUDE_ID,
    });
    const h = harness([pane], [claude], { transcript: false });

    await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(h.launches[0]?.state).toMatchObject({ hasClaudeSessionId: false, agentSessionId: CLAUDE_ID });
  });

  it('stops the agent an earlier daemon left running before resuming its panel', async () => {
    const claude = terminalPanel('claude', pane.id, {
      initialCommand: 'claude', wasInterrupted: true, hasClaudeSessionId: true, agentSessionId: CLAUDE_ID,
    });
    const h = harness([pane], [claude], { transcript: true, strays: { claude: { stopped: [374813, 374925] } } });

    const status = await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(h.deps.stopStrayProcesses).toHaveBeenCalledWith('claude');
    expect(status.panels).toEqual([expect.objectContaining({ panelId: 'claude', state: 'running' })]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('pids 374813, 374925'));
  });

  it('does not start a second agent while the earlier one survives', async () => {
    const claude = terminalPanel('claude', pane.id, { initialCommand: 'claude', wasInterrupted: true });
    const h = harness([pane], [claude], { strays: { claude: { stopped: [50], survivors: [50] } } });

    const status = await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(h.launches).toEqual([]);
    expect(status.panels).toEqual([expect.objectContaining({
      panelId: 'claude',
      state: 'failed',
      error: 'an earlier process for this panel is still running (pids 50)',
    })]);
  });

  it('records a failed start and keeps going', async () => {
    const panels = [
      terminalPanel('bad', pane.id, { initialCommand: 'claude', wasInterrupted: true }),
      terminalPanel('good', pane.id, { initialCommand: 'codex', wasInterrupted: true }),
    ];
    const h = harness([pane], panels);
    const start = h.deps.startTerminal;
    h.deps.startTerminal = async (panel, cwd) => {
      if (panel.id === 'bad') throw new Error('spawn failed');
      await start(panel, cwd);
    };

    const status = await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(status.panels).toEqual([
      expect.objectContaining({ panelId: 'bad', state: 'failed', error: 'spawn failed' }),
      expect.objectContaining({ panelId: 'good', state: 'running' }),
    ]);
  });
});

describe('PanelResume.ensureRunning', () => {
  it('starts a stopped shell on first use and waits for its launch', async () => {
    const shell = terminalPanel('shell', pane.id, { initialCommand: 'bash' });
    const h = harness([pane], [shell]);
    const resume = new PanelResume(h.deps);
    resume.enable();

    await resume.ensureRunning(shell, { waitMs: 1234 });

    expect(h.running.has('shell')).toBe(true);
    expect(h.deps.waitForLaunch).toHaveBeenCalledWith('shell', 1234);
  });

  it('leaves stray processes of a plain shell panel alone', async () => {
    const shell = terminalPanel('shell', pane.id, { initialCommand: 'bash' });
    const h = harness([pane], [shell]);
    const resume = new PanelResume(h.deps);
    resume.enable();

    await resume.ensureRunning(shell);

    expect(h.deps.stopStrayProcesses).not.toHaveBeenCalled();
  });

  it('shares one start between a resume in progress and a submit', async () => {
    const claude = terminalPanel('claude', pane.id, { initialCommand: 'claude', wasInterrupted: true });
    const h = harness([pane], [claude]);
    let finish: () => void = () => undefined;
    h.deps.startTerminal = vi.fn(async (panel: ToolPanel) => {
      await new Promise<void>(resolve => { finish = resolve; });
      h.running.add(panel.id);
    });
    const resume = new PanelResume(h.deps);
    resume.enable();

    const eager = resume.resumeInterruptedAgents();
    await Promise.resolve();
    expect(resume.runState(claude)).toBe('resuming');
    const submit = resume.ensureRunning(claude);
    await vi.waitFor(() => expect(h.deps.startTerminal).toHaveBeenCalled());
    finish();
    await Promise.all([eager, submit]);

    expect(h.deps.startTerminal).toHaveBeenCalledTimes(1);
    expect(resume.runState(claude)).toBe('running');
  });

  it('refuses with ERR_PANEL_NOT_RUNNING when lazy start is off or the Pane is archived', async () => {
    const archived: PanelResumeSession = { id: 'pane-2', worktreePath: '/b', archived: true };
    const claude = terminalPanel('claude', archived.id, {
      initialCommand: 'claude', wasInterrupted: true, hasClaudeSessionId: true, agentSessionId: CLAUDE_ID,
    });
    const h = harness([archived], [claude]);
    const resume = new PanelResume(h.deps);

    const disabled = await resume.ensureRunning(claude).then(() => undefined, (error: Error) => error);
    expect(disabled).toBeInstanceOf(PaneCommandError);
    expect(disabled).toMatchObject({
      code: 'ERR_PANEL_NOT_RUNNING',
      details: { panelId: 'claude', runState: 'interrupted', resumable: true },
    });

    resume.enable();
    await expect(resume.ensureRunning(claude)).rejects.toMatchObject({
      code: 'ERR_PANEL_NOT_RUNNING',
      details: { resumable: false },
    });
    expect(h.deps.startTerminal).not.toHaveBeenCalled();
  });

  it('refuses with ERR_PANEL_NOT_RUNNING when a restarted panel does not finish launching', async () => {
    const shell = terminalPanel('shell', pane.id, { initialCommand: 'bash' });
    const h = harness([pane], [shell]);
    h.deps.waitForLaunch = vi.fn(async () => false);
    const resume = new PanelResume(h.deps);
    resume.enable();

    await expect(resume.ensureRunning(shell, { waitMs: 50 })).rejects.toMatchObject({
      code: 'ERR_PANEL_NOT_RUNNING',
      details: { panelId: 'shell', runState: 'running' },
    });
  });

  it('refuses with ERR_PANEL_NOT_RUNNING when a running panel exits before its launch settles', async () => {
    const claude = terminalPanel('claude', pane.id, { initialCommand: 'claude', agentType: 'claude' });
    const h = harness([pane], [claude]);
    h.running.add('claude');
    h.deps.waitForLaunch = vi.fn(async (panelId: string) => {
      h.running.delete(panelId);
      return false;
    });
    const resume = new PanelResume(h.deps);
    resume.enable();

    await expect(resume.ensureRunning(claude)).rejects.toMatchObject({
      code: 'ERR_PANEL_NOT_RUNNING',
      details: { panelId: 'claude', runState: 'stopped' },
    });
    expect(h.deps.startTerminal).not.toHaveBeenCalled();
  });

  it('refuses with ERR_PANEL_NOT_RUNNING when a running panel never finishes launching', async () => {
    const claude = terminalPanel('claude', pane.id, { initialCommand: 'claude', agentType: 'claude' });
    const h = harness([pane], [claude]);
    h.running.add('claude');
    h.deps.waitForLaunch = vi.fn(async () => false);
    const resume = new PanelResume(h.deps);
    resume.enable();

    await expect(resume.ensureRunning(claude, { waitMs: 50 })).rejects.toMatchObject({
      code: 'ERR_PANEL_NOT_RUNNING',
      details: { panelId: 'claude', runState: 'running' },
    });
  });

  it('does not require a settled launch when the caller asks for no wait', async () => {
    const shell = terminalPanel('shell', pane.id, { initialCommand: 'bash' });
    const h = harness([pane], [shell]);
    h.deps.waitForLaunch = vi.fn(async () => false);
    const resume = new PanelResume(h.deps);
    resume.enable();

    await resume.ensureRunning(shell, { waitMs: 0 });

    expect(h.running.has('shell')).toBe(true);
  });
});

describe('hasResumableConversation', () => {
  it('is true only when a restart brings the conversation back', () => {
    expect(hasResumableConversation({ initialCommand: 'claude', hasClaudeSessionId: true, agentSessionId: CLAUDE_ID })).toBe(true);
    expect(hasResumableConversation({ initialCommand: 'claude', agentSessionId: CLAUDE_ID })).toBe(false);
    expect(hasResumableConversation({ initialCommand: 'codex', agentSessionId: 'abc' })).toBe(true);
    expect(hasResumableConversation({ initialCommand: 'bash' })).toBe(false);
    expect(hasResumableConversation({ initialCommand: 'worker.sh', agentType: 'claude', launchMode: 'wrapped', agentSessionId: CLAUDE_ID })).toBe(false);
  });
});
