import { describe, expect, it, vi } from 'vitest';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { PanelResume, terminalState, type PanelResumeDeps, type PanelResumeSession } from './panelResume';

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
    missingDirectories?: string[];
    /** Per panel: pids an earlier daemon left running, and which of them survive. */
    strays?: Map<string, { stopped: number[]; survivors?: number[] }>;
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
      byId.set(panel.id, { ...panel, state: { ...panel.state, customState } });
    },
    isRunning: id => running.has(id),
    startTerminal: vi.fn(async (panel: ToolPanel, cwd: string) => {
      launches.push({ panelId: panel.id, cwd, state: terminalState(panel) });
      running.add(panel.id);
    }),
    isDirectory: directoryPath => !options.missingDirectories?.includes(directoryPath),
    claudeTranscriptExists: () => options.transcript,
    stopStrayProcesses: vi.fn(async (panelId: string) => {
      const stray = options.strays?.get(panelId);
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

  it('covers hidden Panes and keeps agents an earlier start already marked', async () => {
    const hidden: PanelResumeSession = { id: 'hidden', worktreePath: '/repo', archived: false };
    const panels = [
      terminalPanel('hidden-claude', hidden.id, { initialCommand: 'claude', isInitialized: true }),
      terminalPanel('still-interrupted', pane.id, { initialCommand: 'codex', wasInterrupted: true }),
    ];
    const h = harness([pane], panels, { hidden: [hidden] });

    const interrupted = await new PanelResume(h.deps).recoverAfterRestart();

    expect(interrupted.sort()).toEqual(['hidden-claude', 'still-interrupted']);
    expect(h.state('hidden-claude').wasInterrupted).toBe(true);
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

    const results = await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(h.launches.map(launch => [launch.panelId, launch.cwd])).toEqual([
      ['claude', '/repo/worktrees/a'],
      ['codex', '/repo/worktrees/a'],
    ]);
    expect(results.map(result => [result.panelId, result.state])).toEqual([['claude', 'running'], ['codex', 'running']]);
    // The launch resolver turns these into `claude --resume <id>` and `codex resume <id>`.
    expect(h.launches[0]?.state).toMatchObject({ wasInterrupted: true, hasClaudeSessionId: true });
  });

  it('relaunches an agent in the folder it was started in, or in the worktree when that folder is gone', async () => {
    const panels = [
      terminalPanel('in-repo-root', pane.id, { initialCommand: 'claude', wasInterrupted: true, cwd: '/repo' }),
      terminalPanel('folder-gone', pane.id, { initialCommand: 'claude', wasInterrupted: true, cwd: '/tmp/removed' }),
      terminalPanel('never-recorded', pane.id, { initialCommand: 'codex', wasInterrupted: true }),
    ];
    const h = harness([pane], panels, { missingDirectories: ['/tmp/removed'] });

    await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(h.launches.map(launch => [launch.panelId, launch.cwd])).toEqual([
      ['in-repo-root', '/repo'],
      ['folder-gone', '/repo/worktrees/a'],
      ['never-recorded', '/repo/worktrees/a'],
    ]);
  });

  it('also resumes the orchestrator of a live Session, whose Pane is hidden, but no other hidden Pane', async () => {
    const orchestratorPane: PanelResumeSession = { id: '__orchestration_session_s1__terminal__', worktreePath: '/home/user/.pane/sessions/s1', archived: false };
    const reservePane: PanelResumeSession = { id: 'reserve', worktreePath: '/repo/worktrees/_reserve', archived: false };
    const panels = [
      terminalPanel('orchestrator', orchestratorPane.id, { initialCommand: 'claude', agentType: 'claude', wasInterrupted: true, hasClaudeSessionId: true, agentSessionId: CLAUDE_ID }),
      terminalPanel('reserve-claude', reservePane.id, { initialCommand: 'claude', wasInterrupted: true }),
    ];
    const h = harness([pane], panels, { transcript: true, hidden: [orchestratorPane, reservePane] });
    const resume = new PanelResume(h.deps);
    resume.alsoResumePanes(() => [orchestratorPane.id, 'gone-pane']);

    const results = await resume.resumeInterruptedAgents();

    expect(h.launches.map(launch => [launch.panelId, launch.cwd])).toEqual([['orchestrator', orchestratorPane.worktreePath]]);
    expect(results.map(result => result.panelId)).toEqual(['orchestrator']);
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
    const h = harness([pane], [claude], { transcript: true, strays: new Map([['claude', { stopped: [374813, 374925] }]]) });

    const results = await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(h.deps.stopStrayProcesses).toHaveBeenCalledWith('claude');
    expect(results).toEqual([expect.objectContaining({ panelId: 'claude', state: 'running' })]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('pids 374813, 374925'));
  });

  it('does not start a second agent while the earlier one survives', async () => {
    const claude = terminalPanel('claude', pane.id, { initialCommand: 'claude', wasInterrupted: true });
    const h = harness([pane], [claude], { strays: new Map([['claude', { stopped: [50], survivors: [50] }]]) });

    const results = await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(h.launches).toEqual([]);
    expect(results).toEqual([expect.objectContaining({
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

    const results = await new PanelResume(h.deps).resumeInterruptedAgents();

    expect(results).toEqual([
      expect.objectContaining({ panelId: 'bad', state: 'failed', error: 'spawn failed' }),
      expect.objectContaining({ panelId: 'good', state: 'running' }),
    ]);
  });
});
