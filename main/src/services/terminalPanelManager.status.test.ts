import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPanelManager } from './terminalPanelManager';
import { inProcessEmulatorHost } from '../test/inProcessEmulatorHost';
import { AgentStatusMonitor } from './agentStatus/agentStatusMonitor';
import { WorkspaceJournal } from './workspaceJournal';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../core/runtime';
import type { PaneEventArgument } from '../core/eventSink';
import type { ToolPanel } from '../../../shared/types/panels';
import { createFlowControlRecord, disposeFlowControlRecord } from '../ptyHost/flowControl';
import { panelManager } from '../test/setup';
import { formatWaitResult } from '../../../packages/runpane/src/watchLines';

function createTerminal(agentType: 'claude' | 'codex' | undefined = 'codex') {
  let onData: (data: string) => void = () => undefined;
  let onExit: (exit: { exitCode: number; signal?: number }) => void = () => undefined;
  const terminal = {
    panelId: 'p', sessionId: 's', agentType,
    pty: {
      onData: (listener: typeof onData) => { onData = listener; },
      onExit: (listener: typeof onExit) => { onExit = listener; },
      write: vi.fn(), kill: vi.fn(), cols: 80, rows: 24, pid: process.pid,
    },
    screenEmulator: inProcessEmulatorHost().createEmulator(80, 24),
    scrollbackBuffer: '', alternateScreenBuffer: '', commandHistory: [],
    currentCommand: '', lastActivity: new Date(), outputGeneration: 0,
    flowControl: createFlowControlRecord(), outputBuffer: '',
    // SAFETY: PTY output handlers assign timeout handles; fixtures start without one.
    outputFlushTimer: null as ReturnType<typeof setTimeout> | null,
    isVisible: true, isAlternateScreen: false, inSyncBlock: false,
    filterInAltScreen: false, agentSessionScrapeBuffer: '',
  };
  return { terminal, data: (data: string) => onData(data), exit: (exit: { exitCode: number; signal?: number } = { exitCode: 0 }) => onExit(exit) };
}

type TerminalFixture = ReturnType<typeof createTerminal>;
interface StatusAccess {
  terminals: Map<string, TerminalFixture['terminal']>;
  agentStatusMonitor: AgentStatusMonitor;
  setupTerminalHandlers(terminal: TerminalFixture['terminal']): void;
  pollAgentStatus(): void;
  sendInitialInputOnce(panelId: string): void;
  getProcessCwd(pid: number): Promise<string>;
}

let manager: TerminalPanelManager;
let access: StatusAccess;
let journal: WorkspaceJournal;
let fixtures: TerminalFixture[];
let events: Array<{ channel: string; payload: PaneEventArgument }>;

function attach(agentType?: 'claude' | 'codex', startedAt = 0) {
  const fixture = createTerminal(agentType);
  fixtures.push(fixture);
  access.terminals.set('p', fixture.terminal);
  access.agentStatusMonitor.register('p', startedAt);
  access.setupTerminalHandlers(fixture.terminal);
  return fixture;
}

async function pollAgentStatus() {
  // Production polls the worker's pushed cache; drain writes over the real
  // emulator protocol so each assertion observes the output just emitted.
  await Promise.all([...access.terminals.values()].map(terminal => terminal.screenEmulator.refresh()));
  access.pollAgentStatus();
}

beforeEach(() => {
  // xterm writes need real timers; only the status clock is controlled.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(20_000);
  fixtures = [];
  events = [];
  manager = new TerminalPanelManager();
  // SAFETY: This seam mirrors the private members used by these PTY fixtures.
  access = manager as StatusAccess;
  journal = new WorkspaceJournal({
    resolvePane: paneId => ({ paneId, paneName: 'Pane' }),
    resolvePanel: panelId => ({ panelId, paneId: 's', isCliPanel: true }),
  });
  setPaneRuntime({ eventSink: { send(channel, payload) {
    events.push({ channel, payload });
    journal.send(channel, payload);
  } } });
  panelManager.emitPanelEvent.mockImplementation((panelId, type, data) => {
    journal.send('panel:event', { type, source: { panelId, sessionId: 's' }, data });
  });
});

afterEach(() => {
  for (const { terminal } of fixtures) {
    if (terminal.outputFlushTimer) clearTimeout(terminal.outputFlushTimer);
    terminal.screenEmulator.dispose();
    disposeFlowControlRecord(terminal.flowControl);
  }
  journal.dispose();
  resetPaneRuntimeForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  panelManager.getPanel.mockReset();
  panelManager.updatePanel.mockReset();
});

describe('terminal status events', () => {
  it('publishes consistent idle status on exit and deduplicates repeated callbacks', async () => {
    const fixture = attach('codex');
    fixture.data('\x1b]2;⠙ Codex\x07');
    await pollAgentStatus();
    fixture.exit();
    fixture.exit();
    expect(events.filter(event => event.channel === 'panel:activityStatus').at(-1)?.payload).toMatchObject({ status: 'idle' });
    expect(events.filter(event => event.channel === 'terminal:exited')).toHaveLength(1);
    expect(manager.getAgentStatus('p')).toBeUndefined();
    expect(journal.readAfter(0).entries.map(entry => entry.kind)).toEqual(['agent.busy', 'panel.exited']);
  });

  it('retires destroyed terminals before old exit and data callbacks can affect a replacement', async () => {
    vi.spyOn(manager, 'saveTerminalState').mockResolvedValue();
    const old = attach('codex');
    old.data('\x1b]2;⠙ Codex\x07');
    await pollAgentStatus();
    await manager.destroyTerminal('p');
    expect(events.filter(event => event.channel === 'panel:agentStatus').at(-1)?.payload).toMatchObject({ state: 'idle', reason: 'destroyed' });
    expect(journal.readAfter(0).entries.map(entry => entry.kind)).toEqual(['agent.busy', 'panel.exited']);
    expect(formatWaitResult({ epoch: journal.epoch, ...journal.readAfter(0) }, 'lines').some(line => line.startsWith('READY'))).toBe(false);
    const replacement = attach('codex');
    replacement.data('\x1b]2;⠙ Codex\x07');
    await pollAgentStatus();
    const count = events.length;
    old.exit();
    old.data('old output');
    expect(events).toHaveLength(count);
    expect(manager.isTerminalInitialized('p')).toBe(true);
    expect(manager.getAgentStatus('p')).toBe('working');
    replacement.exit();
    expect(journal.readAfter(0).entries.filter(entry => entry.kind === 'panel.exited')).toHaveLength(2);
  });

  it('skips snapshot persistence when the panel is being deleted', async () => {
    const fixture = attach('codex');
    const save = vi.spyOn(manager, 'saveTerminalState');
    await manager.destroyTerminal('p', { saveState: false });
    expect(save).not.toHaveBeenCalled();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(manager.isTerminalInitialized('p')).toBe(false);
  });

  it.each([
    { label: 'live PTY', exit: undefined },
    { label: 'successful exit', exit: { exitCode: 0 } },
    { label: 'signaled exit', exit: { exitCode: 17, signal: 9 } },
  ])('drains and saves before disposal, preserving an exit during teardown ($label)', async ({ exit }) => {
    const fixture = attach('codex');
    panelManager.getPanel.mockReturnValue({
      id: 'p', sessionId: 's', type: 'terminal', title: 'Codex',
      state: { isActive: true, customState: { cwd: '/old' } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    });
    vi.spyOn(access, 'getProcessCwd').mockResolvedValue('/live');
    fixture.data('last output before archive');
    const destroying = manager.destroyTerminal('p');
    expect(fixture.terminal.pty.kill).not.toHaveBeenCalled();
    expect(manager.destroyTerminal('p')).toBe(destroying);
    // Closing callbacks cannot dispose the model before queued writes drain.
    if (exit) fixture.exit(exit);
    fixture.data('output after teardown began');
    manager.writeToTerminal('p', 'late input');
    expect(fixture.terminal.pty.write).not.toHaveBeenCalled();
    await destroying;
    expect(panelManager.updatePanel).toHaveBeenCalledWith('p', { state: expect.objectContaining({
      customState: expect.objectContaining({ scrollbackBuffer: expect.stringContaining('last output before archive') }),
    }) });
    if (exit) expect(fixture.terminal.pty.kill).not.toHaveBeenCalled();
    else expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(journal.readAfter(0).entries).toMatchObject([{
      kind: 'panel.exited', exitCode: exit?.exitCode,
      reason: exit?.signal === undefined ? 'terminal:exit' : `signal:${exit.signal}`,
    }]);
    fixture.exit();
    expect(journal.readAfter(0).entries).toHaveLength(1);
  });

  it.each(['cwd read', 'worker snapshot'])('does not persist or retire a replacement during teardown %s', async phase => {
    const old = attach('codex');
    panelManager.getPanel.mockReturnValue({
      id: 'p', sessionId: 's', type: 'terminal', title: 'Codex',
      state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    });
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(access, 'getProcessCwd').mockImplementation(async () => {
      if (phase === 'cwd read') await pending;
      return '/live';
    });
    const restoreSnapshot = old.terminal.screenEmulator.restoreSnapshot.bind(old.terminal.screenEmulator);
    let snapshotStarted: () => void = () => undefined;
    const snapshotRead = new Promise<void>(resolve => { snapshotStarted = resolve; });
    if (phase === 'worker snapshot') {
      vi.spyOn(old.terminal.screenEmulator, 'restoreSnapshot').mockImplementation(async () => {
        snapshotStarted();
        await pending;
        return restoreSnapshot();
      });
    }
    const destroying = manager.destroyTerminal('p');
    if (phase === 'worker snapshot') await snapshotRead;
    const replacement = attach('codex');
    replacement.data('\x1b]2;⠙ Codex\x07');
    release();
    await destroying;
    await pollAgentStatus();
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    expect(replacement.terminal.pty.kill).not.toHaveBeenCalled();
    expect(manager.getAgentStatus('p')).toBe('working');
  });

  it('still retires and kills the terminal when saving fails', async () => {
    const fixture = attach('codex');
    vi.spyOn(manager, 'saveTerminalState').mockRejectedValue(new Error('persistence failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await manager.destroyTerminal('p');
    expect(error).toHaveBeenCalled();
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(manager.isTerminalInitialized('p')).toBe(false);
  });

  it.each(['panel:agentStatus', 'terminal:output'])('cleans up even when %s delivery fails during teardown', async channel => {
    const fixture = attach('codex');
    if (channel === 'terminal:output') fixture.data('pending output');
    const dispose = vi.spyOn(fixture.terminal.screenEmulator, 'dispose');
    setPaneRuntime({ eventSink: { send(sentChannel) {
      if (sentChannel === channel) throw new Error('event delivery failed');
    } } });
    await expect(manager.destroyTerminal('p', { saveState: false })).rejects.toThrow('event delivery failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(manager.isTerminalInitialized('p')).toBe(false);
    expect(access.agentStatusMonitor.isTracked('p')).toBe(false);
    await manager.destroyTerminal('p');
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
  });

  it('kills the PTY even when emulator disposal fails', async () => {
    const fixture = attach('codex');
    vi.spyOn(fixture.terminal.screenEmulator, 'dispose').mockImplementationOnce(() => { throw new Error('dispose failed'); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await manager.destroyTerminal('p', { saveState: false });
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
    expect(manager.isTerminalInitialized('p')).toBe(false);
  });

  it('still kills a WSL terminal when its graceful exit write fails', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const fixture = attach('codex');
    Object.assign(fixture.terminal, { isWSL: true });
    fixture.terminal.pty.write.mockImplementation(() => { throw new Error('exit write failed'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await manager.destroyTerminal('p', { saveState: false });
    expect(manager.isTerminalInitialized('p')).toBe(false);
    expect(fixture.terminal.pty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(fixture.terminal.pty.kill).toHaveBeenCalledOnce();
  });

  it('disposes an exited terminal even when status delivery fails', () => {
    const fixture = attach('codex');
    const dispose = vi.spyOn(fixture.terminal.screenEmulator, 'dispose');
    setPaneRuntime({ eventSink: { send(channel) {
      if (channel === 'panel:agentStatus') throw new Error('event delivery failed');
    } } });
    expect(() => fixture.exit()).toThrow('event delivery failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.isTerminalInitialized('p')).toBe(false);
    expect(fixture.terminal.pty.kill).not.toHaveBeenCalled();
  });

  it('polls only the replacement after the old worker cache changes', async () => {
    const old = attach('codex');
    const replacement = attach('codex');
    old.terminal.screenEmulator.write('\x1b]2;Codex\x07');
    replacement.data('\x1b]2;⠙ Codex\x07');
    await Promise.all([old.terminal.screenEmulator.refresh(), replacement.terminal.screenEmulator.refresh()]);
    access.pollAgentStatus();
    expect(events.filter(event => event.channel === 'panel:agentStatus').map(event => event.payload)).toEqual([
      { panelId: 'p', sessionId: 's', state: 'working', reason: 'osc_title_working' },
    ]);
  });

  it.each(['deleted', 'replaced'] as const)('does not persist a delayed worker snapshot after its panel is %s', async action => {
    const fixture = attach('codex');
    const panel = {
      id: 'p', sessionId: 's', type: 'terminal' as const, title: 'Codex',
      state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    };
    panelManager.getPanel.mockReturnValue(panel);
    vi.spyOn(access, 'getProcessCwd').mockResolvedValue('/live');
    fixture.data('old terminal output');
    const restoreSnapshot = fixture.terminal.screenEmulator.restoreSnapshot.bind(fixture.terminal.screenEmulator);
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let snapshotStarted: () => void = () => undefined;
    const snapshotRead = new Promise<void>(resolve => { snapshotStarted = resolve; });
    vi.spyOn(fixture.terminal.screenEmulator, 'restoreSnapshot').mockImplementation(async () => {
      snapshotStarted();
      await pending;
      return restoreSnapshot();
    });
    const saving = manager.saveTerminalState('p');
    await snapshotRead;
    panelManager.getPanel.mockReturnValue(action === 'deleted' ? undefined : { ...panel, state: { isActive: false } });
    release();
    await saving;
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
    expect(panel.state).toEqual({ isActive: true });
  });

  it('preserves panel state updates made while the worker snapshot is pending', async () => {
    const fixture = attach('codex');
    const panel: ToolPanel = {
      id: 'p', sessionId: 's', type: 'terminal', title: 'Codex',
      state: { isActive: true, customState: { initialInput: 'task' } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    };
    panelManager.getPanel.mockReturnValue(panel);
    vi.spyOn(access, 'getProcessCwd').mockResolvedValue('/live');
    fixture.data('terminal output to persist');
    const restoreSnapshot = fixture.terminal.screenEmulator.restoreSnapshot.bind(fixture.terminal.screenEmulator);
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let snapshotStarted: () => void = () => undefined;
    const snapshotRead = new Promise<void>(resolve => { snapshotStarted = resolve; });
    vi.spyOn(fixture.terminal.screenEmulator, 'restoreSnapshot').mockImplementation(async () => {
      snapshotStarted();
      await pending;
      return restoreSnapshot();
    });
    const saving = manager.saveTerminalState('p');
    await snapshotRead;
    // PanelManager replaces state while retaining the same ToolPanel object.
    panel.state = {
      isActive: false,
      customState: { initialInput: 'task', initialInputSentAt: '2026-09-24T00:00:00.000Z', dimensions: { cols: 120, rows: 40 } },
    };
    release();
    await saving;
    expect(panelManager.updatePanel).toHaveBeenCalledWith('p', { state: expect.objectContaining({
      isActive: false,
      customState: expect.objectContaining({
        initialInput: 'task', initialInputSentAt: '2026-09-24T00:00:00.000Z', dimensions: { cols: 120, rows: 40 },
        scrollbackBuffer: expect.stringContaining('terminal output to persist'),
      }),
    }) });
  });

  it('discards a terminal state read after the terminal was replaced', async () => {
    const old = attach('codex');
    old.data('old terminal output');
    const restoreSnapshot = old.terminal.screenEmulator.restoreSnapshot.bind(old.terminal.screenEmulator);
    let release: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(old.terminal.screenEmulator, 'restoreSnapshot').mockImplementation(async () => {
      await pending;
      return restoreSnapshot();
    });
    const reading = manager.getTerminalState('p');
    const replacement = attach('codex');
    replacement.data('replacement output');
    release();
    expect(await reading).toBeNull();
    const state = await manager.getTerminalState('p');
    expect(state?.scrollbackBuffer).toContain('replacement output');
    expect(state?.scrollbackBuffer).not.toContain('old terminal output');
  });

  it.each(['persistence', 'submit delay'])('does not send an old initial prompt after replacement during %s', async phase => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(20_000);
    const old = attach('codex');
    let release: () => void = () => undefined;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    panelManager.getPanel.mockReturnValue({
      id: 'p', sessionId: 's', type: 'terminal', title: 'Codex',
      state: { isActive: true, customState: { initialInput: 'old task', initialInputSubmitStrategy: 'codex-ctrl-enter' } },
      metadata: { createdAt: '', lastActiveAt: '', position: 0 },
    });
    panelManager.updatePanel.mockReturnValue(persisted);
    access.sendInitialInputOnce('p');
    if (phase === 'submit delay') {
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(old.terminal.pty.write).toHaveBeenCalledWith('old task');
    }
    const replacement = attach('codex');
    release();
    await vi.advanceTimersByTimeAsync(500);
    expect(replacement.terminal.pty.write).not.toHaveBeenCalled();
    panelManager.getPanel.mockReset();
    panelManager.updatePanel.mockReset();
  });

  it('retains tracking after a write error until actual exit evidence arrives', async () => {
    const fixture = attach('codex');
    fixture.data('\x1b]2;⠙ Codex\x07');
    await pollAgentStatus();
    fixture.terminal.pty.write.mockImplementation(() => { throw new Error('write failed'); });
    manager.writeToTerminal('p', 'hello');
    expect(manager.isTerminalInitialized('p')).toBe(true);
    expect(manager.getAgentStatus('p')).toBe('working');
    fixture.exit();
    expect(manager.getAgentStatus('p')).toBeUndefined();
  });
});
