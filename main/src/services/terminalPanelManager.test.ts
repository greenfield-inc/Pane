import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import * as claudeTranscripts from './claudeSessionTranscript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from './configManager';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import { createFlowControlRecord, disposeFlowControlRecord, type FlowControlRecord } from '../ptyHost/flowControl';
import type { RemoteTerminalEmulator } from './terminalEmulatorClient';
import { inProcessEmulatorHost } from '../test/inProcessEmulatorHost';
import type { TerminalPanelState } from '../../../shared/types/panels';

import { TerminalPanelManager } from './terminalPanelManager';
import { ShellDetector } from '../utils/shellDetector';
import { panelManager } from '../test/setup';

vi.spyOn(panelManager, 'emitPanelEvent');
vi.spyOn(panelManager, 'getPanel');
vi.spyOn(panelManager, 'updatePanel');

type TerminalUnderTest = {
  pty: {
    cols: number;
    rows: number;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    pid?: number;
    process?: string;
    onExit: ReturnType<typeof vi.fn>;
  };
  isPtyHost: boolean;
  isWSL?: boolean;
  shellProcessName?: string;
  panelId: string;
  sessionId: string;
  scrollbackBuffer: string;
  alternateScreenBuffer: string;
  screenEmulator?: RemoteTerminalEmulator;
  commandHistory: string[];
  currentCommand: string;
  lastActivity: Date;
  lastOutputAt?: Date;
  outputGeneration: number;
  wslContext: null;
  flowControl: FlowControlRecord;
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  isVisible: boolean;
  isAlternateScreen: boolean;
  inSyncBlock: boolean;
  agentType?: 'claude' | 'codex' | 'cursor';
  agentSessionScrapeBuffer: string;
  capturedAgentSessionId?: string;
  agentProbe?: unknown;
  bracketedPasteMode?: boolean;
};

type FlushOutputBufferAccess = {
  flushOutputBuffer(terminal: TerminalUnderTest): void;
};

type VisibilityAccess = {
  terminals: Map<string, TerminalUnderTest>;
  setVisibility(panelId: string, isVisible: boolean, viewerId?: string): void;
  clearVisibilityViewersByPrefix(prefix: string): void;
  pruneVisibilityViewersByPrefix(prefix: string, staleAfterMs: number): void;
};

type SnapshotAccess = {
  terminals: Map<string, TerminalUnderTest>;
  getTerminalSnapshot(panelId: string): ReturnType<TerminalPanelManager['getTerminalSnapshot']>;
  getTerminalState(panelId: string): ReturnType<TerminalPanelManager['getTerminalState']>;
};

type ResizeAccess = {
  terminals: Map<string, TerminalUnderTest>;
  resizeTerminal(
    panelId: string,
    cols: number,
    rows: number,
    options?: { force?: boolean },
  ): Promise<void>;
};

type InitialInputAccess = {
  terminals: Map<string, TerminalUnderTest>;
  sendInitialInputOnce(panelId: string): void;
  deliverPendingInitialInput(panelId: string): void;
  registerAgentStatusPanel(terminal: TerminalUnderTest): void;
  pollAgentStatus(): void;
  getLastOutputAt(panelId: string): string | undefined;
  getOutputGeneration(panelId: string): number;
};

type HandlerAccess = {
  terminals: Map<string, TerminalUnderTest>;
  setupTerminalHandlers(terminal: TerminalUnderTest): void;
};

type LaunchCommandAccess = {
  resolveCliLaunchCommand(panelId: string, initialCommand: string, customState: TerminalPanelState, shellType?: string): {
    commandToRun: string;
    customState: TerminalPanelState;
    isCliCommand: boolean;
  };
};

type AgentSessionCaptureAccess = {
  terminals: Map<string, TerminalUnderTest>;
  captureAgentSessionId(terminal: TerminalUnderTest, output: string): void;
  saveTerminalState(panelId: string): Promise<void>;
};

type DestroyAllAccess = {
  terminals: Map<string, TerminalUnderTest>;
  destroyAllTerminals(): void;
  flushOutputBuffer(terminal: TerminalUnderTest): void;
};

type ShellPromptSchedulerAccess = {
  scheduleAfterShellPrompt(ptyProcess: TerminalUnderTest['pty'] & {
    onData(listener: (data: string) => void): { dispose(): void };
  }, callback: () => void): void;
};

function testAccess<Access>(manager: TerminalPanelManager): Access {
  // SAFETY: Each access type above mirrors the exact private members exercised
  // by its tests; this helper keeps that deliberate test-only seam in one place.
  return manager as Access;
}

function partialMock<Contract>(implementation: Partial<Contract>): Contract {
  // SAFETY: Each test stub implements every ConfigManager member reached by
  // the scenario; an unexpected call fails immediately instead of escaping.
  return implementation as Contract;
}

/** The agent echoes every staged write, as a TUI redraws its composer. */
function echoStagedWrites(terminal: TerminalUnderTest): void {
  terminal.pty.write.mockImplementation((data: string) => {
    if (data === '\r' || data === '\x1b[13;5u\r') return;
    terminal.outputGeneration += 1;
    terminal.lastOutputAt = new Date();
  });
}

function createTerminal(overrides: Partial<TerminalUnderTest> = {}): TerminalUnderTest {
  return {
    pty: {
      cols: 80,
      rows: 24,
      pause: vi.fn(),
      resume: vi.fn(),
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    },
    isPtyHost: false,
    panelId: 'panel-1',
    sessionId: 'session-1',
    scrollbackBuffer: '',
    alternateScreenBuffer: '',
    commandHistory: [],
    currentCommand: '',
    lastActivity: new Date(),
    outputGeneration: 0,
    wslContext: null,
    flowControl: createFlowControlRecord(),
    outputBuffer: 'hello from terminal',
    outputFlushTimer: null,
    isVisible: true,
    isAlternateScreen: false,
    inSyncBlock: false,
    agentSessionScrapeBuffer: '',
    ...overrides,
  };
}

describe('TerminalPanelManager keyboard input', () => {
  it.each([
    '\x1b[1;3A', '\x1b[1;2D', '\x1b[1;2A', '\x1b[17~',
    '\x1b[38;72;0;1;258;1_', '\x1b[37;75;0;1;272;1_',
    '\x1b[38;72;0;1;272;1_', '\x1b[117;64;0;1;0;1_',
  ])('writes each complete input message exactly once: %j', (data) => {
    const manager = new TerminalPanelManager();
    const terminal = createTerminal();
    testAccess<SnapshotAccess>(manager).terminals.set(terminal.panelId, terminal);
    manager.writeToTerminal(terminal.panelId, data);
    expect(terminal.pty.write.mock.calls).toEqual([[data]]);
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager terminal resize', () => {
  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
  });

  it('deduplicates ordinary same-size resizes but holds an actual redraw transition', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ResizeAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ outputBuffer: '' });
    manager.terminals.set(terminal.panelId, terminal);

    await manager.resizeTerminal(terminal.panelId, 80, 24);
    expect(terminal.pty.resize).not.toHaveBeenCalled();

    const redraw = manager.resizeTerminal(terminal.panelId, 80, 24, { force: true });
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(1, 80, 23);
    expect(terminal.pty.resize).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    await redraw;
    expect(terminal.pty.resize).toHaveBeenNthCalledWith(2, 80, 24);
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager shell prompt scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createPromptPty() {
    let listener: ((data: string) => void) | undefined;
    const dispose = vi.fn();
    const terminal = createTerminal();
    return {
      pty: {
        ...terminal.pty,
        onData: vi.fn((nextListener: (data: string) => void) => {
          listener = nextListener;
          return { dispose };
        }),
      },
      emit(data: string) {
        listener?.(data);
      },
      dispose,
    };
  }

  it('waits for the shell to settle after detecting its prompt', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager());
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('user@host:~$ ');

    await vi.advanceTimersByTimeAsync(299);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(promptPty.dispose).toHaveBeenCalledTimes(1);
  });

  it('invokes once when repeated prompts race the fallback', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager());
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('\x1b[32m$\x1b[0m ');
    promptPty.emit('\x1b[32m$\x1b[0m ');

    await vi.runAllTimersAsync();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(promptPty.dispose).toHaveBeenCalledTimes(1);
  });

  it('falls back after five seconds when no prompt is detected', async () => {
    vi.useFakeTimers();
    const manager = testAccess<ShellPromptSchedulerAccess>(new TerminalPanelManager());
    const promptPty = createPromptPty();
    const callback = vi.fn();

    manager.scheduleAfterShellPrompt(promptPty.pty, callback);
    promptPty.emit('loading shell configuration\r\n');

    await vi.advanceTimersByTimeAsync(4999);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

function createConfigManagerStub(): ConfigManager {
  return partialMock<ConfigManager>({
    getUsePtyHost: () => false,
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TerminalPanelManager hidden output delivery', () => {
  afterEach(() => {
    resetPaneRuntimeForTests();
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
  });

  it('keeps visible terminal output on the combined runtime sink', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager();
    const terminal = createTerminal();

    testAccess<FlushOutputBufferAccess>(manager).flushOutputBuffer(terminal);

    expect(combinedSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hello from terminal',
    });
    expect(daemonSink.send).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('sends hidden terminal output to daemon subscribers without waking the renderer sink', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = new TerminalPanelManager();
    const terminal = createTerminal({ isVisible: false });

    testAccess<FlushOutputBufferAccess>(manager).flushOutputBuffer(terminal);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hello from terminal',
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('flushes pending hidden output to daemon subscribers before making a panel visible', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: 'hidden output',
      outputFlushTimer: setTimeout(() => undefined, 10_000),
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'hidden output',
    });
    expect(terminal.outputBuffer).toBe('');
    expect(terminal.outputFlushTimer).toBeNull();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('flushes buffered output to daemon subscribers before hiding a visible panel', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: true,
      outputBuffer: 'visible output',
      outputFlushTimer: setTimeout(() => undefined, 10_000),
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, false);

    expect(combinedSink.send).not.toHaveBeenCalled();
    expect(daemonSink.send).toHaveBeenCalledWith('terminal:output', {
      sessionId: 'session-1',
      panelId: 'panel-1',
      output: 'visible output',
    });
    expect(terminal.outputBuffer).toBe('');
    expect(terminal.outputFlushTimer).toBeNull();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('keeps terminal visible until the last visible viewer hides', () => {
    const combinedSink = { send: vi.fn() };
    const daemonSink = { send: vi.fn() };
    setPaneRuntime({
      eventSink: combinedSink,
      daemonEventSink: daemonSink,
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });

    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: '',
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true, 'local:host');
    manager.setVisibility(terminal.panelId, true, 'remote:mac');
    manager.setVisibility(terminal.panelId, false, 'remote:mac');

    expect(terminal.isVisible).toBe(true);

    manager.setVisibility(terminal.panelId, false, 'local:host');

    expect(terminal.isVisible).toBe(false);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('clears remote viewer visibility by prefix on disconnect', () => {
    const manager = testAccess<VisibilityAccess>(new TerminalPanelManager());
    const terminal = createTerminal({
      isVisible: false,
      outputBuffer: '',
    });
    manager.terminals.set(terminal.panelId, terminal);

    manager.setVisibility(terminal.panelId, true, 'local:host');
    manager.setVisibility(terminal.panelId, true, 'remote:client-1:runtime-1:viewer:a');
    manager.clearVisibilityViewersByPrefix('remote:client-1:runtime-1');

    expect(terminal.isVisible).toBe(true);

    manager.setVisibility(terminal.panelId, false, 'local:host');

    expect(terminal.isVisible).toBe(false);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('returns emulated live screen and restore state for daemon and renderer reads', async () => {
    const manager = testAccess<SnapshotAccess>(new TerminalPanelManager());
    const screenEmulator = inProcessEmulatorHost().createEmulator(40, 5);
    screenEmulator.write('\x1b[?1049h\x1b[Hagent screen');
    await screenEmulator.refresh();
    const terminal = createTerminal({
      scrollbackBuffer: 'scrollback',
      alternateScreenBuffer: 'screen',
      screenEmulator,
      isAlternateScreen: true,
      currentCommand: 'codex',
      capturedAgentSessionId: 'agent-session-1',
    });
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliPanel: true,
          isCliReady: true,
          agentType: 'codex',
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    const snapshot = manager.getTerminalSnapshot(terminal.panelId);

    expect(snapshot).toMatchObject({
      initialized: true,
      scrollbackBuffer: 'scrollback',
      alternateScreenBuffer: 'screen',
      screenText: 'agent screen',
      isAlternateScreen: true,
      activityStatus: 'idle',
      currentCommand: 'codex',
      isCliPanel: true,
      isCliReady: true,
      agentType: 'codex',
      agentSessionId: 'agent-session-1',
    });
    const restoreState = await manager.getTerminalState(terminal.panelId);
    expect(restoreState).toMatchObject({
      isAlternateScreen: true,
      scrollbackBuffer: 'scrollback',
    });
    expect(restoreState?.serializedBuffer).toContain('\x1b[?1049h');
    screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('serves normal-buffer restore content from the rendered emulator, not the raw append log', async () => {
    const manager = testAccess<SnapshotAccess>(new TerminalPanelManager());
    const screenEmulator = inProcessEmulatorHost().createEmulator(40, 5);
    const frame = 'PR #363 state unchanged';
    // Live stream: the frame prints once, then forced-redraw repaints re-emit it
    // after cursor-home — the traffic that duplicated rows when the raw log was
    // replayed. The emulator overwrites in place, like a live terminal.
    const initial = `${frame}\r\n`;
    const repaint = `\x1b[H${frame}\x1b[K\r\n`;
    screenEmulator.write(initial);
    screenEmulator.write(repaint);
    screenEmulator.write(repaint);
    const terminal = createTerminal({
      scrollbackBuffer: initial + repaint + repaint,
      screenEmulator,
      isAlternateScreen: false,
    });
    manager.terminals.set(terminal.panelId, terminal);

    const restoreState = await manager.getTerminalState(terminal.panelId);
    const restored = restoreState?.scrollbackBuffer;
    expect(restored).toBeDefined();
    if (restored === undefined) throw new Error('Expected restored scrollback');
    expect(restored.split(frame).length - 1).toBe(1);
    expect(terminal.scrollbackBuffer.split(frame).length - 1).toBe(3);
    screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('submits Codex initial input through the composer sequence', async () => {
    vi.useFakeTimers();
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          initialInput: 'Read the Pane Chat guide and initialize yourself.',
          initialInputSubmitStrategy: 'codex-ctrl-enter' as const,
          agentType: 'codex' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    echoStagedWrites(terminal);

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledWith('Read the Pane Chat guide and initialize yourself.');
    expect(terminal.pty.write).not.toHaveBeenCalledWith('\x1b[13;5u\r');

    await vi.advanceTimersByTimeAsync(500);

    expect(terminal.pty.write).toHaveBeenCalledWith('\x1b[13;5u\r');
    expect(panelManager.updatePanel).toHaveBeenCalledWith(terminal.panelId, {
      state: expect.objectContaining({
        customState: expect.objectContaining({
          initialInputSentAt: expect.any(String),
          initialInputError: undefined,
        }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('types initial input without pressing Enter when the panel asks for no submit', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Terminal',
      state: {
        isActive: true,
        customState: { initialInput: 'gh auth login --web', initialInputSubmitStrategy: 'none' as const },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(vi.mocked(terminal.pty.write).mock.calls).toEqual([['gh auth login --web']]);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('does not treat input writes as output freshness', () => {
    const manager = testAccess<InitialInputAccess & TerminalPanelManager>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);

    manager.writeToTerminal(terminal.panelId, 'typed input');

    expect(terminal.pty.write).toHaveBeenCalledWith('typed input');
    expect(manager.getLastOutputAt(terminal.panelId)).toBeUndefined();
    expect(manager.getOutputGeneration(terminal.panelId)).toBe(0);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers pending ready initial input with the panel submit strategy', async () => {
    vi.useFakeTimers();
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ screenEmulator: inProcessEmulatorHost().createEmulator(40, 5) });
    manager.terminals.set(terminal.panelId, terminal);
    manager.registerAgentStatusPanel(terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSubmitStrategy: 'codex-ctrl-enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    echoStagedWrites(terminal);
    manager.deliverPendingInitialInput(terminal.panelId);
    manager.pollAgentStatus();
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenNthCalledWith(1, '/do TM-x');

    await vi.advanceTimersByTimeAsync(500);

    expect(terminal.pty.write).toHaveBeenCalledTimes(2);
    expect(terminal.pty.write).toHaveBeenNthCalledWith(2, '\x1b[13;5u\r');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers after a premark clear when the cliReady path already skipped', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ screenEmulator: inProcessEmulatorHost().createEmulator(40, 5) });
    manager.terminals.set(terminal.panelId, terminal);
    manager.registerAgentStatusPanel(terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSentAt: '2026-01-01T00:02:00.000Z',
          initialInputSubmitStrategy: 'enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).not.toHaveBeenCalled();
    delete panel.state.customState.initialInputSentAt;

    manager.deliverPendingInitialInput(terminal.panelId);
    manager.pollAgentStatus();
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenCalledWith('/do TM-x\r');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('delivers initial input exactly once when cliReady and explicit triggers race', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    const panel = {
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal' as const,
      title: 'Codex',
      state: {
        isActive: true,
        customState: {
          isCliReady: true,
          initialInput: '/do TM-x',
          initialInputSubmitStrategy: 'enter' as const,
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);

    manager.sendInitialInputOnce(terminal.panelId);
    manager.deliverPendingInitialInput(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledTimes(1);
    expect(terminal.pty.write).toHaveBeenCalledWith('/do TM-x\r');
    expect(panelManager.updatePanel).toHaveBeenCalledTimes(1);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('passes fresh Codex initial input as a startup prompt argument', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'Read "the guide" and initialize `Pane Chat`.',
    });

    expect(result).toMatchObject({
      commandToRun: 'codex --yolo "Read \\"the guide\\" and initialize \\`Pane Chat\\`."',
      isCliCommand: true,
      customState: {
        agentType: 'codex',
        isCliPanel: true,
        isCliReady: false,
        initialInputSentAt: expect.any(String),
        initialInputError: undefined,
      },
    });
  });

  it('escapes shell-sensitive startup prompt arguments without changing ordinary prompts', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const unsafeCommandSubstitution = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'BACKSLASH\\$(touch /tmp/pwned)',
    });
    const escapedShellSyntax = manager.resolveCliLaunchCommand('panel-2', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'plain $value and `cmd`',
    });
    const ordinaryPrompt = manager.resolveCliLaunchCommand('panel-3', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'Read the guide and initialize Pane Chat.',
    });

    expect(unsafeCommandSubstitution.commandToRun).toBe('codex --yolo "BACKSLASH\\\\\\$(touch /tmp/pwned)"');
    expect(unsafeCommandSubstitution.commandToRun).not.toMatch(/(^|[^\\])(?:\\\\)*\$\(/);
    expect(escapedShellSyntax.commandToRun).toBe('codex --yolo "plain \\$value and \\`cmd\\`"');
    expect(ordinaryPrompt.commandToRun).toBe('codex --yolo "Read the guide and initialize Pane Chat."');
  });

  it('passes fresh Claude slash input as a quoted startup argument', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        initialInputMode: 'argument',
        initialInput: '/do TM-x',
      },
    );

    expect(result).toMatchObject({
      commandToRun: 'claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111 "/do TM-x"',
      isCliCommand: true,
      customState: {
        initialInputSentAt: expect.any(String),
        initialInputError: undefined,
      },
    });
  });

  it('preserves multiline Claude input in the quoted startup argument', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const input = 'First line\nSecond line with $value';

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        initialInputMode: 'argument',
        initialInput: input,
      },
    );

    expect(result.commandToRun).toBe(
      'claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111 "First line\nSecond line with \\$value"',
    );
    expect(result.customState.initialInputSentAt).toEqual(expect.any(String));
  });

  it('preserves custom native arguments on resume without submitting input', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const id = '22222222-2222-4222-8222-222222222222';
    const claude = manager.resolveCliLaunchCommand('panel', 'claude --model "my model" --permission-mode plan "implement the task"', {
      agentType: 'claude', agentSessionId: id, hasClaudeSessionId: true,
    });
    expect(claude.commandToRun).toBe(`claude --model "my model" --permission-mode plan --resume "${id}"`);
    expect(claude.customState.initialInputSentAt).toBeUndefined();
    const codex = manager.resolveCliLaunchCommand('panel', 'codex --model test --sandbox read-only', {
      agentType: 'codex', agentSessionId: id, wasInterrupted: true,
    });
    expect(codex.commandToRun).toBe(`codex --model test --sandbox read-only resume "${id}"`);
    expect(codex.customState.initialInputSentAt).toBeUndefined();
  });

  it('reopens an untouched Claude Session without resuming a nonexistent transcript', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const id = '00000000-0000-4000-8000-000000000001';
    const readable = vi.spyOn(claudeTranscripts, 'canReadClaudeTranscripts').mockReturnValue(true);
    const lookup = vi.spyOn(claudeTranscripts, 'findClaudeSessionTranscript').mockReturnValue(undefined);
    try {
      const result = manager.resolveCliLaunchCommand('panel', 'claude --model test', {
        agentType: 'claude', orchestrationSessionId: 'untouched', agentSessionId: id, hasClaudeSessionId: true,
      });
      expect(result.commandToRun).toBe(`claude --model test --session-id ${id}`);
      expect(result.customState.initialInputSentAt).toBeUndefined();
    } finally { readable.mockRestore(); lookup.mockRestore(); }
  });

  it('does not mistake a Codex option value for a subcommand on resume', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const command = 'codex -c model_instructions_file="/tmp/review.md"';
    const result = manager.resolveCliLaunchCommand('panel', command, { agentType: 'codex', agentSessionId: 'saved-thread', wasInterrupted: true });
    expect(result.commandToRun).toBe(`${command} resume "saved-thread"`);
  });

  it('pins resumed Codex Sessions to their managed directory without overriding user cwd arguments', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const state: TerminalPanelState = { agentType: 'codex', orchestrationSessionId: 'session', orchestrationWorkspace: '/tmp/new session', agentSessionId: 'saved-thread' };
    expect(manager.resolveCliLaunchCommand('panel', 'codex --yolo', state).commandToRun)
      .toBe('codex --yolo resume "saved-thread" --cd "/tmp/new session"');
    expect(manager.resolveCliLaunchCommand('panel', 'codex --cd /custom', state).commandToRun)
      .toBe('codex --cd /custom resume "saved-thread"');
  });

  it('uses generic templates to allocate and resume a wrapper conversation without changing its saved command', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const command = 'my-launcher profile --label "review work"';
    const customResume = { mode: 'generated', initialTemplate: '{command} -- --session-id {sessionId}', resumeTemplate: '{command} -- --resume {sessionId}' } satisfies NonNullable<TerminalPanelState['customResume']>;
    const first = manager.resolveCliLaunchCommand('panel', command, { initialCommand: command, customResume });
    expect(first.customState.agentSessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.commandToRun).toBe(`${command} -- --session-id "${first.customState.agentSessionId}"`);
    expect(first.customState.initialCommand).toBe(command);
    const restarted = testAccess<LaunchCommandAccess>(new TerminalPanelManager()).resolveCliLaunchCommand('panel', command, first.customState);
    expect(restarted.commandToRun).toBe(`${command} -- --resume "${first.customState.agentSessionId}"`);
    expect(restarted.customState.initialInputSentAt).toBeUndefined();
  });

  it('resumes direct Claude only when the allocated conversation has a transcript', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const lookup = vi.spyOn(claudeTranscripts, 'findClaudeSessionTranscript').mockReturnValue(undefined);
    const readable = vi.spyOn(claudeTranscripts, 'canReadClaudeTranscripts').mockReturnValue(true);
    try {
      const command = 'claude --model sonnet';
      const first = manager.resolveCliLaunchCommand('panel', command, { initialCommand: command, customResume: {
        mode: 'claude', initialTemplate: '{command} -- --session-id {sessionId}', resumeTemplate: '{command} -- --resume {sessionId}',
      } });
      expect(manager.resolveCliLaunchCommand('panel', command, first.customState).commandToRun).toBe(first.commandToRun);
      lookup.mockReturnValue('/private/transcript.jsonl');
      expect(manager.resolveCliLaunchCommand('panel', command, first.customState).commandToRun)
        .toBe(`${command} -- --resume "${first.customState.agentSessionId}"`);
    } finally { lookup.mockRestore(); readable.mockRestore(); }
  });

  it('resumes wrapped Claude by its recorded conversation without assuming the app configuration matches its launcher', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const readable = vi.spyOn(claudeTranscripts, 'canReadClaudeTranscripts').mockReturnValue(true);
    try {
      const command = 'any-launcher my-profile';
      const first = manager.resolveCliLaunchCommand('panel', command, { initialCommand: command, customResume: {
        mode: 'claude', initialTemplate: '{command} -- --session-id {sessionId}', resumeTemplate: '{command} -- --resume {sessionId}',
      } });
      expect(manager.resolveCliLaunchCommand('panel', command, first.customState).commandToRun)
        .toBe(`${command} -- --resume "${first.customState.agentSessionId}"`);
    } finally { readable.mockRestore(); }
  });

  it('keeps an env prefix and home paths when resuming a Codex command with a prompt', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const result = manager.resolveCliLaunchCommand('panel', 'CODEX_HOME=~/codex-work codex --yolo "fix the bug"', {
      agentType: 'codex', agentSessionId: 'thread-1', wasInterrupted: true,
    });
    expect(result.commandToRun).toBe('CODEX_HOME=~/codex-work codex --yolo resume "thread-1"');
  });

  it.each([
    ['CODEX_HOME="/tmp/my codex" codex "fix bug"', 'CODEX_HOME="/tmp/my codex" codex resume "thread-1"'],
    ['codex --cd "$HOME/repo" "fix bug"', 'codex --cd "$HOME/repo" resume "thread-1"'],
    ['codex -- "fix bug"', 'codex resume "thread-1"'],
    ['codex -- "review"', 'codex resume "thread-1"'],
    ['codex --cd "$HOME/repo" -- "--model is broken"', 'codex --cd "$HOME/repo" resume "thread-1"'],
    ['codex --', 'codex resume "thread-1"'],
  ])('preserves shell argument spelling on resume: %s', (command, expected) => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    expect(manager.resolveCliLaunchCommand('panel', command, {
      agentType: 'codex', agentSessionId: 'thread-1', wasInterrupted: true,
    }).commandToRun).toBe(expected);
  });

  it.each([
    'claude --debug-file /tmp/claude.log',
    'claude --permission-prompt-tool mcp__pane-permissions__approve_permission',
    'claude --future-setting value',
  ])('keeps option operands on Claude resume: %s', command => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    expect(manager.resolveCliLaunchCommand('panel', command, {
      agentType: 'claude', agentSessionId: '22222222-2222-4222-8222-222222222222', hasClaudeSessionId: true,
    }).commandToRun).toBe(`${command} --resume "22222222-2222-4222-8222-222222222222"`);
  });

  it('allocates a Claude session when resume flags appear only inside an option value', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const command = 'claude --append-system-prompt "use -c for config"';
    const result = manager.resolveCliLaunchCommand('panel', command, { agentType: 'claude' });
    expect(result.commandToRun).toBe(`${command} --session-id ${result.customState.agentSessionId}`);
  });

  it('resumes wrapped Codex by captured ID and never guesses the latest conversation', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const command = 'another-wrapper run profile';
    const state: TerminalPanelState = { customResume: {
      mode: 'codex', initialTemplate: '{command}', resumeTemplate: '{command} -- resume {sessionId}',
    }, wasInterrupted: true };
    expect(manager.resolveCliLaunchCommand('panel', command, state).commandToRun).toBe(command);
    expect(manager.resolveCliLaunchCommand('panel', command, { ...state, agentSessionId: 'saved-thread' }).commandToRun)
      .toBe(`${command} -- resume "saved-thread"`);
  });

  it('rejects resume templates that cannot identify the saved conversation', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    expect(() => manager.resolveCliLaunchCommand('panel', 'wrapper', { customResume: {
      mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --latest',
    } })).toThrow('must contain {sessionId}');
  });

  it('passes Session wrapper commands through without appending agent flags or prompts', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const command = 'agent-farm run planner -- --model "my model"';
    const result = manager.resolveCliLaunchCommand('panel', command, {
      agentType: 'claude', preserveLaunchCommand: true, wasInterrupted: true,
      agentSessionId: '22222222-2222-4222-8222-222222222222', hasClaudeSessionId: true,
    });
    expect(result.commandToRun).toBe(command);
    expect(result.customState.initialInputSentAt).toBeUndefined();
  });

  it('keeps resumed Claude input composer-bound', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand(
      '11111111-1111-4111-8111-111111111111',
      'claude --dangerously-skip-permissions',
      {
        agentType: 'claude',
        hasClaudeSessionId: true,
        agentSessionId: '22222222-2222-4222-8222-222222222222',
        initialInputMode: 'argument',
        initialInput: '/do TM-x',
      },
    );

    expect(result.commandToRun).toBe(
      'claude --dangerously-skip-permissions --resume "22222222-2222-4222-8222-222222222222"',
    );
    expect(result.customState).not.toHaveProperty('initialInputSentAt');
  });

  it('launches a fresh Cursor panel through the create-chat compound', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
    });

    expect(result).toMatchObject({
      commandToRun:
        'if __PANE_CURSOR_CHAT="$(cursor-agent create-chat 2>/dev/null)" && [ -n "$__PANE_CURSOR_CHAT" ]; '
        + 'then printf \'\\npane-cursor-chat-id: %s\\n\' "$__PANE_CURSOR_CHAT"; '
        + 'cursor-agent --force --trust --resume "$__PANE_CURSOR_CHAT"; '
        + 'else cursor-agent --force --trust; fi',
      isCliCommand: true,
      customState: {
        agentType: 'cursor',
        isCliPanel: true,
        isCliReady: false,
      },
    });
  });

  it('passes fresh Cursor initial input as a startup prompt argument on both compound branches', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      initialInputMode: 'argument',
      initialInput: 'Read "the guide" and initialize `Pane Chat`.',
    });

    const quoted = '"Read \\"the guide\\" and initialize \\`Pane Chat\\`."';
    expect(result.commandToRun).toContain(`--resume "$__PANE_CURSOR_CHAT" ${quoted}; `);
    expect(result.commandToRun).toContain(`else cursor-agent --force --trust ${quoted}; fi`);
    expect(result.customState).toMatchObject({
      agentType: 'cursor',
      initialInputSentAt: expect.any(String),
      initialInputError: undefined,
    });
  });

  it('uses fish-compatible syntax for a fresh Cursor launch in fish', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
    }, 'fish');

    expect(result.commandToRun).toBe(
      'if set __PANE_CURSOR_CHAT (cursor-agent create-chat 2>/dev/null); and test -n "$__PANE_CURSOR_CHAT"; '
      + 'printf \'\\npane-cursor-chat-id: %s\\n\' "$__PANE_CURSOR_CHAT"; '
      + 'cursor-agent --force --trust --resume "$__PANE_CURSOR_CHAT"; '
      + 'else; cursor-agent --force --trust; end',
    );
  });

  it('resumes an interrupted Cursor panel with its captured chat id', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      wasInterrupted: true,
      agentSessionId: '7403f755-6758-40d3-bb69-2cd356dd9bf0',
    });

    expect(result).toMatchObject({
      commandToRun: 'cursor-agent --force --trust --resume "7403f755-6758-40d3-bb69-2cd356dd9bf0"',
      isCliCommand: true,
      customState: {
        agentType: 'cursor',
        wasInterrupted: undefined,
      },
    });
  });

  it('continues the latest Cursor chat when an interrupted panel has no captured id', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force --trust', {
      agentType: 'cursor',
      wasInterrupted: true,
    });

    expect(result).toMatchObject({
      commandToRun: 'cursor-agent --force --trust --continue',
      isCliCommand: true,
      customState: {
        wasInterrupted: undefined,
      },
    });
  });

  it('keeps Codex launch options when resuming an interrupted panel', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());
    const initialCommand = `codex --yolo -c 'agents.explorer.config_file="/data/.codex/agents/explorer.toml"'`;

    const result = manager.resolveCliLaunchCommand('panel-1', initialCommand, {
      agentType: 'codex',
      wasInterrupted: true,
      agentSessionId: 'thread-1',
    });

    expect(result).toMatchObject({
      commandToRun: `codex --yolo -c 'agents.explorer.config_file="/data/.codex/agents/explorer.toml"' resume "thread-1"`,
      isCliCommand: true,
    });
  });

  it('drops other Codex options, such as a prompt, when resuming', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo "fix the bug"', {
      agentType: 'codex',
      wasInterrupted: true,
      agentSessionId: 'thread-1',
    });

    expect(result).toMatchObject({ commandToRun: 'codex --yolo resume "thread-1"' });
  });

  it('keeps Enter as the default initial input submit strategy', async () => {
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Tool',
      state: {
        isActive: true,
        customState: {
          initialInput: 'hello tool',
        },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();

    expect(terminal.pty.write).toHaveBeenCalledWith('hello tool\r');
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager agent session capture', () => {
  const CURSOR_CHAT_ID = '7403f755-6758-40d3-bb69-2cd356dd9bf0';

  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
  });

  const mockPanel = (agentType: string, initialCommand: string, panelId = 'panel-1') => {
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: panelId,
      sessionId: 'session-1',
      type: 'terminal',
      title: 'Agent',
      state: {
        isActive: true,
        customState: { agentType, initialCommand, isCliPanel: true },
      },
      metadata: {
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:01:00.000Z',
        position: 0,
      },
    });
  };

  it('persists the Cursor chat id scraped from the marker line', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'cursor' });
    mockPanel('cursor', 'cursor-agent --force --trust');

    manager.captureAgentSessionId(terminal, `\r\npane-cursor-chat-id: ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBe(CURSOR_CHAT_ID);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'cursor', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it.each([undefined, 'claude', 'codex'] as const)('captures a reported ID with detected identity %s across output chunks', agentType => {
    const command = 'unknown-launcher';
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal();
    terminal.agentType = agentType;
    mockPanel('claude', command);
    const panel = panelManager.getPanel('panel-1');
    if (!panel) throw new Error('Missing panel fixture');
    panel.state.customState = { initialCommand: command, agentType, customResume: {
      mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --continue {sessionId}',
    } };
    manager.captureAgentSessionId(terminal, `To continue, run codex resume ${CURSOR_CHAT_ID}\r\n`);
    expect(terminal.capturedAgentSessionId).toBeUndefined();
    manager.captureAgentSessionId(terminal, '\r\nPANE_AGENT_SESSION_');
    expect(terminal.capturedAgentSessionId).toBeUndefined();
    manager.captureAgentSessionId(terminal, 'ID=custom-thread-123\r\n');
    expect(terminal.capturedAgentSessionId).toBe('custom-thread-123');
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', { state: expect.objectContaining({
      customState: expect.objectContaining({ agentSessionId: 'custom-thread-123' }),
    }) });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('keeps an allocated custom resume ID after detecting Codex', () => {
    const manager = testAccess<AgentSessionCaptureAccess & LaunchCommandAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'codex' });
    mockPanel('codex', 'wrapper');
    const panel = panelManager.getPanel('panel-1');
    if (!panel) throw new Error('Missing panel fixture');
    const customState: TerminalPanelState = {
      initialCommand: 'wrapper', agentType: 'codex', agentSessionId: 'allocated-thread', customResumeStarted: true,
      customResume: { mode: 'generated', initialTemplate: '{command} --id {sessionId}', resumeTemplate: '{command} --continue {sessionId}' },
    };
    panel.state.customState = customState;
    manager.captureAgentSessionId(terminal, `To continue, run codex resume ${CURSOR_CHAT_ID}\r\n`);
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    const launch = manager.resolveCliLaunchCommand('panel-1', 'wrapper', customState);
    expect(launch.commandToRun).toBe('wrapper --continue "allocated-thread"');
    expect(launch.customState.agentType).toBe('codex');
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('still captures Codex resume ids from screen output', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'codex' });
    mockPanel('codex', 'codex --yolo');

    manager.captureAgentSessionId(terminal, `To continue, run codex resume ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBe(CURSOR_CHAT_ID);
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'codex', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('ignores marker lines when the panel is not a cursor panel', () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'codex' });
    mockPanel('codex', 'codex --yolo');

    manager.captureAgentSessionId(terminal, `pane-cursor-chat-id: ${CURSOR_CHAT_ID}\r\n`);

    expect(terminal.capturedAgentSessionId).toBeUndefined();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('persists the captured session id for the terminal agent on state save', async () => {
    const manager = testAccess<AgentSessionCaptureAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'cursor', capturedAgentSessionId: CURSOR_CHAT_ID });
    manager.terminals.set(terminal.panelId, terminal);
    mockPanel('cursor', 'cursor-agent --force --trust');

    await manager.saveTerminalState(terminal.panelId);

    expect(panelManager.updatePanel).toHaveBeenCalledWith(terminal.panelId, {
      state: expect.objectContaining({
        customState: expect.objectContaining({ agentType: 'cursor', agentSessionId: CURSOR_CHAT_ID }),
      }),
    });
    disposeFlowControlRecord(terminal.flowControl);
  });
});

describe('TerminalPanelManager destroyAllTerminals', () => {
  afterEach(() => {
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
  });

  it('kills every PTY even when one terminal fails to flush', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = testAccess<DestroyAllAccess>(new TerminalPanelManager());
    const doomed = createTerminal({ panelId: 'panel-throws' });
    const healthy = createTerminal({ panelId: 'panel-ok' });
    manager.terminals.set(doomed.panelId, doomed);
    manager.terminals.set(healthy.panelId, healthy);
    // The production event-sink fanout rethrows its first subscriber error, so
    // one destroyed webContents is enough to make this throw during quit.
    vi.spyOn(manager, 'flushOutputBuffer').mockImplementation((terminal) => {
      if (terminal.panelId === doomed.panelId) throw new Error('event sink exploded');
    });

    manager.destroyAllTerminals();

    // The throwing terminal must still be killed: the map is cleared straight
    // after this loop, so a skipped kill leaves nothing able to reclaim it.
    expect(doomed.pty.kill).toHaveBeenCalled();
    expect(healthy.pty.kill).toHaveBeenCalled();
    expect(manager.terminals.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Final output flush failed'),
      expect.anything(),
    );
    warn.mockRestore();
  });
});

describe('TerminalPanelManager stopAllTerminalProcesses', () => {
  it.runIf(process.platform === 'linux')('stops the shell and what runs under it, even when they ignore SIGTERM', async () => {
    // An ignored signal stays ignored across exec, so the sleep ignores SIGTERM too.
    const shell = spawn('sh', ['-c', 'trap "" TERM; sleep 60 & wait'], { stdio: 'ignore' });
    const shellPid = shell.pid ?? 0;
    const childPids = async (): Promise<number[]> => {
      try {
        return (await readFile(`/proc/${shellPid}/task/${shellPid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
      } catch {
        return [];
      }
    };
    await vi.waitFor(async () => expect(await childPids()).toHaveLength(1));
    const [sleepPid] = await childPids();
    const manager = testAccess<DestroyAllAccess & { stopAllTerminalProcesses(graceMs?: number): Promise<number[]> }>(new TerminalPanelManager());
    const terminal = createTerminal({ panelId: 'panel-agent' });
    terminal.pty.pid = shellPid;
    manager.terminals.set(terminal.panelId, terminal);

    const survivors = await manager.stopAllTerminalProcesses(200);

    expect(survivors).toEqual([]);
    expect(terminal.pty.kill).toHaveBeenCalled();
    expect(manager.terminals.size).toBe(0);
    const isLive = (pid: number) => existsSync(`/proc/${pid}/stat`) && !readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ');
    await vi.waitFor(() => expect([shellPid, sleepPid].filter(isLive)).toEqual([]));
  });
});

type AgentStatusAccess = {
  terminals: Map<string, TerminalUnderTest>;
  registerAgentStatusPanel(terminal: TerminalUnderTest): void;
  pollAgentStatus(): void;
  destroyTerminal(panelId: string): void;
};

describe('TerminalPanelManager agent status poll', () => {
  it('re-derives status when the screen changes and holds it while the screen is unchanged', async () => {
    const manager = testAccess<AgentStatusAccess>(new TerminalPanelManager());
    const screenEmulator = inProcessEmulatorHost().createEmulator(60, 10);
    const terminal = createTerminal({ agentType: 'claude', screenEmulator });
    manager.terminals.set(terminal.panelId, terminal);
    manager.registerAgentStatusPanel(terminal);

    screenEmulator.write('\x1b]2;⠹ Claude\x07Thinking...');
    await screenEmulator.refresh();
    manager.pollAgentStatus();
    expect(manager.getAgentStatus(terminal.panelId)).toBe('working');

    screenEmulator.write('\x1b]2;\x07\x1b[2J\x1b[HBash command\r\n  rm -rf build\r\n\r\nDo you want to proceed?\r\n');
    screenEmulator.write('❯ 1. Yes\r\n  2. No, tell Claude what to do differently (esc)\r\n');
    await screenEmulator.refresh();
    manager.pollAgentStatus();
    manager.pollAgentStatus();
    expect(manager.getAgentStatus(terminal.panelId)).toBe('blocked');

    manager.destroyTerminal(terminal.panelId);
  });

  it('holds typed initial input on the trust prompt and sends it once the agent is ready', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const manager = testAccess<AgentStatusAccess & InitialInputAccess>(new TerminalPanelManager());
    const screenEmulator = inProcessEmulatorHost().createEmulator(60, 10);
    const terminal = createTerminal({ agentType: 'claude', screenEmulator });
    manager.terminals.set(terminal.panelId, terminal);
    manager.registerAgentStatusPanel(terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Claude',
      state: { isActive: true, customState: { isCliReady: true, initialInput: '/review' } },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:01:00.000Z', position: 0 },
    });
    const rule = '─'.repeat(40);

    screenEmulator.write(`${rule}\r\n Accessing workspace:\r\n\r\n ❯ No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel`);
    await screenEmulator.refresh();
    manager.deliverPendingInitialInput(terminal.panelId);
    manager.pollAgentStatus();
    await flushPromises();
    expect(terminal.pty.write).not.toHaveBeenCalled();

    screenEmulator.write(`\x1b[2J\x1b[H${rule}\r\n❯ \r\n${rule}`);
    await screenEmulator.refresh();
    vi.setSystemTime(Date.now() + 3_000); // past the monitor's startup grace
    echoStagedWrites(terminal);
    manager.pollAgentStatus();
    await flushPromises();
    // The text goes first; Enter follows on its own once Claude has echoed it and gone quiet.
    expect(terminal.pty.write.mock.calls).toEqual([['/review']]);
    vi.setSystemTime(Date.now() + 400);
    await vi.waitFor(() => expect(terminal.pty.write.mock.calls).toEqual([['/review'], ['\r']]));

    manager.destroyTerminal(terminal.panelId);
    vi.useRealTimers();
  });
});

describe('TerminalPanelManager wrapper launches', () => {
  it('runs a declared wrapper command unchanged, with no Claude session id', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('11111111-1111-4111-8111-111111111111', 'agent-farm run free-range', {
      agentType: 'claude',
      agentDetection: 'declared',
      launchMode: 'wrapped',
      initialInput: 'Plan the work',
      initialInputMode: 'argument',
    });

    expect(result.commandToRun).toBe('agent-farm run free-range');
    expect(result.isCliCommand).toBe(true);
    expect(result.customState).toMatchObject({
      agentType: 'claude',
      agentDetection: 'declared',
      launchMode: 'wrapped',
      launchCommand: 'agent-farm run free-range',
      isCliPanel: true,
      isCliReady: false,
    });
    expect(result.customState).not.toHaveProperty('agentSessionId');
    expect(result.customState).not.toHaveProperty('initialInputSentAt');
  });

  it('relaunches an interrupted wrapper as given instead of resuming the agent directly', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'agent-farm run free-range', {
      agentType: 'codex',
      agentDetection: 'process',
      launchMode: 'wrapped',
      agentSessionId: '019a0000-0000-7000-8000-000000000000',
      wasInterrupted: true,
    });

    expect(result.commandToRun).toBe('agent-farm run free-range');
    expect(result.customState.wasInterrupted).toBeUndefined();
  });

  it('records how a built-in agent command was identified', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    expect(manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {}).customState).toMatchObject({
      agentType: 'codex',
      agentDetection: 'command',
      launchCommand: 'codex --yolo',
    });
    expect(manager.resolveCliLaunchCommand('panel-1', 'my-codex-alias', { agentType: 'codex' }).customState).toMatchObject({
      agentType: 'codex',
      agentDetection: 'declared',
    });
  });
});

type DetectionAccess = AgentStatusAccess & {
  getForegroundProcess(panelId: string): { name: string; isShell: boolean } | undefined;
};

describe('TerminalPanelManager wrapper agent detection', () => {
  const rule = '─'.repeat(40);

  function wrapperPanel(customState: TerminalPanelState = { initialCommand: 'agent-farm run free-range' }) {
    const panel = {
      id: 'panel-1',
      sessionId: 'session-1',
      type: 'terminal' as const,
      title: 'Farm',
      state: { isActive: true, customState },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:01:00.000Z', position: 0 },
    };
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
    vi.mocked(panelManager.updatePanel).mockResolvedValue(undefined);
    return panel;
  }

  function attachWrapper(
    processName: string | undefined,
    readForegroundExecutable: (shellPid: number) => Promise<string | undefined> = async () => undefined,
  ) {
    const manager = testAccess<DetectionAccess>(new TerminalPanelManager(undefined, readForegroundExecutable));
    const screenEmulator = inProcessEmulatorHost().createEmulator(60, 10);
    const terminal = createTerminal({ screenEmulator, shellProcessName: 'zsh' });
    terminal.pty.process = processName;
    terminal.pty.pid = 4242;
    manager.terminals.set(terminal.panelId, terminal);
    manager.registerAgentStatusPanel(terminal);
    return { manager, terminal, screenEmulator };
  }

  it.skipIf(process.platform === 'win32')('adopts the agent named by the foreground process', async () => {
    const panel = wrapperPanel();
    const { manager, terminal } = attachWrapper('codex');

    manager.pollAgentStatus();

    expect(terminal.agentType).toBe('codex');
    expect(panel.state.customState).toMatchObject({
      agentType: 'codex',
      agentDetection: 'process',
      launchMode: 'wrapped',
      launchCommand: 'agent-farm run free-range',
      isCliPanel: true,
      isCliReady: true,
    });
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-1', { state: panel.state });
    manager.destroyTerminal(terminal.panelId);
  });

  it.skipIf(process.platform === 'win32')('resolves Claude\'s versioned native binary through its executable path', async () => {
    const panel = wrapperPanel();
    const readForegroundExecutable = vi.fn(async () => '/Users/me/.local/share/claude/versions/2.1.283');
    const { manager, terminal } = attachWrapper('2.1.283', readForegroundExecutable);

    manager.pollAgentStatus();
    manager.pollAgentStatus();
    await flushPromises();
    await flushPromises();

    expect(readForegroundExecutable).toHaveBeenCalledTimes(1);
    expect(readForegroundExecutable).toHaveBeenCalledWith(4242);
    expect(terminal.agentType).toBe('claude');
    expect(panel.state.customState).toMatchObject({ agentType: 'claude', agentDetection: 'process' });
    manager.destroyTerminal(terminal.panelId);
  });

  it('adopts an agent from its screen only after two consecutive matches', async () => {
    const panel = wrapperPanel();
    const { manager, terminal, screenEmulator } = attachWrapper('node');

    screenEmulator.write(`${rule}\r\n❯ \r\n${rule}`);
    await screenEmulator.refresh();
    manager.pollAgentStatus();
    expect(terminal.agentType).toBeUndefined();
    expect(panel.state.customState).not.toHaveProperty('agentType');

    manager.pollAgentStatus();
    expect(terminal.agentType).toBe('claude');
    expect(panel.state.customState).toMatchObject({ agentType: 'claude', agentDetection: 'screen', launchMode: 'wrapped' });
    manager.destroyTerminal(terminal.panelId);
  });

  it('restarts the screen count when a frame does not match', async () => {
    wrapperPanel();
    const { manager, terminal, screenEmulator } = attachWrapper('node');

    screenEmulator.write(`${rule}\r\n❯ \r\n${rule}`);
    await screenEmulator.refresh();
    manager.pollAgentStatus();
    screenEmulator.write('\x1b[2J\x1b[Hbuilding…');
    await screenEmulator.refresh();
    manager.pollAgentStatus();
    screenEmulator.write(`\x1b[2J\x1b[H${rule}\r\n❯ \r\n${rule}`);
    await screenEmulator.refresh();
    manager.pollAgentStatus();

    expect(terminal.agentType).toBeUndefined();
    manager.destroyTerminal(terminal.panelId);
  });

  it.skipIf(process.platform === 'win32')('ignores an agent frame left on screen at Pane\'s own shell prompt', async () => {
    wrapperPanel({});
    const { manager, terminal, screenEmulator } = attachWrapper('-zsh');

    screenEmulator.write(`${rule}\r\n❯ \r\n${rule}\r\n$ `);
    await screenEmulator.refresh();
    manager.pollAgentStatus();
    manager.pollAgentStatus();
    manager.pollAgentStatus();

    expect(terminal.agentType).toBeUndefined();
    expect(manager.getForegroundProcess(terminal.panelId)).toEqual({ name: '-zsh', isShell: true });
    manager.destroyTerminal(terminal.panelId);
  });

  it.skipIf(process.platform === 'win32')('treats a shell-script wrapper as a program, not the prompt', () => {
    wrapperPanel();
    const { manager, terminal } = attachWrapper('bash');

    expect(manager.getForegroundProcess(terminal.panelId)).toEqual({ name: 'bash', isShell: false });
    manager.destroyTerminal(terminal.panelId);
  });

  it('cannot name the foreground process of a ptyHost terminal', () => {
    wrapperPanel();
    const { manager, terminal } = attachWrapper('ptyHost');
    terminal.isPtyHost = true;

    expect(manager.getForegroundProcess(terminal.panelId)).toBeUndefined();
    manager.destroyTerminal(terminal.panelId);
  });
});

describe('TerminalPanelManager long prompt delivery', () => {
  const promptFile = "/home/me/.pane/prompts/session-1/it's.md";
  const promptWord = `"$(cat '/home/me/.pane/prompts/session-1/it'\\''s.md')"`;
  const longPrompt = 'First line with ! and $HOME\nSecond line';

  afterEach(() => {
    resetPaneRuntimeForTests();
    vi.mocked(panelManager.getPanel).mockReset();
    vi.mocked(panelManager.updatePanel).mockReset();
    vi.useRealTimers();
  });

  it.each([
    ['claude', 'claude --dangerously-skip-permissions', `claude --dangerously-skip-permissions --session-id 11111111-1111-4111-8111-111111111111 ${promptWord}`],
    ['codex', 'codex --yolo', `codex --yolo ${promptWord}`],
  ] as const)('launches %s with the prompt read from its file, never typed into the shell', (agentType, command, expected) => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('11111111-1111-4111-8111-111111111111', command, {
      agentType,
      initialInputMode: 'argument',
      initialInput: longPrompt,
      initialInputFile: promptFile,
    }, 'zsh');

    expect(result.commandToRun).toBe(expected);
    expect(result.commandToRun).not.toContain('First line');
    expect(result.customState.initialInputSentAt).toEqual(expect.any(String));
  });

  it('launches Cursor with the prompt read from its file', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'cursor-agent --force', {
      agentType: 'cursor',
      initialInputMode: 'argument',
      initialInput: longPrompt,
      initialInputFile: promptFile,
    }, 'bash');

    expect(result.commandToRun).toContain(`--resume "$__PANE_CURSOR_CHAT" ${promptWord}; else cursor-agent --force ${promptWord}; fi`);
    expect(result.commandToRun).not.toContain('First line');
  });

  it('keeps a short prompt as a quoted argument', () => {
    const manager = testAccess<LaunchCommandAccess>(new TerminalPanelManager());

    const result = manager.resolveCliLaunchCommand('panel-1', 'codex --yolo', {
      agentType: 'codex',
      initialInputMode: 'argument',
      initialInput: 'Plan issue 42',
    }, 'zsh');

    expect(result.commandToRun).toBe('codex --yolo "Plan issue 42"');
  });

  it.each([
    ['zsh', true],
    ['bash', true],
    ['sh', true],
    ['fish', false],
    ['pwsh', false],
    ['powershell', false],
    ['cmd', false],
  ])('reads long prompts from a file only in POSIX shells (%s)', (shellName, expected) => {
    setPaneRuntime({
      eventSink: { send: vi.fn() },
      daemonEventSink: { send: vi.fn() },
      getConfigManager: () => partialMock<ConfigManager>({ getPreferredShell: () => 'auto' }),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });
    const defaultShell = vi.spyOn(ShellDetector, 'getDefaultShell')
      .mockReturnValue({ path: `/bin/${shellName}`, name: shellName, args: [] });

    try {
      expect(new TerminalPanelManager().launchShellReadsPromptFile(null)).toBe(expected && process.platform !== 'win32');
    } finally {
      defaultShell.mockRestore();
    }
  });

  it.each([
    [true, '\x1b[200~First line\nSecond line\nThird line\x1b[201~'],
    [false, 'First line\nSecond line\nThird line'],
  ])('stages long held input for an agent as one paste when it asked for bracketed paste (%s), then sends Enter alone', async (bracketedPasteMode, staged) => {
    vi.useFakeTimers();
    const manager = testAccess<InitialInputAccess>(new TerminalPanelManager());
    const terminal = createTerminal({ agentType: 'claude', bracketedPasteMode });
    manager.terminals.set(terminal.panelId, terminal);
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: terminal.panelId,
      sessionId: terminal.sessionId,
      type: 'terminal',
      title: 'Claude',
      state: {
        isActive: true,
        customState: { agentType: 'claude', launchMode: 'wrapped', initialInput: 'First line\r\nSecond line\rThird line\r\n' },
      },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:01:00.000Z', position: 0 },
    });
    echoStagedWrites(terminal);

    manager.sendInitialInputOnce(terminal.panelId);
    await flushPromises();
    expect(terminal.pty.write.mock.calls).toEqual([[staged]]);

    // Still drawing the paste: no Enter yet.
    terminal.lastOutputAt = new Date();
    await vi.advanceTimersByTimeAsync(200);
    expect(terminal.pty.write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(400);
    expect(terminal.pty.write.mock.calls).toEqual([[staged], ['\r']]);
    disposeFlowControlRecord(terminal.flowControl);
  });

  it('tracks whether the program in the panel asked for bracketed paste', () => {
    vi.useFakeTimers();
    setPaneRuntime({
      eventSink: { send: vi.fn() },
      daemonEventSink: { send: vi.fn() },
      getConfigManager: () => createConfigManagerStub(),
      getPtyHostRuntime: () => null,
      getWebviewContextMap: () => new Map(),
    });
    const manager = testAccess<HandlerAccess & TerminalPanelManager>(new TerminalPanelManager());
    let emit: (data: string) => void = () => {};
    const terminal = createTerminal({ outputBuffer: '' });
    const pty = Object.assign(terminal.pty, {
      onData: vi.fn((listener: (data: string) => void) => {
        emit = listener;
        return { dispose: vi.fn() };
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    });
    manager.terminals.set(terminal.panelId, { ...terminal, pty });
    const live = manager.terminals.get(terminal.panelId);
    if (!live) throw new Error('terminal missing');
    manager.setupTerminalHandlers(live);

    expect(manager.isBracketedPasteEnabled(terminal.panelId)).toBe(false);
    emit('\x1b[?1049h\x1b[?2004');
    expect(manager.isBracketedPasteEnabled(terminal.panelId)).toBe(false);
    emit('hClaude Code');
    expect(manager.isBracketedPasteEnabled(terminal.panelId)).toBe(true);
    emit('frame without mode changes');
    expect(manager.isBracketedPasteEnabled(terminal.panelId)).toBe(true);
    emit('\x1b[?2004h\x1b[?');
    emit('2004');
    emit('l$ ');
    expect(manager.isBracketedPasteEnabled(terminal.panelId)).toBe(false);
    disposeFlowControlRecord(terminal.flowControl);
  });
});


describe('chat promotion shutdown', () => {
  it('accepts a live idle prompt while the sidebar status is still settling', async () => {
    const manager = new TerminalPanelManager();
    const screenEmulator = inProcessEmulatorHost().createEmulator(80, 24);
    screenEmulator.write('────────────────────\r\n❯ \r\n────────────────────\r\n  bypass permissions on');
    const terminal = createTerminal({ agentType: 'claude', screenEmulator });
    testAccess<VisibilityAccess>(manager).terminals.set(terminal.panelId, terminal);
    vi.spyOn(manager, 'getAgentStatus').mockReturnValue('working');
    vi.spyOn(manager, 'saveTerminalState').mockResolvedValue();
    let exit: (() => void) | undefined;
    terminal.pty.onExit.mockImplementation((callback: () => void) => { exit = callback; return { dispose: vi.fn() }; });
    terminal.pty.kill.mockImplementation(() => exit?.());
    try {
      await manager.stopForPromotion(terminal.panelId);
      expect(terminal.pty.kill).toHaveBeenCalledOnce();
    } finally {
      screenEmulator.dispose();
    }
  });

  it('rejects visible work even when the cached status is idle', async () => {
    const manager = new TerminalPanelManager();
    const screenEmulator = inProcessEmulatorHost().createEmulator(80, 24);
    screenEmulator.write('\x1b]0;⠋ Working\x07');
    const terminal = createTerminal({ agentType: 'claude', screenEmulator });
    testAccess<VisibilityAccess>(manager).terminals.set(terminal.panelId, terminal);
    vi.spyOn(manager, 'getAgentStatus').mockReturnValue('idle');
    try {
      await expect(manager.stopForPromotion(terminal.panelId)).rejects.toThrow('finish');
      expect(terminal.pty.kill).not.toHaveBeenCalled();
    } finally {
      screenEmulator.dispose();
      disposeFlowControlRecord(terminal.flowControl);
    }
  });

  it('saves output before killing and waits for the old process to exit', async () => {
    const manager = new TerminalPanelManager();
    const terminal = createTerminal();
    testAccess<VisibilityAccess>(manager).terminals.set(terminal.panelId, terminal);
    vi.spyOn(manager, 'getAgentStatus').mockReturnValue('idle');
    const order: string[] = [];
    vi.spyOn(manager, 'saveTerminalState').mockImplementation(async () => { order.push('saved'); });
    let exit: (() => void) | undefined;
    terminal.pty.onExit.mockImplementation((callback: () => void) => { exit = callback; return { dispose: vi.fn() }; });
    terminal.pty.kill.mockImplementation(() => order.push('killed'));
    const stopping = manager.stopForPromotion(terminal.panelId).then(() => order.push('finished'));
    await Promise.resolve();
    expect(order).toEqual(['saved', 'killed']);
    exit?.();
    await stopping;
    expect(order).toEqual(['saved', 'killed', 'finished']);
  });

  it('does not kill or save a working agent', async () => {
    const manager = new TerminalPanelManager();
    const terminal = createTerminal();
    testAccess<VisibilityAccess>(manager).terminals.set(terminal.panelId, terminal);
    vi.spyOn(manager, 'getAgentStatus').mockReturnValue('working');
    const save = vi.spyOn(manager, 'saveTerminalState');
    await expect(manager.stopForPromotion(terminal.panelId)).rejects.toThrow('finish');
    expect(save).not.toHaveBeenCalled();
    expect(terminal.pty.kill).not.toHaveBeenCalled();
  });
});
