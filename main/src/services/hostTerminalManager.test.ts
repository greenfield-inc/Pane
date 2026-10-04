import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionManager } from './sessionManager';
import type { Session } from '../types/session';
import type { CreatePanelRequest, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { HOST_TERMINAL_PANEL_ID, HOST_TERMINAL_SESSION_ID } from '../../../shared/types/hostTerminal';
import { getAppDirectory } from '../utils/appDirectory';
import { HostTerminalManager } from './hostTerminalManager';

function serviceStub<Service>(value: Partial<Service>): Service {
  // SAFETY: The fixture implements exactly the methods the host terminal
  // reaches; any other call fails at its own site.
  return value as Service;
}

function createFixture() {
  const panels = new Map<string, ToolPanel>();
  const running = new Set<string>();
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
  const sessionManager = serviceStub<SessionManager>({
    getSession: vi.fn((id: string) => sessions.get(id)),
    createSessionWithId,
    updateSession: vi.fn(),
  });
  const panelStore = {
    getPanel: vi.fn((id: string) => panels.get(id)),
    createPanel: vi.fn(async (request: CreatePanelRequest) => {
      const panel: ToolPanel = {
        id: request.id ?? 'unexpected',
        sessionId: request.sessionId,
        type: request.type,
        title: request.title ?? '',
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
  };
  const shells = {
    isTerminalInitialized: vi.fn((id: string) => running.has(id)),
    initializeTerminal: vi.fn(async (panel: ToolPanel, _cwd: string) => { running.add(panel.id); }),
    writeToTerminal: vi.fn(),
    // A started shell reports what it runs; one not started yet, what it would run.
    getShellPath: vi.fn((id: string) => (running.has(id) ? '/bin/bash' : '/usr/bin/zsh')),
  };
  return {
    manager: new HostTerminalManager(sessionManager, panelStore, shells),
    createSessionWithId,
    shells,
    customState(): TerminalPanelState | undefined {
      // SAFETY: The host terminal panel is created with a TerminalPanelState.
      return panels.get(HOST_TERMINAL_PANEL_ID)?.state.customState as TerminalPanelState | undefined;
    },
    writes(): string[] {
      return shells.writeToTerminal.mock.calls.map(([, data]: [string, string]) => data);
    },
  };
}

describe('HostTerminalManager', () => {
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
    const { manager, shells, customState } = createFixture();

    const opened = await manager.open();
    await manager.open();

    expect(opened.cwd).toBe(os.homedir());
    expect(opened.started).toBe(true);
    expect(shells.initializeTerminal).toHaveBeenCalledTimes(1);
    expect(shells.initializeTerminal.mock.calls[0][1]).toBe(os.homedir());
    expect(customState()).toMatchObject({ isCliPanel: false });
    expect(customState()?.initialCommand).toBeUndefined();
  });

  it('types input into a running shell without pressing Enter', async () => {
    const { manager, writes } = createFixture();
    await manager.open();

    await manager.open({ input: 'gh auth login --web --git-protocol https && gh auth setup-git\n' });

    // The line is cleared first (Ctrl-E Ctrl-U), so a second prefill replaces the first.
    expect(writes()).toEqual(['\x05\x15gh auth login --web --git-protocol https && gh auth setup-git']);
    expect(writes().join('')).not.toMatch(/[\r\n]/);
  });

  it('types input once a new shell starts, without pressing Enter', async () => {
    const { manager, writes, customState } = createFixture();

    await manager.open({ input: 'gh auth login\r\n' });

    expect(writes()).toEqual([]);
    expect(customState()).toMatchObject({ initialInput: 'gh auth login', initialInputSubmitStrategy: 'none' });
    expect(customState()?.initialInputSentAt).toBeUndefined();
  });

  it('starts a new shell with the environment the saved host asks for', async () => {
    const { manager, shells, customState } = createFixture();

    await manager.open({ env: [{ name: 'BROWSER', value: 'false' }, { name: 'GH_BROWSER', value: 'false' }] });

    expect(customState()?.environmentVars).toEqual({ BROWSER: 'false', GH_BROWSER: 'false' });
    // Stored before the spawn, so the shell starts with it.
    expect(shells.initializeTerminal.mock.calls[0][0].state.customState).toMatchObject({
      environmentVars: { BROWSER: 'false', GH_BROWSER: 'false' },
    });
  });

  it('keeps a running shell and stores the environment for its next start', async () => {
    const { manager, shells, customState } = createFixture();
    await manager.open();

    await manager.open({ env: [{ name: 'BROWSER', value: 'false' }] });

    expect(shells.initializeTerminal).toHaveBeenCalledTimes(1);
    expect(customState()?.environmentVars).toEqual({ BROWSER: 'false' });
  });

  it('rejects a variable name a shell could not export, changing nothing', async () => {
    const { manager, createSessionWithId } = createFixture();

    await expect(manager.open({ env: [{ name: 'BROWSER=x; rm', value: 'false' }] })).rejects.toThrow('not an environment variable name');
    expect(createSessionWithId).not.toHaveBeenCalled();
  });

  it('reports the terminal read-only, without creating it', async () => {
    const { manager, createSessionWithId } = createFixture();

    expect(manager.get()).toBeNull();
    expect(manager.shell()).toBe('/usr/bin/zsh');
    expect(createSessionWithId).not.toHaveBeenCalled();

    const opened = await manager.open();
    expect(opened.shell).toBe('/bin/bash');
    expect(manager.get()).toEqual({ sessionId: HOST_TERMINAL_SESSION_ID, panelId: HOST_TERMINAL_PANEL_ID, started: true, shell: '/bin/bash' });
    expect(manager.shell()).toBe('/bin/bash');
  });
});
