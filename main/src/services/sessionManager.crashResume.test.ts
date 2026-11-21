import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database';
import { SessionManager } from './sessionManager';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { markAgentsInterruptedForQuit } from './terminalShutdown';

const CLAUDE_CONVERSATION = '0c4c1f2e-4b1b-4e8e-9c4a-2f8f5b8a1d11';
const CODEX_CONVERSATION = '019a1f2e-4b1b-7e8e-9c4a-2f8f5b8a1d22';

/**
 * Pane can die at any instant: a crash, a kill, a forced exit when quit times out. What a tab
 * wrote while its agent ran is all the next start has to go on.
 */
describe('agent tabs after Pane dies without a clean quit', () => {
  let tempDir: string;
  let db: DatabaseService;
  let projectId: number;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-crash-resume-'));
    db = new DatabaseService(path.join(tempDir, 'sessions.db'));
    db.initialize();
    projectId = db.createProject('repo', tempDir).id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function pane(id: string, status: 'stopped' | 'running' | 'pending' | 'interrupted', tabs: Record<string, TerminalPanelState>): void {
    db.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: tempDir, project_id: projectId, tool_type: 'none' });
    db.updateSession(id, { status });
    for (const [tab, customState] of Object.entries(tabs)) {
      db.createPanel({ id: `${id}:${tab}`, sessionId: id, type: 'terminal', title: tab, state: { isActive: false, customState } });
    }
  }

  /** The next Pane start: a fresh manager over the same database. */
  function restart(): SessionManager {
    const manager = new SessionManager(db);
    manager.initializeFromDatabase();
    return manager;
  }

  const liveClaude: TerminalPanelState = { agentType: 'claude', initialCommand: 'claude', agentSessionId: CLAUDE_CONVERSATION, hasClaudeSessionId: true, agentLive: true };
  const liveCodex: TerminalPanelState = { agentType: 'codex', initialCommand: 'codex', agentSessionId: CODEX_CONVERSATION, agentLive: true };

  it('offers a live agent tab for resume on its own conversation, whatever status the Pane was stored with', () => {
    // Agent-tab Panes are stored `stopped` (their live status follows their terminals); legacy ones `running`.
    pane('stored-stopped', 'stopped', { claude: liveClaude });
    pane('stored-running', 'running', { codex: liveCodex });

    const manager = restart();

    expect(manager.getResumableSessions(projectId)).toEqual(expect.arrayContaining([
      { sessionId: 'stored-stopped', sessionName: 'stored-stopped', panels: [{ panelId: 'stored-stopped:claude', panelType: 'terminal', resumeId: CLAUDE_CONVERSATION }] },
      { sessionId: 'stored-running', sessionName: 'stored-running', panels: [{ panelId: 'stored-running:codex', panelType: 'terminal', resumeId: CODEX_CONVERSATION }] },
    ]));
    expect(db.getSession('stored-stopped')?.status).toBe('interrupted');
  });

  it('offers a live agent tab after a quit its safety timeout cut short after the first step', async () => {
    pane('quit-cut-short', 'stopped', { claude: liveClaude });
    // The quit's first step ran; the daemon stop, Ctrl+C and Phase 2 never finished.
    await markAgentsInterruptedForQuit(
      ['quit-cut-short:claude'],
      panelId => db.getPanel(panelId) ?? undefined,
      async (panelId, updates) => { db.updatePanel(panelId, updates); },
      paneId => db.updateSession(paneId, { status: 'interrupted' }),
    );

    expect(restart().getResumableSessions(projectId)).toEqual([
      { sessionId: 'quit-cut-short', sessionName: 'quit-cut-short', panels: [{ panelId: 'quit-cut-short:claude', panelType: 'terminal', resumeId: CLAUDE_CONVERSATION }] },
    ]);
  });

  it('offers a tab resumed after an earlier restart, though its Pane still reads interrupted', () => {
    // The person opened the tab after the last restart (its launch cleared `wasInterrupted`), then Pane died again.
    pane('resumed-earlier', 'interrupted', { claude: liveClaude });

    expect(restart().getResumableSessions(projectId).map(session => session.sessionId)).toEqual(['resumed-earlier']);
  });

  it("keeps a Session chat tab's conversation for the Session to resume, outside the Resume dialog", () => {
    db.createSession({ id: 'session-chat', name: 'Session', initial_prompt: '', worktree_name: 'session-chat', worktree_path: tempDir, project_id: projectId, tool_type: 'none', is_hidden: true });
    db.createPanel({ id: 'session-chat:codex', sessionId: 'session-chat', type: 'terminal', title: 'Session · Codex', state: { isActive: false, customState: { ...liveCodex, orchestrationSessionId: 'session-1' } } });

    const manager = restart();

    // The Session reopens its own tab, which resumes the saved conversation.
    expect(manager.getResumableSessions(projectId)).toEqual([]);
    expect(db.getPanel('session-chat:codex')?.state.customState).toMatchObject({ wasInterrupted: true, agentSessionId: CODEX_CONVERSATION, agentLive: false });
  });

  it('does not offer a tab whose agent ended on purpose, and leaves its Pane stopped', () => {
    // A closed tab is gone; an agent that exited to its shell, or a dismissed resume, left no live mark.
    pane('ended', 'running', {
      exited: { agentType: 'claude', initialCommand: 'claude', agentSessionId: CLAUDE_CONVERSATION, hasClaudeSessionId: true },
      shell: { initialCommand: 'pwsh', agentLive: true },
    });

    expect(restart().getResumableSessions(projectId)).toEqual([]);
    expect(db.getSession('ended')?.status).toBe('stopped');
  });

  it('keeps a paused tab paused and out of the Resume dialog', () => {
    const paused = { at: '2026-11-04T12:00:00.000Z', by: 'manual' as const };
    pane('paused', 'stopped', { claude: { ...liveClaude, paused } });

    const manager = restart();

    expect(manager.getResumableSessions(projectId)).toEqual([]);
    expect(manager.getSession('paused')?.paused).toEqual(paused);
  });
});
