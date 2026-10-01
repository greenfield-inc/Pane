import fs from 'fs';
import os from 'os';
import path from 'path';
import * as pty from '@lydell/node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPaneRuntimeForTests, setPaneRuntime, type PtyHandleLike, type PtyHostRuntime } from '../core/runtime';
import type { PaneEventArgument } from '../core/eventSink';
import type { PtyHostSpawnOpts } from '../ptyHost/types';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { DatabaseService, PANEL_STATE_CEILING_BYTES } from '../database/database';
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

class FakeLegacyPty {
  readonly pid = 4343;
  readonly process = 'fake-shell';
  readonly written: string[] = [];
  cols = 80;
  rows = 30;
  handleFlowControl = false;
  private readonly listeners = new Set<(data: string) => void>();

  onData(listener: (data: string) => void) {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  onExit() {
    return { dispose: () => undefined };
  }

  write(data: string | Buffer): void {
    this.written.push(Buffer.isBuffer(data) ? data.toString() : data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  clear(): void {}
  kill(): void {}
  pause(): void {}
  resume(): void {}

  emit(data: string): void {
    for (const listener of this.listeners) listener(data);
  }
}

class FakePtyHost implements PtyHostRuntime {
  readonly handles = new Map<string, FakePtyHandle>();
  readonly spawnOptions: PtyHostSpawnOpts[] = [];
  onSpawn?: () => void;
  spawnError?: Error;

  async spawn(opts: PtyHostSpawnOpts): Promise<{ ptyId: string; pid: number }> {
    this.spawnOptions.push(opts);
    this.onSpawn?.();
    if (this.spawnError) throw this.spawnError;
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
  let configManager: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-terminal-persistence-'));
    ptyHost = new FakePtyHost();
    events = [];
    managers = [];
    lastPersisted = null;
    configManager = new ConfigManager();
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
    panelManagerMock.updatePanel.mockImplementation(async (panelId: string, updates: Partial<ToolPanel>) => {
      if (updates.state) {
        lastPersisted = updates.state;
        databaseService.updatePanel(panelId, { state: updates.state });
      }
    });
    if (!databaseService.getSession('session')) {
      databaseService.createSession({
        id: 'session', name: 'session', initial_prompt: '', worktree_name: 'session',
        worktree_path: tempDir, project_id: null, tool_type: 'none',
      });
    }
  });

  afterEach(async () => {
    for (const manager of managers) {
      for (const panelId of manager.getActiveTerminals()) await manager.destroyTerminal(panelId);
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

  function makeOpenCodePanel(id: string, customState: Partial<TerminalPanelState> = {}): ToolPanel {
    const panel = makePanel(id);
    panel.state.customState = {
      agentType: 'opencode',
      initialCommand: 'opencode --auto',
      ...customState,
    };
    return panel;
  }

  function createPanelFixture(panel: ToolPanel): void {
    if (!databaseService.getPanel(panel.id)) {
      databaseService.createPanel({ id: panel.id, sessionId: panel.sessionId, type: 'terminal', title: panel.title, state: panel.state });
    }
  }

function emitOpenCodeIdleFrame(handle: FakePtyHandle): void {
  handle.emit('\x1b[2J\x1b[H\x1b]2;OpenCode\x07');
  handle.emit('  ┃\r\n  ┃  Ask anything…\r\n  ┃\r\n  ┃  Build\r\n');
  handle.emit(`  ╹${'▀'.repeat(44)}\r\n`);
  handle.emit('  [project]         shift+tab agents  ctrl+p commands\r\n');
}

  it('persists an OpenCode id before the PTY host observes spawn', async () => {
    const panel = makeOpenCodePanel('opencode-before-spawn');
    let stateAtSpawn: ToolPanel['state'] | null = null;
    ptyHost.onSpawn = () => { stateAtSpawn = lastPersisted; };

    await startTerminal(panel);

    expect(stateAtSpawn?.customState).toMatchObject({
      agentType: 'opencode',
      agentSessionId: expect.stringMatching(/^ses_[A-Za-z0-9]+$/),
    });
    expect(panel.state.customState?.agentSessionId).toBe(stateAtSpawn?.customState?.agentSessionId);
  });

  it('does not spawn a PTY when hard OpenCode persistence fails', async () => {
    const panel = makeOpenCodePanel('opencode-persist-failure');
    panelManagerMock.updatePanel.mockRejectedValueOnce(new Error('database unavailable'));
    const manager = new TerminalPanelManager(inProcessEmulatorHost);
    managers.push(manager);
    panelManagerMock.getPanel.mockReturnValue(panel);

    await expect(manager.initializeTerminal(panel, tempDir)).rejects.toThrow('database unavailable');

    expect(ptyHost.spawnOptions).toHaveLength(0);
    expect(ptyHost.handles.size).toBe(0);
  });

  it('does not spawn when the database refuses the OpenCode identity write', async () => {
    const panel = makeOpenCodePanel('opencode-refused-persistence', {
      agentSessionId: 'ses_AlreadyDurable123',
    });
    createPanelFixture(panel);
    panel.state.customState = {
      ...panel.state.customState,
      initialInput: 'x'.repeat(PANEL_STATE_CEILING_BYTES),
    };
    const manager = new TerminalPanelManager(inProcessEmulatorHost);
    managers.push(manager);
    panelManagerMock.getPanel.mockReturnValue(panel);

    await expect(manager.initializeTerminal(panel, tempDir)).rejects.toThrow(
      'OpenCode session persistence was not acknowledged',
    );

    expect(databaseService.getPanel(panel.id)?.state.customState?.agentSessionId).toBe('ses_AlreadyDurable123');
    expect(ptyHost.spawnOptions).toHaveLength(0);
  });

  it('does not write a staged OpenCode launch when its state write is refused', async () => {
    const panel = makePanel('opencode-stage-refused');
    createPanelFixture(panel);
    const { manager, handle } = await startTerminal(panel);
    handle.written.length = 0;
    panelManagerMock.getPanel.mockReturnValue(panel);
    vi.spyOn(databaseService, 'updatePanel').mockReturnValue(false);

    try {
      await expect(manager.stageInitialCommand(panel.id, 'opencode --auto')).rejects.toThrow(
        'OpenCode session persistence was not acknowledged',
      );
      expect(handle.written).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reuses and writes a successfully acknowledged staged OpenCode launch', async () => {
    const panel = makePanel('opencode-stage-success');
    panel.state.customState = { agentType: 'opencode', agentSessionId: 'ses_Stage123' };
    createPanelFixture(panel);
    const { manager, handle } = await startTerminal(panel);
    handle.written.length = 0;

    await manager.stageInitialCommand(panel.id, 'opencode --auto');

    expect(handle.written).toEqual(['opencode --auto --session "ses_Stage123"']);
    expect(panel.state.customState?.agentSessionId).toBe('ses_Stage123');
  });

  it('deduplicates overlapping initialization and resolves the authoritative panel once', async () => {
    const canonical = makeOpenCodePanel('opencode-overlap');
    createPanelFixture(canonical);
    const firstSnapshot = structuredClone(canonical);
    const secondSnapshot = structuredClone(canonical);
    panelManagerMock.getPanel.mockReturnValue(canonical);
    let releaseWrite!: () => void;
    let observeWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const writeObserved = new Promise<void>(resolve => { observeWrite = resolve; });
    let writes = 0;
    panelManagerMock.updatePanel.mockImplementation(async (panelId: string, updates: Partial<ToolPanel>) => {
      if (!updates.state) return;
      writes += 1;
      if (writes === 1) {
        observeWrite();
        await writeGate;
      }
      lastPersisted = updates.state;
      databaseService.updatePanel(panelId, { state: updates.state });
    });
    const manager = new TerminalPanelManager(inProcessEmulatorHost);
    managers.push(manager);

    const first = manager.initializeTerminal(firstSnapshot, tempDir);
    await writeObserved;
    const second = manager.initializeTerminal(secondSnapshot, tempDir);
    releaseWrite();
    await Promise.all([first, second]);

    const persistedId = databaseService.getPanel(canonical.id)?.state.customState?.agentSessionId;
    expect(persistedId).toMatch(/^ses_[A-Za-z0-9]+$/);
    expect(canonical.state.customState?.agentSessionId).toBe(persistedId);
    expect(ptyHost.spawnOptions).toHaveLength(1);
    expect(manager.getActiveTerminals()).toEqual([canonical.id]);
  });

  it('rejects a malformed selector before spawn and recovers the spawn slot', async () => {
    const malformed = makeOpenCodePanel('opencode-malformed', {
      initialCommand: 'opencode --auto --session',
    });
    const valid = makeOpenCodePanel('opencode-after-malformed', {
      agentSessionId: 'ses_AfterMalformed123',
    });
    createPanelFixture(malformed);
    createPanelFixture(valid);
    const panels = new Map([[malformed.id, malformed], [valid.id, valid]]);
    panelManagerMock.getPanel.mockImplementation(panelId => panels.get(panelId));
    const manager = new TerminalPanelManager(inProcessEmulatorHost);
    managers.push(manager);

    await expect(manager.initializeTerminal(malformed, tempDir)).rejects.toThrow(
      'OpenCode --session selector is missing its operand',
    );
    expect(ptyHost.spawnOptions).toHaveLength(0);

    await manager.initializeTerminal(valid, tempDir);
    expect(ptyHost.spawnOptions).toHaveLength(1);
  });

  it('persists an OpenCode id before legacy PTY spawn', async () => {
    const panel = makeOpenCodePanel('opencode-before-legacy-spawn');
    createPanelFixture(panel);
    panelManagerMock.getPanel.mockReturnValue(panel);
    vi.spyOn(configManager, 'getUsePtyHost').mockReturnValue(false);
    const legacyPty = new FakeLegacyPty();
    let stateAtSpawn: ToolPanel['state'] | null = null;
    const spawn = vi.spyOn(pty, 'spawn').mockImplementation(() => {
      stateAtSpawn = databaseService.getPanel(panel.id)?.state ?? null;
      // SAFETY: FakeLegacyPty implements the IPty methods exercised by this test.
      return legacyPty as pty.IPty;
    });
    const manager = new TerminalPanelManager(inProcessEmulatorHost);
    managers.push(manager);

    try {
      await manager.initializeTerminal(panel, tempDir);
    } finally {
      spawn.mockRestore();
    }

    expect(stateAtSpawn?.customState?.agentSessionId).toMatch(/^ses_[A-Za-z0-9]+$/);
  });

  it('keeps the persisted OpenCode id when spawn fails and reuses it on retry', async () => {
    vi.useFakeTimers();
    try {
      const panel = makeOpenCodePanel('opencode-spawn-failure');
      createPanelFixture(panel);
      const manager = new TerminalPanelManager(inProcessEmulatorHost);
      managers.push(manager);
      panelManagerMock.getPanel.mockReturnValue(panel);
      ptyHost.spawnError = new Error('host spawn failed');

      await expect(manager.initializeTerminal(panel, tempDir)).rejects.toThrow('host spawn failed');
      const allocatedId = panel.state.customState?.agentSessionId;
      expect(allocatedId).toMatch(/^ses_[A-Za-z0-9]+$/);
      expect(lastPersisted?.customState?.agentSessionId).toBe(allocatedId);

      ptyHost.spawnError = undefined;
      await manager.initializeTerminal(panel, tempDir);
      const handle = ptyHost.latest();
      handle.emit('$ ');
      await vi.advanceTimersByTimeAsync(500);

      expect(panel.state.customState?.agentSessionId).toBe(allocatedId);
      expect(handle.written.join('')).toContain(`--session "${allocatedId}"`);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reuses the database-persisted OpenCode id when reconstructing a missing PTY', async () => {
    vi.useFakeTimers();
    const dbPath = path.join(tempDir, 'reopen.db');
    const firstDb = new DatabaseService(dbPath);
    firstDb.initialize();
    firstDb.createSession({
      id: 'session', name: 'session', initial_prompt: '', worktree_name: 'session',
      worktree_path: tempDir, project_id: null, tool_type: 'none',
    });
    const panel = makeOpenCodePanel('opencode-reopen');
    firstDb.createPanel({ id: panel.id, sessionId: panel.sessionId, type: 'terminal', title: panel.title, state: panel.state });
    let activeDb = firstDb;
    const getPersistedPanel = vi.spyOn(databaseService, 'getPanel').mockImplementation(panelId => activeDb.getPanel(panelId));
    const updatePersistedPanel = vi.spyOn(databaseService, 'updatePanel').mockImplementation((panelId, updates) => activeDb.updatePanel(panelId, updates));
    panelManagerMock.updatePanel.mockImplementation(async (panelId: string, updates: Partial<ToolPanel>) => {
      if (updates.state) {
        lastPersisted = updates.state;
        activeDb.updatePanel(panelId, { state: updates.state });
      }
    });

    let reopenedDb: DatabaseService | undefined;
    try {
      const first = new TerminalPanelManager(inProcessEmulatorHost);
      managers.push(first);
      panelManagerMock.getPanel.mockReturnValue(panel);
      await first.initializeTerminal(panel, tempDir);
      const allocatedId = panel.state.customState?.agentSessionId;
      const firstHandle = ptyHost.latest();
      firstHandle.emit('$ ');
      await vi.advanceTimersByTimeAsync(1000);
      expect(firstHandle.written.join('')).toContain(`--session "${allocatedId}"`);
      await first.destroyTerminal(panel.id);
      firstDb.close();

      reopenedDb = new DatabaseService(dbPath);
      reopenedDb.initialize();
      activeDb = reopenedDb;
      const reloaded = reopenedDb.getPanel(panel.id);
      if (!reloaded) throw new Error('panel did not survive database reopen');
      expect(reloaded.state.customState?.wasInterrupted).toBeUndefined();
      panelManagerMock.getPanel.mockReturnValue(reloaded);
      const second = new TerminalPanelManager(inProcessEmulatorHost);
      managers.push(second);
      await second.initializeTerminal(reloaded, tempDir);
      const secondHandle = ptyHost.latest();
      secondHandle.emit('$ ');
      await vi.advanceTimersByTimeAsync(1000);

      expect(reloaded.state.customState?.agentSessionId).toBe(allocatedId);
      expect(secondHandle.written.join('')).toContain(`--session "${allocatedId}"`);
    } finally {
      reopenedDb?.close();
      getPersistedPanel.mockRestore();
      updatePersistedPanel.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('allocates different OpenCode ids for different new panels', async () => {
    const first = makeOpenCodePanel('opencode-one');
    const second = makeOpenCodePanel('opencode-two');

    await startTerminal(first);
    await startTerminal(second);

    expect(first.state.customState?.agentSessionId).toMatch(/^ses_/);
    expect(second.state.customState?.agentSessionId).toMatch(/^ses_/);
    expect(first.state.customState?.agentSessionId).not.toBe(second.state.customState?.agentSessionId);
  });

  it('delivers OpenCode initial input once and does not replay it during reconstruction', async () => {
    vi.useFakeTimers();
    try {
      const panel = makeOpenCodePanel('opencode-prompt-once', {
        agentSessionId: 'ses_Prompt123',
        initialInput: 'Do not replay me',
      });
      const { manager: first, handle: firstHandle } = await startTerminal(panel);
      firstHandle.emit('$ ');
      await vi.advanceTimersByTimeAsync(500);
      emitOpenCodeIdleFrame(firstHandle);
      await vi.advanceTimersByTimeAsync(1000);
      expect(firstHandle.written.filter(write => write === 'Do not replay me')).toHaveLength(1);
      firstHandle.emit('Do not replay me');
      await vi.advanceTimersByTimeAsync(500);
      expect(firstHandle.written).toContain('\r');
      const reloaded = databaseService.getPanel(panel.id);
      expect(reloaded?.state.customState?.initialInputSentAt).toEqual(expect.any(String));
      await first.destroyTerminal(panel.id);

      const second = new TerminalPanelManager(inProcessEmulatorHost);
      managers.push(second);
      if (!reloaded) throw new Error('OpenCode panel was not persisted');
      panelManagerMock.getPanel.mockReturnValue(reloaded);
      await second.initializeTerminal(reloaded, tempDir);
      const secondHandle = ptyHost.latest();
      secondHandle.emit('$ ');
      await vi.advanceTimersByTimeAsync(4000);
      emitOpenCodeIdleFrame(secondHandle);
      await vi.advanceTimersByTimeAsync(500);

      expect(secondHandle.written.join('')).not.toContain('Do not replay me');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps OpenCode initial input pending when the readiness timeout has no output', async () => {
    vi.useFakeTimers();
    try {
      const panel = makeOpenCodePanel('opencode-prompt-timeout', {
        agentSessionId: 'ses_PromptTimeout123',
        initialInput: 'Wait for actual readiness',
      });
      const { manager, handle } = await startTerminal(panel);
      handle.emit('$ ');
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(handle.written).not.toContain('Wait for actual readiness');
      expect(databaseService.getPanel(panel.id)?.state.customState?.initialInputSentAt).toBeUndefined();

      emitOpenCodeIdleFrame(handle);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(handle.written.filter(write => write === 'Wait for actual readiness')).toHaveLength(1);
      expect(databaseService.getPanel(panel.id)?.state.customState?.initialInputSentAt).toEqual(expect.any(String));
      await manager.destroyTerminal(panel.id);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('waits for the fixture-backed idle composer after shell and startup output', async () => {
    vi.useFakeTimers();
    try {
      const panel = makeOpenCodePanel('opencode-readiness-fixture', {
        agentSessionId: 'ses_ReadinessFixture123',
        initialInput: 'Deliver only after idle',
      });
      const { handle } = await startTerminal(panel);
      handle.emit('$ ');
      await vi.advanceTimersByTimeAsync(500);

      handle.emit('opencode --auto --session "ses_ReadinessFixture123"\r\n');
      handle.emit('\x1b[?1049h\x1b[2JOpenCode starting...');
      await vi.advanceTimersByTimeAsync(10_500);

      expect(events.filter(event => event.channel === 'terminal:cliReady')).toHaveLength(0);
      expect(handle.written).not.toContain('Deliver only after idle');
      expect(databaseService.getPanel(panel.id)?.state.customState?.isCliReady).toBe(false);
      expect(databaseService.getPanel(panel.id)?.state.customState?.initialInputSentAt).toBeUndefined();

      emitOpenCodeIdleFrame(handle);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(events.filter(event => event.channel === 'terminal:cliReady')).toHaveLength(1);
      expect(handle.written.filter(write => write === 'Deliver only after idle')).toHaveLength(1);
      expect(databaseService.getPanel(panel.id)?.state.customState?.isCliReady).toBe(true);
      expect(databaseService.getPanel(panel.id)?.state.customState?.initialInputSentAt).toEqual(expect.any(String));
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('never derives an OpenCode identity from terminal buffers', async () => {
    const panel = makeOpenCodePanel('opencode-buffer-identity', {
      agentSessionId: 'ses_PersistedBuffer123',
      scrollbackBuffer: 'opencode --session ses_FromScrollback999',
      alternateScreenBuffer: 'ses_FromAlternate999',
      serializedBuffer: 'ses_FromSerialized999',
    });

    await startTerminal(panel);

    expect(panel.state.customState?.agentSessionId).toBe('ses_PersistedBuffer123');
  });

  it.each([
    { agentType: 'claude', initialCommand: 'claude --dangerously-skip-permissions', agentSessionId: '22222222-2222-4222-8222-222222222222', expected: 'claude --dangerously-skip-permissions --resume "22222222-2222-4222-8222-222222222222"' },
    { agentType: 'codex', initialCommand: 'codex --yolo', agentSessionId: 'thread-1', expected: 'codex --yolo resume "thread-1"' },
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
      expect(handle.written).toContain('claude --dangerously-skip-permissions --resume "session\\$1"\r');
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
    await first.destroyTerminal(panel.id);

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
