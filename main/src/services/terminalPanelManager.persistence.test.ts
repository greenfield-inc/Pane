import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPaneRuntimeForTests, setPaneRuntime, type PtyHandleLike, type PtyHostRuntime } from '../core/runtime';
import type { PaneEventArgument } from '../core/eventSink';
import type { PtyHostSpawnOpts } from '../ptyHost/types';
import type { ToolPanel } from '../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PANEL_STATE_CEILING_BYTES } from '../database/database';
import { splitPanelBufferState } from '../database/panelBuffers';
import { trimAnsiSafe } from '../utils/ansiTrim';
import { ConfigManager } from './configManager';
import { databaseService } from './database';
import { panelManager as panelManagerMock } from '../test/setup';
import { inProcessEmulatorHost } from '../test/inProcessEmulatorHost';
import { MAX_RESTORE_PAYLOAD_SIZE, TerminalPanelManager } from './terminalPanelManager';

/** In-process stand-in for a ptyHost PTY: output is whatever the test emits. */
class FakePtyHandle implements PtyHandleLike {
  readonly pid = 4242;
  readonly written: string[] = [];
  private readonly listeners = new Set<(data: string) => void>();

  constructor(readonly id: string) {}

  onData(listener: (data: string) => void) {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  onExit() {
    return { dispose: () => undefined };
  }

  async write(data: string): Promise<void> {
    this.written.push(data);
  }

  async resize(): Promise<void> {}
  async kill(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}

  emit(data: string): void {
    for (const listener of this.listeners) listener(data);
  }
}

class FakePtyHost implements PtyHostRuntime {
  readonly handles = new Map<string, FakePtyHandle>();

  async spawn(_opts: PtyHostSpawnOpts): Promise<{ ptyId: string; pid: number }> {
    const ptyId = `pty-${this.handles.size + 1}`;
    const handle = new FakePtyHandle(ptyId);
    this.handles.set(ptyId, handle);
    return { ptyId, pid: handle.pid };
  }

  async write(): Promise<void> {}
  async resize(): Promise<void> {}
  async kill(): Promise<void> {}
  async ack(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}

  getHandle(ptyId: string): PtyHandleLike | undefined {
    return this.handles.get(ptyId);
  }

  latest(): FakePtyHandle {
    const handle = Array.from(this.handles.values()).at(-1);
    if (!handle) throw new Error('no pty spawned');
    return handle;
  }
}

interface RendererEvent {
  channel: string;
  args: PaneEventArgument[];
}

const persistedStateSchema = boundary.object({
  customState: boundary.object({
    scrollbackBuffer: boundary.optional(boundary.union(boundary.string, boundary.array(boundary.string))),
    alternateScreenBuffer: boundary.optional(boundary.string),
    serializedBuffer: boundary.optional(boundary.string),
    isAlternateScreen: boundary.optional(boundary.boolean),
    lastActivityTime: boundary.optional(boundary.string),
  }),
});

const restoreCustomStateSchema = boundary.object({
  cwd: boundary.optional(boundary.string),
  lastActivityTime: boundary.optional(boundary.string),
});

const outputEventSchema = boundary.object({ panelId: boundary.string, output: boundary.string });

function makePanel(id: string): ToolPanel {
  return {
    id,
    sessionId: 'session',
    type: 'terminal',
    title: 'Terminal',
    state: { isActive: false, hasBeenViewed: true, customState: {} },
    metadata: { createdAt: '2026-09-11T00:00:00.000Z', lastActiveAt: '2026-09-11T00:00:00.000Z', position: 0 },
  };
}

describe('terminal panel persistence', () => {
  let tempDir: string;
  let ptyHost: FakePtyHost;
  let events: RendererEvent[];
  let managers: TerminalPanelManager[];
  let lastPersisted: ToolPanel['state'] | null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-terminal-persistence-'));
    ptyHost = new FakePtyHost();
    events = [];
    managers = [];
    lastPersisted = null;
    const configManager = new ConfigManager();
    vi.spyOn(configManager, 'getUsePtyHost').mockReturnValue(true);
    setPaneRuntime({
      eventSink: {
        send: (channel, ...args) => {
          events.push({ channel, args });
        },
      },
      getConfigManager: () => configManager,
      getPtyHostRuntime: () => ptyHost,
      getWebviewContextMap: () => new Map(),
    });
    panelManagerMock.updatePanel.mockImplementation(async (_panelId: string, updates: Partial<ToolPanel>) => {
      if (updates.state) lastPersisted = updates.state;
    });
    if (!databaseService.getSession('session')) {
      databaseService.createSession({
        id: 'session', name: 'session', initial_prompt: '', worktree_name: 'session',
        worktree_path: tempDir, project_id: null, tool_type: 'none',
      });
    }
  });

  afterEach(() => {
    for (const manager of managers) {
      for (const panelId of manager.getActiveTerminals()) manager.destroyTerminal(panelId);
    }
    panelManagerMock.updatePanel.mockReset();
    panelManagerMock.getPanel.mockReset();
    resetPaneRuntimeForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startTerminal(panel: ToolPanel): Promise<{ manager: TerminalPanelManager; handle: FakePtyHandle }> {
    const manager = new TerminalPanelManager(inProcessEmulatorHost);
    managers.push(manager);
    panelManagerMock.getPanel.mockReturnValue(panel);
    if (!databaseService.getPanel(panel.id)) {
      databaseService.createPanel({ id: panel.id, sessionId: panel.sessionId, type: 'terminal', title: panel.title, state: panel.state });
    }
    await manager.initializeTerminal(panel, tempDir);
    return { manager, handle: ptyHost.latest() };
  }

  it.each([
    { agentType: 'claude', initialCommand: 'claude --dangerously-skip-permissions', agentSessionId: '22222222-2222-4222-8222-222222222222', expected: 'claude --resume "22222222-2222-4222-8222-222222222222" --dangerously-skip-permissions' },
    { agentType: 'codex', initialCommand: 'codex --yolo', agentSessionId: 'thread-1', expected: 'codex resume --yolo "thread-1"' },
    { agentType: 'cursor', initialCommand: 'cursor-agent --force --trust', agentSessionId: 'chat-1', expected: 'cursor-agent --force --trust --resume "chat-1"' },
  ] as const)('launches and stages an adopted $agentType conversation through the same resolver', async ({ expected, ...identity }) => {
    vi.useFakeTimers();
    try {
      const panel = makePanel(`adopt-${identity.agentType}`);
      panel.state.customState = { ...identity, hasClaudeSessionId: identity.agentType === 'claude' };
      const { manager, handle } = await startTerminal(panel);
      handle.emit('$ ');
      await vi.advanceTimersByTimeAsync(500);
      expect(handle.written).toContain(`${expected}\r`);
      handle.written.length = 0;
      await manager.stageInitialCommand(panel.id, identity.initialCommand);
      expect(handle.written).toEqual([expected]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('passes an explicit Claude id literally instead of selecting a different conversation', async () => {
    vi.useFakeTimers();
    try {
      const panel = makePanel('explicit-adopt-claude');
      panel.state.customState = {
        agentType: 'claude', agentSessionId: 'session$1', hasClaudeSessionId: true,
        initialCommand: 'claude --dangerously-skip-permissions',
      };
      const { handle } = await startTerminal(panel);
      handle.emit('$ ');
      await vi.advanceTimersByTimeAsync(500);
      expect(handle.written).toContain('claude --resume "session\\$1" --dangerously-skip-permissions\r');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not append a second resume argument to an existing adopted Cursor command', async () => {
    vi.useFakeTimers();
    try {
      const panel = makePanel('legacy-adopt-cursor');
      panel.state.customState = {
        agentType: 'cursor', agentSessionId: 'chat-1', wasInterrupted: true,
        initialCommand: 'cursor-agent --force --trust --resume "chat-1"',
      };
      const { handle } = await startTerminal(panel);
      handle.emit('$ ');
      await vi.advanceTimersByTimeAsync(500);
      expect(handle.written).toContain('cursor-agent --force --trust --resume "chat-1"\r');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('streams 50 MB of newline-free alternate-screen frames without growing the persisted state', async () => {
    const panel = makePanel('panel-frames');
    const { manager, handle } = await startTerminal(panel);
    manager.setVisibility(panel.id, false);

    handle.emit('\x1b[?1049h');
    const frame = `\x1b[1;1H\x1b[2K${'⠋ '.repeat(40)}\x1b[2;1H\x1b[38;5;208m${'x'.repeat(200)}\x1b[0m`.padEnd(4096, ' ');
    expect(frame).not.toMatch(/[\r\n]/);
    const target = 50 * 1024 * 1024;
    let sent = 0;
    for (let index = 0; sent < target; index += 1) {
      handle.emit(frame);
      sent += frame.length;
      // A real PTY delivers between event-loop turns; let the emulator drain
      // so xterm's write buffer never trips its discard watermark.
      if (index % 256 === 0) await manager.waitForTerminalState(panel.id);
    }

    expect(manager.getTerminalSnapshot(panel.id)?.currentCommand.length ?? 0).toBeLessThanOrEqual(4096);

    await manager.saveTerminalState(panel.id);
    expect(lastPersisted).not.toBeNull();
    const persisted = lastPersisted ?? { isActive: false };
    expect(persisted.customState).not.toHaveProperty('lastActiveCommand');
    expect(persisted.customState).not.toHaveProperty('commandHistory');
    expect(JSON.stringify(splitPanelBufferState(persisted).state).length).toBeLessThan(PANEL_STATE_CEILING_BYTES);

    expect(databaseService.updatePanel(panel.id, { state: persisted })).toBe(true);
    const storedBytes = decodeBoundary(
      databaseService.getDb().prepare('SELECT LENGTH(CAST(state AS BLOB)) AS bytes FROM tool_panels WHERE id = ?').get(panel.id),
      boundary.object({ bytes: boundary.number }),
    ).bytes;
    expect(storedBytes).toBeLessThan(PANEL_STATE_CEILING_BYTES);
    expect(databaseService.getPanelBuffers(panel.id)?.alternate?.length ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it('caps the in-memory command accumulator at 4 KB on the normal screen', async () => {
    const panel = makePanel('panel-accumulator');
    const { manager, handle } = await startTerminal(panel);
    manager.setVisibility(panel.id, false);

    for (let index = 0; index < 512; index += 1) handle.emit('\x1b[2K\x1b[Gprogress '.padEnd(1024, '.'));
    expect(manager.getTerminalSnapshot(panel.id)?.currentCommand.length ?? Infinity).toBeLessThanOrEqual(4096);

    handle.emit('git status\r\n');
    expect(manager.getTerminalSnapshot(panel.id)?.currentCommand).toBe('');
  });

  it.each(['normal', 'alternate'] as const)('replays the same bytes after a manager restart (%s screen)', async (mode) => {
    const panel = makePanel(`panel-restore-${mode}`);
    const { manager: first, handle } = await startTerminal(panel);
    handle.emit('$ echo hello\r\nhello\r\n$ ');
    if (mode === 'alternate') handle.emit('\x1b[?1049h\x1b[1;1H\x1b[2Kfull screen app frame');

    await first.saveTerminalState(panel.id);
    const saved = decodeBoundary(lastPersisted, persistedStateSchema).customState;
    const oldScrollback = Array.isArray(saved.scrollbackBuffer) ? saved.scrollbackBuffer.join('\n') : saved.scrollbackBuffer ?? '';
    expect(oldScrollback.length).toBeGreaterThan(0);
    expect(saved.isAlternateScreen).toBe(mode === 'alternate');
    if (mode === 'alternate') expect(saved.alternateScreenBuffer).toContain('full screen app frame');

    // The old path persisted the buffers inside the state JSON; the new path
    // routes the same write into panel_buffers.
    expect(lastPersisted).not.toBeNull();
    expect(databaseService.updatePanel(panel.id, { state: lastPersisted ?? { isActive: false } })).toBe(true);
    first.destroyTerminal(panel.id);

    const second = new TerminalPanelManager(inProcessEmulatorHost);
    managers.push(second);
    const reloaded = databaseService.getPanel(panel.id);
    expect(reloaded?.state.customState).not.toHaveProperty('scrollbackBuffer');
    expect(reloaded?.state.customState).not.toHaveProperty('serializedBuffer');
    expect(reloaded?.state.customState).not.toHaveProperty('alternateScreenBuffer');
    const restoreState = decodeBoundary(reloaded?.state.customState, restoreCustomStateSchema);

    events.length = 0;
    await second.restoreTerminalState(makePanel(panel.id), restoreState);

    const replay = events.find((event) => event.channel === 'terminal:output');
    const output = decodeBoundary(replay?.args[0], outputEventSchema);
    const restorationMsg = `\r\n[Session Restored from ${saved.lastActivityTime}]\r\n`;
    expect(output.output).toBe(trimAnsiSafe(oldScrollback, MAX_RESTORE_PAYLOAD_SIZE) + restorationMsg);
    expect(ptyHost.latest().written).toContain(restorationMsg);

    const snapshot = second.getTerminalSnapshot(panel.id);
    expect(snapshot?.scrollbackBuffer).toBe(oldScrollback);
    expect(snapshot?.alternateScreenBuffer).toBe(saved.alternateScreenBuffer ?? '');
  });
});
