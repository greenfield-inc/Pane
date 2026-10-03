import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from './sessionManager';
import type { Session } from '../types/session';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { HOST_TERMINAL_PANEL_ID, HOST_TERMINAL_SESSION_ID } from '../../../shared/types/hostTerminal';
import { getAppDirectory } from '../utils/appDirectory';

const panels = new Map<string, ToolPanel>();
const running = new Set<string>();

vi.mock('./panelManager', () => ({
  panelManager: {
    getPanel: vi.fn((id: string) => panels.get(id)),
    createPanel: vi.fn(async (request: { id: string; sessionId: string; title: string; initialState: TerminalPanelState }) => {
      const panel: ToolPanel = {
        id: request.id,
        sessionId: request.sessionId,
        type: 'terminal',
        title: request.title,
        state: { isActive: true, customState: request.initialState },
        metadata: { createdAt: '2026-10-03T00:00:00.000Z', lastActiveAt: '2026-10-03T00:00:00.000Z', position: 0 },
      };
      panels.set(panel.id, panel);
      return panel;
    }),
    updatePanel: vi.fn(async (id: string, update: Partial<ToolPanel>) => {
      const panel = panels.get(id);
      if (panel && update.state) panel.state = update.state;
    }),
    setActivePanel: vi.fn(async () => undefined),
  },
}));

vi.mock('./terminalPanelManager', () => ({
  terminalPanelManager: {
    isTerminalInitialized: vi.fn((id: string) => running.has(id)),
    initializeTerminal: vi.fn(async (panel: ToolPanel) => { running.add(panel.id); }),
    writeToTerminal: vi.fn(),
  },
}));

const { terminalPanelManager } = await import('./terminalPanelManager');
const { HostTerminalManager } = await import('./hostTerminalManager');

function createFixture() {
  const sessions = new Map<string, Session>();
  const createSessionWithId = vi.fn((id: string, name: string, worktreePath: string): Session => {
    const session: Session = {
      id,
      name,
      worktreePath,
      prompt: '',
      status: 'stopped',
      createdAt: new Date('2026-10-03T00:00:00.000Z'),
      output: [],
      jsonMessages: [],
      isHidden: true,
    };
    sessions.set(id, session);
    return session;
  });
  // SAFETY: The stub implements exactly the SessionManager methods the
  // host terminal reaches; any other call fails at its own site.
  const sessionManager = {
    getSession: vi.fn((id: string) => sessions.get(id)),
    createSessionWithId,
    updateSession: vi.fn(),
  } as Partial<SessionManager> as SessionManager;
  return { manager: new HostTerminalManager(sessionManager), createSessionWithId };
}

function customState(): TerminalPanelState | undefined {
  // SAFETY: The fixture panel was created with a TerminalPanelState.
  return panels.get(HOST_TERMINAL_PANEL_ID)?.state.customState as TerminalPanelState | undefined;
}

function writes(): string[] {
  return vi.mocked(terminalPanelManager.writeToTerminal).mock.calls.map(([, data]) => data);
}

describe('HostTerminalManager', () => {
  beforeEach(() => {
    panels.clear();
    running.clear();
    vi.clearAllMocks();
  });

  it('keeps one hidden, detached session under sessions/host-terminal', async () => {
    const { manager, createSessionWithId } = createFixture();

    const first = await manager.open();
    const second = await manager.open();

    expect(createSessionWithId).toHaveBeenCalledTimes(1);
    const workspace = path.join(getAppDirectory(), 'sessions', 'host-terminal');
    expect(createSessionWithId.mock.calls[0][0]).toBe(HOST_TERMINAL_SESSION_ID);
    expect(createSessionWithId.mock.calls[0][2]).toBe(workspace);
    // No project, and hidden from every session list.
    expect(createSessionWithId.mock.calls[0][6]).toBeUndefined();
    expect(createSessionWithId.mock.calls[0][13]).toEqual({ detached: true, hidden: true });
    expect(fs.statSync(workspace).isDirectory()).toBe(true);
    expect(second.session).toBe(first.session);
    expect(second.panel.id).toBe(HOST_TERMINAL_PANEL_ID);
  });

  it('starts one shell in the home folder and reuses it on reopen', async () => {
    const { manager } = createFixture();

    const opened = await manager.open();
    await manager.open();

    expect(opened.cwd).toBe(os.homedir());
    expect(opened.started).toBe(true);
    expect(terminalPanelManager.initializeTerminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(terminalPanelManager.initializeTerminal).mock.calls[0][1]).toBe(os.homedir());
    expect(customState()).toMatchObject({ isCliPanel: false });
    expect(customState()?.initialCommand).toBeUndefined();
  });

  it('types input into a running shell without pressing Enter', async () => {
    const { manager } = createFixture();
    await manager.open();

    await manager.open({ input: 'gh auth login --web --git-protocol https && gh auth setup-git\n' });

    expect(writes()).toEqual(['gh auth login --web --git-protocol https && gh auth setup-git']);
    expect(writes().join('')).not.toMatch(/[\r\n]/);
  });

  it('types input once a new shell starts, without pressing Enter', async () => {
    const { manager } = createFixture();

    await manager.open({ input: 'gh auth login\r\n' });

    expect(writes()).toEqual([]);
    expect(customState()).toMatchObject({ initialInput: 'gh auth login', initialInputSubmitStrategy: 'none' });
    expect(customState()?.initialInputSentAt).toBeUndefined();
  });

  it('reports the terminal read-only, without creating it', async () => {
    const { manager, createSessionWithId } = createFixture();

    expect(manager.get()).toBeNull();
    expect(createSessionWithId).not.toHaveBeenCalled();

    await manager.open();
    expect(manager.get()).toEqual({ sessionId: HOST_TERMINAL_SESSION_ID, panelId: HOST_TERMINAL_PANEL_ID, started: true });
  });
});
