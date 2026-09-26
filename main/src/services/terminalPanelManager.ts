import * as pty from '@lydell/node-pty';
import { EventEmitter } from 'events';
import { filterSyncBlockClears } from './syncBlockClearFilter';
import { ToolPanel, TerminalPanelState } from '../../../shared/types/panels';
import { getPaneDaemonEventSink, getPaneEventSink, getPtyHostRuntime, getRuntimeConfigManager, type PtyHandleLike, type PtyHostRuntime } from '../core/runtime';
import { panelManager } from './panelManager';
import * as path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { getShellPath } from '../utils/shellPath';
import { trimAnsiSafe } from '../utils/ansiTrim';
import { databaseService } from './database';
import { ShellDetector } from '../utils/shellDetector';
import type { AnalyticsManager } from './analyticsManager';
import { getWSLShellSpawn, buildWSLENV, WSLContext } from '../utils/wslUtils';
import { getGitAttributionEnv } from '../utils/attribution';
import { inheritedProcessEnv } from '../utils/inheritedProcessEnv';
import {
  type FlowControlRecord,
  createFlowControlRecord,
  disposeFlowControlRecord,
  onAck as flowControlOnAck,
  onPtyBytes as flowControlOnPtyBytes,
} from '../ptyHost/flowControl';
import { sharedEmulatorThread, type RemoteTerminalEmulator, type TerminalEmulatorHostConnection } from './terminalEmulatorClient';
import type { ScreenState } from './terminalEmulatorHost';
import { AgentStatusMonitor } from './agentStatus/agentStatusMonitor';
import { detectAgentState } from './agentStatus/manifestEngine';
import { getManifestForAgent } from './agentStatus/manifests';
import type { AgentDetectionResult, AgentState, PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import type { PaneEventArgument } from '../core/eventSink';

const OUTPUT_BATCH_INTERVAL = 32; // ms (~30fps) — wider window reduces TUI flicker
const OUTPUT_BATCH_INTERVAL_HIDDEN = 250; // ms — background / hidden cadence to cut IPC wake-up cost
const OUTPUT_BATCH_SIZE = 131072; // 128KB — timer-based flush preferred; size trigger is safety net
const OUTPUT_BATCH_SIZE_HIDDEN = 80_000; // 80KB — cap hidden flush size to avoid foreground backpressure churn
const MAX_CONCURRENT_SPAWNS = 3;
const AGENT_STATUS_POLL_MS = 500; // cadence for re-deriving blocked/working/done from the live screen
const MAX_SCROLLBACK_BUFFER_SIZE = 500_000; // 500KB of normal shell history
const MAX_ALTERNATE_SCREEN_BUFFER_SIZE = 100_000; // 100KB of recent TUI redraw state
// Command-detection heuristic bounds. These buffers live in memory only and
// are never persisted; full-screen apps redraw without newlines, so the
// accumulator is frozen while the alternate screen is active.
const MAX_CURRENT_COMMAND_SIZE = 4096;
const MAX_COMMAND_HISTORY_ENTRY_SIZE = 1024;
const MAX_COMMAND_HISTORY_ENTRIES = 100;
const MIN_PTY_COLS = 20;
const MIN_PTY_ROWS = 5;
const FORCED_REDRAW_TRANSITION_MS = 50;
const FORCED_REDRAW_SETTLE_MS = 80;
const SHELL_PROMPT_SETTLE_MS = 300;
const SHELL_PROMPT_FALLBACK_MS = 5000;
// Formal ceiling for the restore/getState replay payload (now the emulator
// serialization for normal buffers, raw ANSI log otherwise). Peer consensus:
// Orca (TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT) and Superset (MAX_HISTORY_SCROLLBACK_BYTES) both use
// 512 * 1024. The 2500-line emulator serialization sits well under this in
// practice; the cap is a backstop against pathological payloads.
export const MAX_RESTORE_PAYLOAD_SIZE = 512 * 1024;

import { CliAgentType, resolveAgentTypeFromCommand } from './agents/agentIdentity';
import { buildCursorLaunchCommand, createCursorReadyDetector, extractCursorChatId } from './agents/cursorLaunch';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}

function terminalCustomState(state: ToolPanel['state']): TerminalPanelState {
  // SAFETY: TerminalPanelManager owns terminal panels and persists this exact
  // custom-state contract; non-terminal panel states never enter these paths.
  return (state.customState ?? {}) as TerminalPanelState;
}

export interface TerminalPanelSnapshot {
  initialized: true;
  scrollbackBuffer: string;
  alternateScreenBuffer: string;
  /** Plain text for the current emulated viewport. */
  screenText?: string;
  isAlternateScreen: boolean;
  activityStatus: 'active' | 'idle';
  lastActivityTime: string;
  currentCommand: string;
  isCliPanel?: boolean;
  isCliReady?: boolean;
  agentType?: CliAgentType;
  agentSessionId?: string;
}

/**
 * IPty-compatible shim over a ptyHost `PtyHandle`.
 *
 * When the `usePtyHost` setting is on and the supervisor is available,
 * terminal spawns route through the ptyHost UtilityProcess and we get back a
 * `PtyHandle` whose methods are async. The managers treat the
 * `TerminalProcess.pty` field as a sync `IPty`; this shim preserves that
 * assumption by fire-and-forgetting the async calls (errors logged, not
 * awaited at call sites) and exposing `pid`/`cols`/`rows` synchronously.
 *
 * Critical: `pid` is cached from the spawn response so the synchronous
 * `.pid` reads in `getSessionPids()` and `killProcessTree` keep working.
 */
class PtyHandleShim implements pty.IPty {
  readonly pid: number;
  cols: number;
  rows: number;
  readonly process = 'ptyHost';
  handleFlowControl = false;
  readonly ptyId: string;
  private readonly handle: PtyHandleLike;
  /** Monotonic resize ordinal; only the latest call may confirm cols/rows. */
  private resizeSeq = 0;

  constructor(handle: PtyHandleLike, cols: number, rows: number) {
    this.handle = handle;
    this.ptyId = handle.id;
    this.pid = handle.pid;
    this.cols = cols;
    this.rows = rows;
  }

  readonly onData = (listener: (data: string) => void): pty.IDisposable => {
    return this.handle.onData(listener);
  };

  readonly onExit = (
    listener: (e: { exitCode: number; signal?: number }) => void,
  ): pty.IDisposable => {
    return this.handle.onExit((exitCode, signal) => {
      listener({
        exitCode: exitCode ?? 0,
        signal: signal === null ? undefined : signal,
      });
    });
  };

  resize(columns: number, rows: number): void {
    // Confirm dims only after the async host resize succeeds so dedupe never
    // compares against an unconfirmed size. The sequence check stops an older
    // in-flight resize from overwriting a newer confirmed size when promises
    // resolve out of order.
    const seq = ++this.resizeSeq;
    this.handle.resize(columns, rows).then(() => {
      if (seq === this.resizeSeq) {
        this.cols = columns;
        this.rows = rows;
      }
    }).catch((err) => {
      console.warn('[ptyHost] resize failed', err);
    });
  }

  clear(): void {
    // No-op on non-Windows; ptyHost does not currently expose a clear RPC.
  }

  write(data: string | Buffer): void {
    const str = Buffer.isBuffer(data) ? data.toString() : data;
    this.handle.write(str).catch((err) => {
      console.warn('[ptyHost] write failed', err);
    });
  }

  kill(signal?: string): void {
    // SAFETY: IPty supplies Node signal names; the ptyHost handle narrows the
    // legacy node-pty string signature to NodeJS.Signals.
    this.handle.kill(signal as NodeJS.Signals | undefined).catch((err) => {
      console.warn('[ptyHost] kill failed', err);
    });
  }

  pause(): void {
    this.handle.pause().catch((err) => {
      console.warn('[ptyHost] pause failed', err);
    });
  }

  resume(): void {
    this.handle.resume().catch((err) => {
      console.warn('[ptyHost] resume failed', err);
    });
  }
}

interface TerminalProcess {
  pty: pty.IPty;
  /** Host-allocated PTY id when routed through ptyHost; undefined under legacy `pty.spawn`. */
  ptyId?: string;
  /** True when `pty` is a `PtyHandleShim` wrapping a ptyHost handle. */
  isPtyHost: boolean;
  panelId: string;
  sessionId: string;
  scrollbackBuffer: string;
  alternateScreenBuffer: string;
  /** Authoritative xterm-compatible model of the live PTY byte stream. */
  screenEmulator?: RemoteTerminalEmulator;
  commandHistory: string[];
  currentCommand: string;
  /** Coalesces teardown callers and prevents callbacks from reviving a closing terminal. */
  destroying?: Promise<void>;
  exitDuringDestroy?: { exitCode: number; signal?: number };
  lastActivity: Date;
  lastOutputAt?: Date;
  outputGeneration: number;
  isWSL?: boolean;
  /**
   * WSL context captured at spawn time. Stored so `respawnAll` can re-inject
   * the same distro / user / WSLENV propagation after a ptyHost supervisor
   * restart without needing to reconstruct it from project state.
   */
  wslContext: WSLContext | null;
  /**
   * Flow-control bookkeeping (pending bytes, pause state, safety timer,
   * `pauseRpcInFlight` gate). Lives on the shared `FlowControlRecord` so the
   * same state-machine semantics apply to both the legacy `pty.spawn` path
   * and the ptyHost `usePtyHost` path.
   */
  flowControl: FlowControlRecord;
  // Output batching
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  // Visibility-driven cadence: true → OUTPUT_BATCH_INTERVAL + renderer writes,
  // false → OUTPUT_BATCH_INTERVAL_HIDDEN + main-process scrollback only.
  isVisible: boolean;
  // Alternate screen buffer tracking — universal TUI detection signal
  isAlternateScreen: boolean;
  /** CLI agent driving this panel, when any — selects the status-detection manifest. */
  agentType?: CliAgentType;
  /** Last status scan, reused while the emulator pushes no new screen. */
  lastStatusScan?: { screen: ScreenState; detection: AgentDetectionResult };
  /** The CLI came up with typed initial input still to send; the status poll sends it. */
  initialInputHeld?: boolean;
  // DEC Mode 2026 synchronized-output block tracking — persists across chunks
  inSyncBlock: boolean;
  /** Alt-screen state as seen by filterSyncBlockClears (stream-ordered, may
   *  differ transiently from isAlternateScreen which is chunk-granular). */
  filterInAltScreen: boolean;
  capturedAgentSessionId?: string;
  agentSessionScrapeBuffer: string;
}

interface CliLaunchResolution {
  commandToRun: string;
  customState: TerminalPanelState;
  isCliCommand: boolean;
}

export class TerminalPanelManager extends EventEmitter {
  private terminals = new Map<string, TerminalProcess>();
  private serializedBuffers = new Map<string, string>();
  private readonly visibleViewersByPanel = new Map<string, Map<string, number>>();
  private readonly MAX_SCROLLBACK_LINES = 10000;
  private analyticsManager: AnalyticsManager | null = null;

  // Spawn concurrency limiter — prevents CPU spikes when many terminals init at once
  private activeSpawns = 0;
  private spawnQueue: Array<{ resolve: () => void; priority: number }> = [];

  // At-a-glance agent status (blocked/working/done) for AI/CLI panels.
  private readonly agentStatusMonitor = new AgentStatusMonitor();
  private agentStatusPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Screen models parse PTY output on this host, off the main thread. */
  constructor(private readonly emulatorHost: () => TerminalEmulatorHostConnection = sharedEmulatorThread) {
    super();
    this.setMaxListeners(100);
  }

  private quoteCommandArgument(value: string): string {
    return `"${value.replace(/([\\"$`])/g, '\\$1')}"`;
  }

  private resolveCliLaunchCommand(
    panelId: string,
    initialCommand: string,
    customState: TerminalPanelState,
    shellType?: string,
  ): CliLaunchResolution {
    const agentType = customState.agentType ?? resolveAgentTypeFromCommand(initialCommand);
    if (!agentType) {
      return { commandToRun: initialCommand, customState, isCliCommand: false };
    }

    const nextState: TerminalPanelState = {
      ...customState,
      isCliPanel: true,
      isCliReady: false,
      agentType,
    };

    const resolution = agentType === 'claude'
      ? this.resolveClaudeLaunch(panelId, initialCommand, customState, nextState)
      : agentType === 'codex'
        ? this.resolveCodexLaunch(panelId, initialCommand, customState, nextState)
        : this.resolveCursorLaunch(panelId, initialCommand, customState, nextState, shellType);

    return resolution ?? { commandToRun: initialCommand, customState: nextState, isCliCommand: true };
  }

  private resolveClaudeLaunch(
    panelId: string,
    initialCommand: string,
    customState: TerminalPanelState,
    nextState: TerminalPanelState,
  ): CliLaunchResolution | undefined {
    if (
      !initialCommand.includes('--session-id') &&
      !initialCommand.includes('--resume')
    ) {
      const existingClaudeSessionId = isValidUuid(customState.agentSessionId)
        ? customState.agentSessionId
        : isValidUuid(panelId)
          ? panelId
          : undefined;
      const claudeSessionId = existingClaudeSessionId ?? randomUUID();
      const canResumeClaudeSession = customState.hasClaudeSessionId === true && Boolean(existingClaudeSessionId);
      const initialPromptArg = customState.initialInputMode === 'argument' && customState.initialInput?.trim()
        ? ` ${this.quoteCommandArgument(customState.initialInput)}`
        : '';

      nextState.hasClaudeSessionId = true;
      nextState.agentSessionId = claudeSessionId;
      nextState.wasInterrupted = undefined;
      if (initialPromptArg && !canResumeClaudeSession) {
        nextState.initialInputSentAt = new Date().toISOString();
        nextState.initialInputError = undefined;
      }

      return {
        commandToRun: canResumeClaudeSession
          ? `claude --resume ${claudeSessionId} --dangerously-skip-permissions`
          : `${initialCommand} --session-id ${claudeSessionId}${initialPromptArg}`,
        customState: nextState,
        isCliCommand: true,
      };
    }

    if (customState.wasInterrupted) {
      nextState.wasInterrupted = undefined;
      return { commandToRun: initialCommand, customState: nextState, isCliCommand: true };
    }

    return undefined;
  }

  private resolveCodexLaunch(
    panelId: string,
    initialCommand: string,
    customState: TerminalPanelState,
    nextState: TerminalPanelState,
  ): CliLaunchResolution | undefined {
    if (customState.wasInterrupted) {
      nextState.wasInterrupted = undefined;
      // Keep Pane Chat's helper-subagent flags (`-c 'agents.…'`) on resume;
      // other options, such as a prompt in a custom command, don't apply.
      const launchOptions = (initialCommand.match(/ -c 'agents\.(?:[^']|'\\'')*'/g) ?? []).join('');
      const commandToRun = customState.agentSessionId
        ? `codex resume --yolo${launchOptions} ${customState.agentSessionId}`
        : `codex resume --yolo${launchOptions}`;

      if (customState.agentSessionId) {
        console.log(`[TerminalPanelManager] Resolved interrupted Codex panel ${panelId} to direct resume`);
      } else {
        console.log(`[TerminalPanelManager] Resolved interrupted Codex panel ${panelId} to interactive resume picker`);
      }

      return {
        commandToRun,
        customState: nextState,
        isCliCommand: true,
      };
    }

    if (
      customState.initialInputMode === 'argument' &&
      customState.initialInput?.trim() &&
      !customState.initialInputSentAt
    ) {
      nextState.initialInputSentAt = new Date().toISOString();
      nextState.initialInputError = undefined;
      return {
        commandToRun: `${initialCommand} ${this.quoteCommandArgument(customState.initialInput)}`,
        customState: nextState,
        isCliCommand: true,
      };
    }

    return undefined;
  }

  private resolveCursorLaunch(
    panelId: string,
    initialCommand: string,
    customState: TerminalPanelState,
    nextState: TerminalPanelState,
    shellType?: string,
  ): CliLaunchResolution | undefined {
    if (customState.wasInterrupted) {
      nextState.wasInterrupted = undefined;
      const commandToRun = customState.agentSessionId
        ? buildCursorLaunchCommand({ baseCommand: initialCommand, resumeChatId: customState.agentSessionId })
        : `${initialCommand} --continue`;

      if (customState.agentSessionId) {
        console.log(`[TerminalPanelManager] Resolved interrupted Cursor panel ${panelId} to direct resume`);
      } else {
        console.warn(`[TerminalPanelManager] Interrupted Cursor panel ${panelId} has no captured chat id; continuing latest chat`);
      }

      return { commandToRun, customState: nextState, isCliCommand: true };
    }

    if (!/--resume\b|--continue\b/.test(initialCommand)) {
      const promptArgument =
        customState.initialInputMode === 'argument' && customState.initialInput?.trim() && !customState.initialInputSentAt
          ? customState.initialInput
          : undefined;
      if (promptArgument) {
        nextState.initialInputSentAt = new Date().toISOString();
        nextState.initialInputError = undefined;
      }
      return {
        commandToRun: buildCursorLaunchCommand({ baseCommand: initialCommand, promptArgument, shellType }),
        customState: nextState,
        isCliCommand: true,
      };
    }

    return undefined;
  }

  private async markInitialInputSent(panelId: string): Promise<{
    input: string;
    submitStrategy: NonNullable<TerminalPanelState['initialInputSubmitStrategy']>;
  } | null> {
    const currentPanel = panelManager.getPanel(panelId);
    if (!currentPanel) {
      return null;
    }

    const state = currentPanel.state;
    const customState = terminalCustomState(state);
    if (!customState.initialInput || customState.initialInputSentAt) {
      return null;
    }

    const input = customState.initialInput;
    const submitStrategy = customState.initialInputSubmitStrategy ?? 'enter';
    customState.initialInputSentAt = new Date().toISOString();
    customState.initialInputError = undefined;
    state.customState = customState;
    await panelManager.updatePanel(panelId, { state });
    return { input, submitStrategy };
  }

  private async markInitialInputError(panelId: string, errorMessage: string): Promise<void> {
    const currentPanel = panelManager.getPanel(panelId);
    if (!currentPanel) {
      return;
    }

    const state = currentPanel.state;
    const customState = terminalCustomState(state);
    customState.initialInputError = errorMessage;
    state.customState = customState;
    await panelManager.updatePanel(panelId, { state });
  }

  private sendInitialInputOnce(panelId: string): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal || terminal.destroying) return;
    this.markInitialInputSent(panelId).then((delivery) => {
      if (!delivery || this.terminals.get(panelId) !== terminal || terminal.destroying) {
        return;
      }

      this.writeInitialInput(panelId, delivery.input, delivery.submitStrategy);
    }).catch((error) => {
      if (this.terminals.get(panelId) !== terminal || terminal.destroying) return;
      console.warn(`[TerminalPanelManager] Failed to send initial input for panel ${panelId}:`, error);
      this.markInitialInputError(panelId, error instanceof Error ? error.message : String(error)).catch(() => {});
    });
  }

  deliverPendingInitialInput(panelId: string): void {
    if (!this.terminals.has(panelId)) {
      return;
    }
    const currentPanel = panelManager.getPanel(panelId);
    if (!currentPanel) return;
    const customState = terminalCustomState(currentPanel.state);
    if (customState.isCliReady !== true) {
      return;
    }

    this.holdInitialInput(panelId);
  }

  /** Queue typed initial input for the status poll to send once the agent can take it. */
  private holdInitialInput(panelId: string): void {
    const terminal = this.terminals.get(panelId);
    if (terminal) terminal.initialInputHeld = true;
  }

  /**
   * Send held initial input once a known agent's status is idle (ready at its
   * composer), so it never lands in a trust or permission menu or a startup
   * frame. Other CLIs take it as soon as they are not blocked.
   */
  private releaseHeldInitialInput(terminal: TerminalProcess, manifestId: string): void {
    if (!terminal.initialInputHeld) return;
    const status = this.agentStatusMonitor.getState(terminal.panelId);
    if (status === 'blocked' || (manifestId !== 'generic' && status !== 'idle')) return;
    terminal.initialInputHeld = false;
    this.sendInitialInputOnce(terminal.panelId);
  }

  private writeInitialInput(
    panelId: string,
    input: string,
    submitStrategy: NonNullable<TerminalPanelState['initialInputSubmitStrategy']>,
  ): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal || terminal.destroying) return;
    if (submitStrategy === 'codex-ctrl-enter') {
      this.writeToTerminal(panelId, input);
      setTimeout(() => {
        if (this.terminals.get(panelId) !== terminal || terminal.destroying) return;
        this.writeToTerminal(panelId, '\x1b[13;5u\r');
      }, 500);
      return;
    }

    this.writeToTerminal(panelId, input.endsWith('\r') ? input : `${input}\r`);
  }

  private stripAnsiSequences(output: string): string {
    // oxlint-disable-next-line eslint/no-control-regex
    return output.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');
  }

  private extractCodexResumeId(output: string): string | undefined {
    const clean = this.stripAnsiSequences(output);
    const match = clean.match(/\bcodex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    return match?.[1];
  }

  private scheduleAfterShellPrompt(ptyProcess: pty.IPty, callback: () => void): void {
    let callbackInvoked = false;
    // Match prompt symbol allowing trailing ANSI escapes and whitespace.
    // oxlint-disable-next-line eslint/no-control-regex
    const promptPattern = /[$#%>]\s*(?:\x1b\[[0-9;]*[a-zA-Z])*\s*$/;

    const invokeOnce = () => {
      if (callbackInvoked) return;
      callbackInvoked = true;
      onPromptReady.dispose();
      callback();
    };

    const onPromptReady = ptyProcess.onData((data: string) => {
      if (callbackInvoked) return;
      const lastLine = data.split(/\r?\n/).filter(line => line.length > 0).pop() || '';
      // oxlint-disable-next-line eslint/no-control-regex
      const cleanLine = lastLine.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (promptPattern.test(cleanLine)) {
        setTimeout(invokeOnce, SHELL_PROMPT_SETTLE_MS);
      }
    });

    setTimeout(invokeOnce, SHELL_PROMPT_FALLBACK_MS);
  }

  private extractAgentSessionId(agentType: CliAgentType | undefined, output: string): string | undefined {
    if (agentType === 'codex') return this.extractCodexResumeId(output);
    if (agentType === 'cursor') return extractCursorChatId(output);
    return undefined;
  }

  private captureAgentSessionId(terminal: TerminalProcess, output: string): void {
    if (terminal.agentType !== 'codex' && terminal.agentType !== 'cursor') return;

    terminal.agentSessionScrapeBuffer = trimAnsiSafe(
      terminal.agentSessionScrapeBuffer + output,
      2000
    );

    const agentSessionId = this.extractAgentSessionId(terminal.agentType, terminal.agentSessionScrapeBuffer);
    if (!agentSessionId) return;

    const panel = panelManager.getPanel(terminal.panelId);
    if (!panel) return;

    const customState = terminalCustomState(panel.state);
    const agentType = customState.agentType ?? resolveAgentTypeFromCommand(customState.initialCommand);
    if (agentType !== terminal.agentType || customState.agentSessionId === agentSessionId) return;

    terminal.capturedAgentSessionId = agentSessionId;

    panel.state.customState = {
      ...customState,
      agentType,
      agentSessionId
    };

    void panelManager.updatePanel(terminal.panelId, { state: panel.state }).catch(error => {
      console.warn(`[TerminalPanelManager] Failed to persist ${agentType} session id for panel ${terminal.panelId}:`, error);
    });
    console.log(`[TerminalPanelManager] Captured ${agentType} session id for panel ${terminal.panelId}: ${agentSessionId}`);
  }

  setAnalyticsManager(analyticsManager: AnalyticsManager): void {
    this.analyticsManager = analyticsManager;
  }

  private sendRendererEvent(channel: string, ...args: PaneEventArgument[]): void {
    getPaneEventSink().send(channel, ...args);
  }

  private sendDaemonEvent(channel: string, ...args: PaneEventArgument[]): void {
    getPaneDaemonEventSink().send(channel, ...args);
  }

  /**
   * Returns a map of sessionId → array of PTY PIDs for that session.
   * Used by resource monitoring to discover which processes belong to which session.
   */
  getSessionPids(): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const [, terminal] of this.terminals) {
      const pids = result.get(terminal.sessionId) || [];
      pids.push(terminal.pty.pid);
      result.set(terminal.sessionId, pids);
    }
    return result;
  }

  private async acquireSpawnSlot(priority: number = 1): Promise<void> {
    if (this.activeSpawns < MAX_CONCURRENT_SPAWNS) {
      this.activeSpawns++;
      return;
    }
    return new Promise(resolve => {
      this.spawnQueue.push({ resolve, priority });
      this.spawnQueue.sort((a, b) => a.priority - b.priority);
    });
  }

  private releaseSpawnSlot(): void {
    this.activeSpawns--;
    const next = this.spawnQueue.shift();
    if (next) {
      this.activeSpawns++;
      next.resolve();
    }
  }

  private flushOutputBuffer(terminal: TerminalProcess): void {
    if (terminal.outputFlushTimer) {
      clearTimeout(terminal.outputFlushTimer);
      terminal.outputFlushTimer = null;
    }

    if (!terminal.outputBuffer) return;

    const data = terminal.outputBuffer;
    terminal.outputBuffer = '';

    if (!terminal.isVisible) {
      // Hidden terminals run headless: keep PTY output in main scrollback, but
      // avoid waking the renderer/xterm/WebGL for every background token.
      // Daemon subscribers still need the live bytes so non-Electron clients
      // are not starved by one hidden desktop panel.
      this.sendHiddenOutputToDaemon(terminal, data);
      return;
    }

    // Send batched output to the renderer and daemon subscribers. This is the
    // only byte path for every PTY, ptyHost or not.
    this.sendRendererEvent('terminal:output', {
      sessionId: terminal.sessionId,
      panelId: terminal.panelId,
      output: data
    });

    // Update flow-control bookkeeping with the bytes just flushed. The record
    // owns the HIGH/LOW watermark check, the `pauseRpcInFlight` gate, and the
    // 5s safety timer; both the legacy and ptyHost paths go through the same
    // state machine (see `main/src/ptyHost/flowControl.ts`).
    flowControlOnPtyBytes(
      terminal.flowControl,
      data.length,
      () => this.pausePty(terminal),
      () => this.resumePty(terminal),
    );
  }

  private sendHiddenOutputToDaemon(terminal: TerminalProcess, data: string): void {
    this.sendDaemonEvent('terminal:output', {
      sessionId: terminal.sessionId,
      panelId: terminal.panelId,
      output: data,
    });
  }

  private flushPendingHiddenOutputToDaemon(terminal: TerminalProcess): void {
    if (terminal.outputFlushTimer) {
      clearTimeout(terminal.outputFlushTimer);
      terminal.outputFlushTimer = null;
    }

    if (!terminal.outputBuffer) {
      return;
    }

    const data = terminal.outputBuffer;
    terminal.outputBuffer = '';
    this.sendHiddenOutputToDaemon(terminal, data);
  }

  /**
   * Pause the underlying PTY. Under the ptyHost flag, routes the RPC directly
   * through the supervisor; flag-off uses the legacy `pty.IPty.pause()` path.
   *
   * Returns a promise so the flow-control state machine can defer arming its
   * safety timer until the pause RPC actually lands (plan lines 619-624).
   * Legacy path resolves synchronously; ptyHost path resolves when the RPC
   * response returns.
   */
  private pausePty(terminal: TerminalProcess): Promise<void> {
    if (terminal.isPtyHost && terminal.ptyId) {
      const supervisor = getPtyHostRuntime();
      if (supervisor) {
        return supervisor.pause(terminal.ptyId).catch((err) => {
          console.warn('[TerminalPanelManager] ptyHost pause failed', err);
        });
      }
    }
    terminal.pty.pause();
    return Promise.resolve();
  }

  /**
   * Resume the underlying PTY. Mirror of `pausePty` for the resume side.
   */
  private resumePty(terminal: TerminalProcess): void {
    if (terminal.isPtyHost && terminal.ptyId) {
      const supervisor = getPtyHostRuntime();
      if (supervisor) {
        supervisor.resume(terminal.ptyId).catch((err) => {
          console.warn('[TerminalPanelManager] ptyHost resume failed', err);
        });
        return;
      }
    }
    terminal.pty.resume();
  }

  acknowledgeBytes(panelId: string, bytesConsumed: number): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;

    // Delegate to the shared flow-control helper. It decrements `pendingBytes`,
    // clears the safety timer, and invokes the resume callback only when the
    // record is actually paused and bytes drop below `LOW_WATERMARK`.
    flowControlOnAck(terminal.flowControl, bytesConsumed, () => this.resumePty(terminal));
  }

  acknowledgePtyHostBytes(ptyId: string, bytesConsumed: number): void {
    for (const [panelId, terminal] of this.terminals) {
      if (terminal.ptyId === ptyId) {
        this.acknowledgeBytes(panelId, bytesConsumed);
        return;
      }
    }
  }

  setVisibility(panelId: string, isVisible: boolean, viewerId = 'local:legacy'): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;
    const normalizedViewerId = this.normalizeVisibilityViewerId(viewerId);
    let visibleViewers = this.visibleViewersByPanel.get(panelId);

    if (isVisible) {
      if (!visibleViewers) {
        visibleViewers = new Map();
        this.visibleViewersByPanel.set(panelId, visibleViewers);
      }
      visibleViewers.set(normalizedViewerId, Date.now());
    } else if (visibleViewers) {
      visibleViewers.delete(normalizedViewerId);
      if (visibleViewers.size === 0) {
        this.visibleViewersByPanel.delete(panelId);
        visibleViewers = undefined;
      }
    }

    this.applyVisibilityState(terminal, (visibleViewers?.size ?? 0) > 0);
  }

  clearVisibilityViewer(viewerId: string): void {
    this.clearVisibilityViewers((candidate) => candidate === this.normalizeVisibilityViewerId(viewerId));
  }

  clearVisibilityViewersByPrefix(prefix: string): void {
    this.clearVisibilityViewers((candidate) => this.visibilityViewerMatchesPrefix(candidate, prefix));
  }

  pruneVisibilityViewersByPrefix(prefix: string, staleAfterMs: number): void {
    const cutoff = Date.now() - staleAfterMs;
    this.clearVisibilityViewers((candidate, lastSeenAt) => (
      this.visibilityViewerMatchesPrefix(candidate, prefix) && lastSeenAt < cutoff
    ));
  }

  private clearVisibilityViewers(shouldClear: (viewerId: string, lastSeenAt: number) => boolean): void {
    for (const [panelId, visibleViewers] of [...this.visibleViewersByPanel]) {
      let changed = false;
      for (const [viewerId, lastSeenAt] of [...visibleViewers]) {
        if (shouldClear(viewerId, lastSeenAt)) {
          visibleViewers.delete(viewerId);
          changed = true;
        }
      }

      if (!changed) {
        continue;
      }

      if (visibleViewers.size === 0) {
        this.visibleViewersByPanel.delete(panelId);
      }

      const terminal = this.terminals.get(panelId);
      if (terminal) {
        this.applyVisibilityState(terminal, visibleViewers.size > 0);
      }
    }
  }

  private normalizeVisibilityViewerId(viewerId: string): string {
    const trimmed = viewerId.trim();
    return trimmed.length > 0 ? trimmed : 'local:legacy';
  }

  private visibilityViewerMatchesPrefix(viewerId: string, prefix: string): boolean {
    return viewerId === prefix || viewerId.startsWith(`${prefix}:`);
  }

  private applyVisibilityState(terminal: TerminalProcess, isVisible: boolean): void {
    const wasVisible = terminal.isVisible;
    terminal.isVisible = isVisible;
    if (wasVisible === isVisible) return;

    if (!isVisible) {
      // Once hidden, renderer ACKs stop. Do not leave a visible-mode pause
      // pending against bytes the renderer may never acknowledge.
      this.flushPendingHiddenOutputToDaemon(terminal);
      const wasPaused = terminal.flowControl.isPaused;
      disposeFlowControlRecord(terminal.flowControl);
      if (wasPaused) {
        this.resumePty(terminal);
      }
    } else {
      // Hidden output is already present in scrollbackBuffer. Flush any pending
      // daemon-only batch first so remote subscribers do not lose the last
      // hidden chunk during a visibility transition, then let the renderer
      // refresh exactly once from getState.
      this.flushPendingHiddenOutputToDaemon(terminal);
    }
  }

  // Reset flow control state - useful for recovering from stuck terminals
  resetFlowControl(panelId: string): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return;

    console.log(`[TerminalPanelManager] Resetting flow control for panel ${panelId}`);

    const wasPaused = terminal.flowControl.isPaused;
    // Dispose clears timers, paused state, and pending bytes on the record.
    disposeFlowControlRecord(terminal.flowControl);

    // If we interrupted a paused PTY, explicitly resume so bytes flow again.
    if (wasPaused) {
      this.resumePty(terminal);
    }
  }

  async initializeTerminal(panel: ToolPanel, cwd: string, wslContext?: WSLContext | null, priority: number = 1, initialDimensions?: { cols: number; rows: number }): Promise<void> {
    if (this.terminals.has(panel.id)) {
      return;
    }

    // Wait for a spawn slot (caps concurrent PTY spawns to prevent CPU spikes)
    await this.acquireSpawnSlot(priority);

    // Re-check after waiting — another call may have initialized this panel
    if (this.terminals.has(panel.id)) {
      this.releaseSpawnSlot();
      return;
    }

    try {

    let shellPath: string;
    let shellArgs: string[];
    let shellType: string;
    let spawnCwd: string | undefined = cwd;

    if (wslContext && process.platform === 'win32') {
      const wslShell = getWSLShellSpawn(wslContext.distribution, cwd);
      shellPath = wslShell.path;
      shellArgs = wslShell.args;
      shellType = 'bash';
      spawnCwd = undefined; // WSL handles cwd
    } else {
      const preferredShell = getRuntimeConfigManager().getPreferredShell();
      const shellInfo = ShellDetector.getDefaultShell(preferredShell);
      shellPath = shellInfo.path;
      shellArgs = shellInfo.args || [];
      shellType = shellInfo.name;
    }

    const isLinux = process.platform === 'linux';
    const enhancedPath = isLinux ? (process.env.PATH || '') : getShellPath();

    /**
     * PANE_PORT: deterministic port block per session (10 consecutive ports).
     * Avoids port conflicts when running parallel worktree dev servers.
     * Hash the sessionId to a port in the 3000–8990 range (600 blocks of 10).
     * Usage in pane.json: { "scripts": { "run": "PORT=$PANE_PORT pnpm dev" } }
     */
    let portHash = 0;
    for (let i = 0; i < panel.sessionId.length; i++) {
      portHash = ((portHash << 5) - portHash) + panel.sessionId.charCodeAt(i);
      portHash |= 0;
    }
    const panePort = 3000 + (Math.abs(portHash) % 600) * 10;

    /**
     * When spawning into WSL, pty.spawn's `env` sets variables on the wsl.exe
     * Windows process, which does NOT propagate them to the bash shell inside
     * the distro. WSLENV is Microsoft's opt-in mechanism: listing a var name
     * here tells WSL to copy that var's value from the Windows env into the
     * Linux env at shell startup. Without this, GIT_COMMITTER_* (and every
     * PANE_* var) silently disappear inside WSL terminals.
     */
    const isWSL = !!wslContext && process.platform === 'win32';
    const panelCustomState = terminalCustomState(panel.state);
    const wslEnvVars: Record<string, string> = isWSL
      ? {
          WSLENV: buildWSLENV([
            'GIT_COMMITTER_NAME',
            'GIT_COMMITTER_EMAIL',
            'PANE_PORT',
            'PANE_SESSION_ID',
            'PANE_PANEL_ID',
            'PANE_ORCHESTRATION_SESSION_ID',
            'WORKTREE_PATH',
            'PANE_WORKSPACE_PATH',
          ]),
        }
      : {};

    // Build spawn env once so legacy and ptyHost paths receive identical values.
    const spawnCols = initialDimensions?.cols || 80;
    const spawnRows = initialDimensions?.rows || 30;

    // The ptyHost RPC DTO requires `Record<string, string>`, so both the legacy
    // `pty.spawn` path and the ptyHost path get the same undefined-free shape.
    const baseSpawnEnv = {
      ...inheritedProcessEnv(),
      ...getGitAttributionEnv(getRuntimeConfigManager().getConfig()),
      PATH: enhancedPath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      WORKTREE_PATH: cwd,
      PANE_SESSION_ID: panel.sessionId,
      PANE_PANEL_ID: panel.id,
      PANE_PORT: String(panePort),
      PANE_WORKSPACE_PATH: cwd,
      ...wslEnvVars,
    } satisfies Record<string, string>;
    const spawnEnv = panelCustomState.orchestrationSessionId
      ? { ...baseSpawnEnv, PANE_ORCHESTRATION_SESSION_ID: panelCustomState.orchestrationSessionId }
      : baseSpawnEnv;

    // Read the setting once per spawn so we don't scatter config reads.
    // `getPtyHostRuntime()` returns null when the setting is off or when
    // supervisor startup failed; in either case we transparently fall back to
    // the legacy `pty.spawn` path.
    const runtimeConfigManager = getRuntimeConfigManager();
    const useFlag = runtimeConfigManager.getUsePtyHost();
    let supervisor: PtyHostRuntime | null = null;
    if (useFlag) {
      supervisor = getPtyHostRuntime();
      if (!supervisor) {
        console.warn('[ptyHost] supervisor unavailable, falling back to legacy pty.spawn');
      }
    }
    const usePtyHost = !!supervisor;

    let ptyProcess: pty.IPty;
    let ptyHostId: string | undefined;

    if (usePtyHost && supervisor) {
      // Flag-on path: spawn via ptyHost UtilityProcess. Critical invariant:
      // `this.terminals.set(...)` happens only AFTER the spawn response lands
      // so synchronous `.pid` readers (getSessionPids, killProcessTree) never
      // observe a pid-less handle.
      const spawned = await supervisor.spawn({
        shell: shellPath,
        args: shellArgs,
        cwd: spawnCwd,
        cols: spawnCols,
        rows: spawnRows,
        env: spawnEnv,
        name: 'xterm-256color',
      });
      const handle = supervisor.getHandle(spawned.ptyId);
      if (!handle) {
        throw new Error(`[ptyHost] supervisor returned ptyId=${spawned.ptyId} but getHandle() was undefined`);
      }
      ptyProcess = new PtyHandleShim(handle, spawnCols, spawnRows);
      ptyHostId = spawned.ptyId;
    } else {
      // Flag-off path: legacy direct pty.spawn. Unchanged behavior.
      ptyProcess = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: spawnCols,
        rows: spawnRows,
        cwd: spawnCwd,
        env: spawnEnv,
      });
    }

    // Another initialization can finish while the ptyHost spawn is awaited.
    if (this.terminals.has(panel.id)) {
      ptyProcess.kill();
      return;
    }

    // Create terminal process object
    const terminalProcess: TerminalProcess = {
      pty: ptyProcess,
      ptyId: ptyHostId,
      isPtyHost: usePtyHost,
      panelId: panel.id,
      sessionId: panel.sessionId,
      scrollbackBuffer: '',
      alternateScreenBuffer: '',
      screenEmulator: this.emulatorHost().createEmulator(spawnCols, spawnRows),
      commandHistory: [],
      currentCommand: '',
      lastActivity: new Date(),
      outputGeneration: 0,
      isWSL: !!(wslContext && process.platform === 'win32'),
      // Capture wslContext so `respawnAll` can re-inject the same WSLENV /
      // distro / user settings after a ptyHost supervisor restart without
      // having to reconstruct it from project state.
      wslContext: wslContext ?? null,
      flowControl: createFlowControlRecord(),
      outputBuffer: '',
      outputFlushTimer: null,
      isVisible: true,
      isAlternateScreen: false,
      inSyncBlock: false,
      filterInAltScreen: false,
      agentType: this.resolveTerminalAgentType(terminalCustomState(panel.state)),
      agentSessionScrapeBuffer: ''
    };

    // Store in map (ptyHost path: pid is already populated on the shim).
    this.terminals.set(panel.id, terminalProcess);

    // Install lifetime guards before any launch-state persistence can yield.
    this.setupTerminalHandlers(terminalProcess);

    // Begin at-a-glance status detection for AI/CLI agent panels.
    this.registerAgentStatusPanel(terminalProcess);

    // Tell the renderer which `ptyId` backs this panel so `TerminalPanel.tsx`
    // can ack flow-control bytes over the ptyHost port. Flag-off path skips
    // this: the renderer acks over IPC.
    if (usePtyHost && ptyHostId) {
      this.sendRendererEvent('terminal:ptyReady', {
        sessionId: panel.sessionId,
        panelId: panel.id,
        ptyId: ptyHostId,
      });
    }
    
    // Get initialCommand from existing state before updating
    const existingState = terminalCustomState(panel.state);
    const initialCommand = existingState?.initialCommand;
    const initialInput = existingState?.initialInput;

    // Wait for the shell prompt before sending an initial command.
    let commandToRun: string | undefined;
    if (initialCommand) {
      const launchResolution = this.resolveCliLaunchCommand(panel.id, initialCommand, existingState || {}, shellType);
      commandToRun = launchResolution.commandToRun;
      const isCliCommand = launchResolution.isCliCommand;

      if (isCliCommand) {
        panel.state.customState = launchResolution.customState;
        await panelManager.updatePanel(panel.id, { state: panel.state }).catch(error => {
          console.warn(`[TerminalPanelManager] Failed to persist CLI launch state for panel ${panel.id}:`, error);
        });
      }

      if (this.terminals.get(panel.id) !== terminalProcess || terminalProcess.destroying) return;

      // Detect the interactive prompt before injecting the command.
      // Previous approaches (fixed 500ms delay, then fire-on-any-data + 300ms) failed
      // because shell init output (MINGW banner, .bashrc) fires before the prompt is ready.
      // We check only the LAST line of the latest data chunk for a prompt pattern,
      // so banner lines ending with % or > don't trigger a false positive.
      const panelId = panel.id;
      const injectCommand = () => {
        if (this.terminals.get(panelId) !== terminalProcess || terminalProcess.destroying) return;
        this.writeToTerminal(panelId, commandToRun! + '\r');

        // For CLI tool terminals, signal the frontend when the CLI responds
        if (isCliCommand) {
          let cliReadySignaled = false;
          // Declare before signalCliReady so the closure can reference it
          let onCliOutput: ReturnType<typeof ptyProcess.onData> | null = null;

          const signalCliReady = () => {
            if (cliReadySignaled || this.terminals.get(panelId) !== terminalProcess || terminalProcess.destroying) return;
            cliReadySignaled = true;
            if (onCliOutput) onCliOutput.dispose();

            // Persist isCliReady on panel state (best-effort, fire-and-forget)
            const currentPanel = panelManager.getPanel(panelId);
            if (currentPanel) {
              const ps = currentPanel.state;
              const cs2 = terminalCustomState(ps);
              cs2.isCliReady = true;
              ps.customState = cs2;
              panelManager.updatePanel(panelId, { state: ps }); // async, not awaited
            }

            // Emit to renderer
            this.sendRendererEvent('terminal:cliReady', { panelId });
            this.holdInitialInput(panelId);
          };

          // Listen for CLI output after command injection. Cursor launches are
          // preceded by the create-chat compound's shell traffic, so ready is
          // gated on the TUI's own first render signal; other agents keep the
          // first-byte trigger. Either way, fire a single delayed signal.
          const cursorReady = launchResolution.customState.agentType === 'cursor'
            ? createCursorReadyDetector()
            : null;
          onCliOutput = ptyProcess.onData((chunk: string) => {
            if (cursorReady && !cursorReady(chunk)) return;
            if (onCliOutput) onCliOutput.dispose();
            onCliOutput = null;
            // Small delay to let the CLI render its first frame
            setTimeout(signalCliReady, 300);
          });

          // Safety timeout: dismiss after 10s regardless
          setTimeout(signalCliReady, 10000);
        } else if (initialInput) {
          setTimeout(() => {
            if (this.terminals.get(panelId) === terminalProcess && !terminalProcess.destroying) this.sendInitialInputOnce(panelId);
          }, 1000);
        }
      };

      this.scheduleAfterShellPrompt(ptyProcess, injectCommand);
    } else if (initialInput) {
      setTimeout(() => {
        if (this.terminals.get(panel.id) === terminalProcess && !terminalProcess.destroying) this.sendInitialInputOnce(panel.id);
      }, 1000);
    }

    // Update panel state
    const state = panel.state;
    state.customState = {
      ...state.customState,
      isInitialized: true,
      cwd: cwd,
      shellType: path.basename(shellPath),
      dimensions: { cols: initialDimensions?.cols || 80, rows: initialDimensions?.rows || 30 }
    };

    await panelManager.updatePanel(panel.id, { state });

    } finally {
      this.releaseSpawnSlot();
    }
  }

  /** See syncBlockClearFilter.ts — state lives on the terminal object. */
  private filterSyncBlockClears(terminal: TerminalProcess, data: string): string {
    return filterSyncBlockClears(terminal, data);
  }

  private setupTerminalHandlers(terminal: TerminalProcess): void {
    // Handle terminal output
    terminal.pty.onData((data: string) => {
      if (this.terminals.get(terminal.panelId) !== terminal || terminal.destroying) return;
      // Update last activity
      const outputAt = new Date();
      terminal.lastActivity = outputAt;
      terminal.lastOutputAt = outputAt;
      terminal.outputGeneration += 1;

      // Feed PTY activity to the agent-status monitor (the "working" authority).
      this.agentStatusMonitor.noteActivity(terminal.panelId, outputAt.getTime());

      // Detect alternate screen buffer enter/exit for universal TUI detection
      // (works on WSL where pty.process reports wsl.exe instead of the Linux foreground app)
      // \x1b[?1049h = enter alternate screen, \x1b[?1049l = leave alternate screen
      const enterAlt = data.includes('\x1b[?1049h');
      const leaveAlt = data.includes('\x1b[?1049l');
      if (enterAlt || leaveAlt) {
        // If both appear in the same chunk, last one wins
        const lastEnter = data.lastIndexOf('\x1b[?1049h');
        const lastLeave = data.lastIndexOf('\x1b[?1049l');
        const newState = lastEnter > lastLeave;
        if (newState !== terminal.isAlternateScreen) {
          terminal.isAlternateScreen = newState;
          this.sendRendererEvent('terminal:alternateScreen', {
            panelId: terminal.panelId,
            active: newState
          });
        }
      }

      // Strip \x1b[2J inside DEC 2026 sync blocks before xterm.js sees the data
      const filtered = this.filterSyncBlockClears(terminal, data);
      this.captureAgentSessionId(terminal, filtered);
      terminal.screenEmulator?.write(filtered);

      // Keep TUI redraw traffic separate from durable shell scrollback. Full-screen
      // apps emit high-volume cursor/clear sequences that are useful only as a
      // recent visual frame and should not evict normal history.
      this.addToScrollback(terminal, filtered);

      // Detect commands (simple heuristic - look for carriage returns)
      if (data.includes('\r') || data.includes('\n')) {
        if (terminal.currentCommand.trim()) {
          terminal.commandHistory.push(terminal.currentCommand.slice(0, MAX_COMMAND_HISTORY_ENTRY_SIZE));
          if (terminal.commandHistory.length > MAX_COMMAND_HISTORY_ENTRIES) {
            terminal.commandHistory.splice(0, terminal.commandHistory.length - MAX_COMMAND_HISTORY_ENTRIES);
          }

          // Emit command executed event
          panelManager.emitPanelEvent(
            terminal.panelId,
            'terminal:command_executed',
            {
              command: terminal.currentCommand,
              timestamp: new Date().toISOString()
            }
          );

          // Check for file operation commands
          if (this.isFileOperationCommand(terminal.currentCommand)) {
            panelManager.emitPanelEvent(
              terminal.panelId,
              'files:changed',
              {
                command: terminal.currentCommand,
                timestamp: new Date().toISOString()
              }
            );
          }

          terminal.currentCommand = '';
        }
      } else if (!terminal.isAlternateScreen) {
        // Accumulate command input. Anything past the cap is not a command
        // (a TUI frame, a paste, a progress bar), so drop it rather than grow.
        terminal.currentCommand += data;
        if (terminal.currentCommand.length > MAX_CURRENT_COMMAND_SIZE) {
          terminal.currentCommand = '';
        }
      }

      // Buffer output for batching instead of sending immediately
      terminal.outputBuffer += filtered;

      // Hidden panels cap per-flush size below HIGH_WATERMARK so a single
      // flush on a verbose background build can't alone trip backpressure.
      const sizeThreshold = terminal.isVisible ? OUTPUT_BATCH_SIZE : OUTPUT_BATCH_SIZE_HIDDEN;
      if (terminal.outputBuffer.length >= sizeThreshold) {
        // Buffer is large enough — flush immediately
        this.flushOutputBuffer(terminal);
      } else if (!terminal.outputFlushTimer) {
        // Schedule flush for next frame. Hidden panels use a slower cadence
        // to cut main-process IPC wake-ups; foreground panels keep 32 ms.
        const interval = terminal.isVisible
          ? OUTPUT_BATCH_INTERVAL
          : OUTPUT_BATCH_INTERVAL_HIDDEN;
        terminal.outputFlushTimer = setTimeout(() => {
          this.flushOutputBuffer(terminal);
        }, interval);
      }
    });
    
    // Handle terminal exit
    terminal.pty.onExit((exitCode: { exitCode: number; signal?: number }) => {
      if (this.terminals.get(terminal.panelId) !== terminal) return;
      if (terminal.destroying) {
        // The save still owns the emulator; retain exit details until it drains.
        terminal.exitDuringDestroy ??= exitCode;
        return;
      }
      try {
        this.retireTerminal(terminal, exitCode);
      } finally {
        terminal.screenEmulator?.dispose();
      }

      // Notify frontend (include signal for crash detection)
      this.sendRendererEvent('terminal:exited', {
        sessionId: terminal.sessionId,
        panelId: terminal.panelId,
        exitCode: exitCode.exitCode,
        signal: exitCode.signal ?? null
      });
    });
  }
  
  private addToScrollback(terminal: TerminalProcess, data: string): void {
    if (terminal.isAlternateScreen) {
      terminal.alternateScreenBuffer = trimAnsiSafe(
        terminal.alternateScreenBuffer + data,
        MAX_ALTERNATE_SCREEN_BUFFER_SIZE
      );
      return;
    }

    terminal.scrollbackBuffer = trimAnsiSafe(
      terminal.scrollbackBuffer + data,
      MAX_SCROLLBACK_BUFFER_SIZE
    );
  }
  
  private isFileOperationCommand(command: string): boolean {
    const fileOperations = [
      'touch', 'rm', 'mv', 'cp', 'mkdir', 'rmdir',
      'cat >', 'echo >', 'echo >>', 'vim', 'vi', 'nano', 'emacs',
      'git add', 'git rm', 'git mv'
    ];
    
    const trimmedCommand = command.trim().toLowerCase();
    return fileOperations.some(op => trimmedCommand.startsWith(op));
  }
  
  isTerminalInitialized(panelId: string): boolean {
    return this.terminals.has(panelId);
  }

  getLastOutputAt(panelId: string): string | undefined {
    return this.terminals.get(panelId)?.lastOutputAt?.toISOString();
  }

  /** Viewport text with dim cells blanked, so placeholder hints do not read as typed input. */
  getInputScreenText(panelId: string): string | undefined {
    return this.terminals.get(panelId)?.screenEmulator?.state.inputScreenText;
  }

  getOutputGeneration(panelId: string): number {
    return this.terminals.get(panelId)?.outputGeneration ?? 0;
  }
  
  writeToTerminal(panelId: string, data: string): void {
    const terminal = this.terminals.get(panelId);
    if (!terminal) {
      console.warn(`[TerminalPanelManager] Terminal ${panelId} not found`);
      return;
    }

    if (terminal.destroying) return;
    try {
      terminal.pty.write(data);
    } catch (err) {
      // A write failure alone does not prove process death; onExit owns cleanup.
      console.warn(`[TerminalPanelManager] Failed to write to terminal ${panelId}:`, err);
      return;
    }
    terminal.lastActivity = new Date();
  }
  
  async resizeTerminal(
    panelId: string,
    cols: number,
    rows: number,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const terminal = this.terminals.get(panelId);
    if (terminal?.destroying) return;
    if (!terminal) {
      console.warn(`[TerminalPanelManager] Terminal ${panelId} not found for resize`);
      return;
    }

    // Reject non-integers (NaN/Infinity/floats) and mid-layout garbage
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < MIN_PTY_COLS ||
      rows < MIN_PTY_ROWS
    ) {
      console.warn(`[TerminalPanelManager] Rejecting invalid resize ${cols}x${rows} for ${panelId}`);
      return;
    }

    const isSameSize = terminal.pty.cols === cols && terminal.pty.rows === rows;
    // Normal layout traffic stays deduplicated. A forced redraw must make the
    // kernel observe an actual size transition; repeating TIOCSWINSZ with the
    // same dimensions is not guaranteed to signal the foreground process group.
    if (!options.force && isSameSize) {
      return;
    }

    try {
      if (options.force && isSameSize) {
        // Single repaint nudge: toggle ROWS (not cols) so the normal buffer never
        // reflows, and keep the headless emulator in step so the intermediate
        // frame is parsed at the geometry it was drawn for.
        const redrawRows = rows > MIN_PTY_ROWS ? rows - 1 : rows + 1;
        terminal.pty.resize(cols, redrawRows);
        terminal.screenEmulator?.resize(cols, redrawRows);
        // Give the foreground process time to observe the intermediate grid.
        // Back-to-back TIOCSWINSZ calls can collapse into a single pending signal.
        await new Promise(resolve => setTimeout(resolve, FORCED_REDRAW_TRANSITION_MS));
      }
      if (this.terminals.get(panelId) !== terminal || terminal.destroying) return;
      terminal.pty.resize(cols, rows);
      terminal.screenEmulator?.resize(cols, rows);
      if (options.force) {
        // Let the final application redraw reach our output batch before the
        // renderer removes its activation mask.
        await new Promise(resolve => setTimeout(resolve, FORCED_REDRAW_SETTLE_MS));
        if (this.terminals.get(panelId) !== terminal || terminal.destroying) return;
        this.flushOutputBuffer(terminal);
      }
    } catch (err) {
      // A resize failure does not mean the pty died; onExit owns cleanup
      console.warn(`[TerminalPanelManager] Failed to resize terminal ${panelId}:`, err);
      return;
    }

    // Update panel state with new dimensions
    const panel = panelManager.getPanel(panelId);
    if (panel) {
      const state = panel.state;
      state.customState = {
        ...state.customState,
        dimensions: { cols, rows }
      };
      panelManager.updatePanel(panelId, { state });
    }
  }
  
  async saveTerminalState(panelId: string): Promise<void> {
    const terminal = this.terminals.get(panelId);
    if (!terminal) {
      console.warn(`[TerminalPanelManager] Terminal ${panelId} not found for state save`);
      return;
    }
    
    const panel = panelManager.getPanel(panelId);
    if (!panel) return;

    // Get current working directory (if possible)
    let cwd = (panel.state.customState && 'cwd' in panel.state.customState) ? panel.state.customState.cwd : undefined;
    cwd = cwd || process.cwd();
    try {
      // Try to get CWD from process (platform-specific)
      if (process.platform !== 'win32') {
        const pid = terminal.pty.pid;
        if (pid) {
          // This is a simplified approach - in production you might use platform-specific methods
          cwd = await this.getProcessCwd(pid);
        }
      }
    } catch (error) {
      console.warn(`[TerminalPanelManager] Could not get CWD for terminal ${panelId}:`, error);
    }
    
    if (this.terminals.get(panelId) !== terminal || panelManager.getPanel(panelId) !== panel) return;
    await this.persistTerminalState(terminal, panel, cwd);
  }

  private async persistTerminalState(terminal: TerminalProcess, panel: ToolPanel, cwd: string): Promise<void> {
    const panelId = terminal.panelId;
    const restore = await terminal.screenEmulator?.restoreSnapshot();
    // The worker read can finish after this terminal or panel was replaced.
    if (this.terminals.get(panelId) !== terminal || panelManager.getPanel(panelId) !== panel) return;
    const state = panel.state;
    const savedIsAlternateScreen = restore?.isAlternateScreen ?? terminal.isAlternateScreen;
    // Same source as getTerminalState: persist the rendered emulator model for
    // normal buffers so restarts replay a duplicate-free snapshot, not the raw
    // append log with its accumulated repaint traffic.
    const savedScrollback =
      restore && !savedIsAlternateScreen
        ? trimAnsiSafe(restore.serialized, MAX_RESTORE_PAYLOAD_SIZE)
        : terminal.scrollbackBuffer;
    const customState: TerminalPanelState = {
      ...terminalCustomState(state),
      isInitialized: true,
      cwd: cwd,
      scrollbackBuffer: savedScrollback,
      alternateScreenBuffer: terminal.alternateScreenBuffer,
      isAlternateScreen: savedIsAlternateScreen,
      lastActivityTime: terminal.lastActivity.toISOString(),
      serializedBuffer: restore?.isAlternateScreen
        ? restore.serialized
        : this.serializedBuffers.get(panelId),
    };
    if (terminal.capturedAgentSessionId && terminal.agentType) {
      customState.agentType = terminal.agentType;
      customState.agentSessionId = terminal.capturedAgentSessionId;
    }
    state.customState = customState;
    
    await panelManager.updatePanel(panelId, { state });
    
  }
  
  private async getProcessCwd(pid: number): Promise<string> {
    // This is platform-specific and simplified
    // In production, you'd use more robust methods
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        const cwdLink = `/proc/${pid}/cwd`;
        return await fs.readlink(cwdLink);
      } catch {
        return process.cwd();
      }
    }
    return process.cwd();
  }
  
  async restoreTerminalState(panel: ToolPanel, state: TerminalPanelState, wslContext?: WSLContext | null): Promise<void> {
    // Terminal bytes live in panel_buffers, never in the panel state JSON.
    const buffers = databaseService.getPanelBuffers(panel.id);
    const scrollback = buffers?.scrollback ?? '';
    if (scrollback.length === 0) {
      return;
    }

    // Initialize terminal first
    await this.initializeTerminal(panel, state.cwd || process.cwd(), wslContext);
    
    const terminal = this.terminals.get(panel.id);
    if (!terminal) return;
    
    terminal.scrollbackBuffer = scrollback;
    terminal.alternateScreenBuffer = buffers?.alternate ?? '';
    
    // Send restoration indicator to terminal
    const restorationMsg = `\r\n[Session Restored from ${state.lastActivityTime || 'previous session'}]\r\n`;
    terminal.pty.write(restorationMsg);
    
    // Send scrollback to frontend. Cap the renderer replay at the formal
    // ceiling; main's own buffer (set above) keeps full content.
    const output = trimAnsiSafe(scrollback, MAX_RESTORE_PAYLOAD_SIZE) + restorationMsg;
    this.sendRendererEvent('terminal:output', {
      sessionId: panel.sessionId,
      panelId: panel.id,
      output,
    });
  }
  
  async getTerminalState(panelId: string): Promise<TerminalPanelState | null> {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return null;

    const restore = await terminal.screenEmulator?.restoreSnapshot();
    if (this.terminals.get(panelId) !== terminal) return null;

    const isAlternateScreen = restore?.isAlternateScreen ?? terminal.isAlternateScreen;
    // Normal-buffer restore content comes from the rendered emulator model, not
    // the raw append log: the log accumulates repaint traffic (forced activation
    // redraws re-emit the current frame), which a reset+replay renders as
    // duplicated rows. The emulator consumed those bytes like a live terminal —
    // repaints overwrite in place — so its serialization is duplicate-free.
    const cappedScrollback = trimAnsiSafe(
      restore && !isAlternateScreen ? restore.serialized : terminal.scrollbackBuffer,
      MAX_RESTORE_PAYLOAD_SIZE,
    );
    return {
      isInitialized: true,
      cwd: process.cwd(), // Simplified - would need platform-specific implementation
      shellType: process.env.SHELL || 'bash',
      scrollbackBuffer: cappedScrollback,
      alternateScreenBuffer: terminal.alternateScreenBuffer,
      isAlternateScreen,
      lastActivityTime: terminal.lastActivity.toISOString(),
      // An active alternate screen cannot be reconstructed from normal shell
      // scrollback. Serialize the authoritative live model for renderer remounts.
      serializedBuffer: isAlternateScreen
        ? restore?.serialized
        : cappedScrollback.length > 0
          ? undefined
          : this.serializedBuffers.get(panelId)
    };
  }

  async waitForTerminalState(panelId: string): Promise<void> {
    await this.terminals.get(panelId)?.screenEmulator?.refresh();
  }

  getTerminalSnapshot(panelId: string): TerminalPanelSnapshot | null {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return null;

    const panel = panelManager.getPanel(panelId);
    const customState = panel ? terminalCustomState(panel.state) : {};
    const agentType = customState.agentType ?? resolveAgentTypeFromCommand(customState.initialCommand);

    return {
      initialized: true,
      scrollbackBuffer: terminal.scrollbackBuffer,
      alternateScreenBuffer: terminal.alternateScreenBuffer,
      screenText: terminal.screenEmulator?.state.screenText,
      isAlternateScreen: terminal.screenEmulator?.state.isAlternateScreen ?? terminal.isAlternateScreen,
      activityStatus: this.deriveActivityStatus(panelId),
      lastActivityTime: terminal.lastActivity.toISOString(),
      currentCommand: terminal.currentCommand,
      isCliPanel: customState.isCliPanel,
      isCliReady: customState.isCliReady,
      agentType,
      agentSessionId: customState.agentSessionId ?? terminal.capturedAgentSessionId,
    };
  }

  async clearTerminalScrollback(panelId: string): Promise<void> {
    const terminal = this.terminals.get(panelId);
    if (terminal) {
      terminal.scrollbackBuffer = '';
      terminal.screenEmulator?.clearScrollback();
    }
    this.serializedBuffers.delete(panelId);

    const panel = panelManager.getPanel(panelId);
    if (!panel) return;

    const state = panel.state;
    state.customState = {
      ...(state.customState ?? {}),
      scrollbackBuffer: '',
      serializedBuffer: undefined,
    };

    await panelManager.updatePanel(panelId, { state });
  }
  
  private deriveActivityStatus(panelId: string): 'active' | 'idle' {
    const state = this.agentStatusMonitor.getState(panelId);
    return state === 'working' || state === 'blocked' ? 'active' : 'idle';
  }

  getAgentStatus(panelId: string): AgentState | undefined {
    return this.agentStatusMonitor.getState(panelId);
  }

  private emitActivityStatus(terminal: TerminalProcess): void {
    this.sendRendererEvent('panel:activityStatus', {
      panelId: terminal.panelId,
      sessionId: terminal.sessionId,
      status: this.deriveActivityStatus(terminal.panelId),
      lastActivityAt: terminal.lastActivity.toISOString()
    });
  }

  // ---- At-a-glance agent status (blocked / working / done) ----------------

  /** Resolve the CLI agent driving a panel from its custom state / command. */
  private resolveTerminalAgentType(
    customState: TerminalPanelState | undefined,
  ): CliAgentType | undefined {
    return customState?.agentType ?? resolveAgentTypeFromCommand(customState?.initialCommand);
  }

  /**
   * Start status detection for a terminal panel. Every panel is tracked: known
   * agents get their bespoke manifest, everything else (other CLI agents, plain
   * shells) gets the generic one, so one status system covers all terminals.
   */
  private registerAgentStatusPanel(terminal: TerminalProcess): void {
    this.agentStatusMonitor.register(terminal.panelId, Date.now());
    this.emitAgentStatus(terminal, 'unknown', 'terminal_start');
    this.ensureAgentStatusPoll();
  }

  private emitAgentStatus(terminal: TerminalProcess, state: AgentState, reason: string | null): void {
    const payload: PanelAgentStatusEvent = {
      panelId: terminal.panelId,
      sessionId: terminal.sessionId,
      state,
      reason,
    };
    this.sendRendererEvent('panel:agentStatus', payload);
    this.emit('agent-status', payload);
    this.emitActivityStatus(terminal);
  }

  private ensureAgentStatusPoll(): void {
    if (this.agentStatusPollTimer) return;
    this.agentStatusPollTimer = setInterval(() => {
      this.pollAgentStatus();
    }, AGENT_STATUS_POLL_MS);
  }

  private maybeStopAgentStatusPoll(): void {
    if (this.agentStatusPollTimer && this.agentStatusMonitor.size === 0) {
      clearInterval(this.agentStatusPollTimer);
      this.agentStatusPollTimer = null;
    }
  }

  /**
   * Re-derive blocked/working/done for every tracked agent panel from its live
   * screen + OSC title, and emit `panel:agentStatus` on any change. Runs on a
   * short interval.
   */
  private pollAgentStatus(): void {
    try {
      for (const terminal of this.terminals.values()) {
        if (terminal.destroying || !this.agentStatusMonitor.isTracked(terminal.panelId)) continue;
        const manifest = getManifestForAgent(terminal.agentType);
        const emulator = terminal.screenEmulator;
        if (!emulator) continue;

        // The pushed screen is at most ~50 ms old, well inside this poll's cadence.
        // The emulator only pushes a new object when the screen changed, so an
        // idle panel reuses its last detection instead of rescanning.
        const screen = emulator.state;
        let detection = terminal.lastStatusScan?.screen === screen ? terminal.lastStatusScan.detection : null;
        if (!detection) {
          detection = detectAgentState(manifest, {
            screen: screen.screenText,
            oscTitle: screen.oscTitle,
            oscProgress: screen.oscProgress,
          });
          terminal.lastStatusScan = { screen, detection };
        }
        const next = this.agentStatusMonitor.update(terminal.panelId, detection, Date.now());
        if (next) this.emitAgentStatus(terminal, next, detection.matchedRuleId);
        this.releaseHeldInitialInput(terminal, manifest.id);
      }
    } catch (error) {
      console.error('[TerminalPanelManager] agent status poll failed:', error);
    }
  }

  destroyTerminal(panelId: string, options: { saveState?: boolean } = {}): Promise<void> {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return Promise.resolve();
    terminal.destroying ??= this.finishDestroyTerminal(terminal, options.saveState !== false);
    return terminal.destroying;
  }

  private async finishDestroyTerminal(terminal: TerminalProcess, saveState: boolean): Promise<void> {
    const panelId = terminal.panelId;
    // Stop detection as soon as teardown begins, so output during the save
    // cannot announce completion. Keep the emulator alive through any snapshot save.
    this.agentStatusMonitor.unregister(panelId);
    this.maybeStopAgentStatusPoll();
    try {
      if (saveState) await this.saveTerminalState(panelId);
    } catch (error) {
      console.error(`[TerminalPanelManager] Failed to save state for ${panelId}:`, error);
    }
    if (this.terminals.get(panelId) !== terminal) return;

    try {
      this.retireTerminal(terminal, terminal.exitDuringDestroy);
    } finally {
      // Event subscribers can throw; cleanup must still reclaim this lifetime.
      try {
        terminal.screenEmulator?.dispose();
      } catch (error) {
        console.warn(`[TerminalPanelManager] Emulator dispose failed for ${panelId}:`, error);
      }
      if (!terminal.exitDuringDestroy) {
        try {
          if (terminal.isWSL) {
            try {
              terminal.pty.write('exit\r');
            } finally {
              // Reclaim the PTY even if the graceful exit write failed.
              setTimeout(() => {
                try { terminal.pty.kill(); } catch { /* already exited */ }
              }, 500);
            }
          } else {
            terminal.pty.kill();
          }
        } catch (error) {
          console.error(`[TerminalPanelManager] Error killing terminal ${panelId}:`, error);
        }
      }
    }
  }

  /** Retire exactly one terminal lifetime, before kill can call back synchronously. */
  private retireTerminal(terminal: TerminalProcess, exit?: { exitCode: number; signal?: number }): void {
    const panelId = terminal.panelId;
    if (this.terminals.get(panelId) !== terminal) return;
    if (terminal.outputFlushTimer) {
      clearTimeout(terminal.outputFlushTimer);
      terminal.outputFlushTimer = null;
    }
    try {
      this.flushOutputBuffer(terminal);
    } finally {
      disposeFlowControlRecord(terminal.flowControl);
      this.agentStatusMonitor.unregister(panelId);
      this.terminals.delete(panelId);
      this.visibleViewersByPanel.delete(panelId);
      this.serializedBuffers.delete(panelId);
      this.maybeStopAgentStatusPoll();
    }
    this.emitAgentStatus(terminal, 'idle', exit ? 'exit' : 'destroyed');

    const data = { ...exit, timestamp: new Date().toISOString() };
    if (panelManager.getPanel(panelId)) {
      void panelManager.emitPanelEvent(panelId, 'terminal:exit', data);
    } else {
      // The panel may already be deleted. Its terminal still owns enough
      // identity to notify the journal and transport consumers of the exit.
      this.sendRendererEvent('panel:event', {
        type: 'terminal:exit',
        source: { panelId, sessionId: terminal.sessionId, panelType: 'terminal' },
        data,
        timestamp: data.timestamp,
      });
    }
  }

  /**
   * Get all active terminal panel IDs.
   */
  getAllPanelIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Send Ctrl+C to all running terminals (for graceful shutdown).
   * Returns array of panel IDs that were signaled.
   */
  sendCtrlCToAll(): string[] {
    const signaledPanels: string[] = [];

    for (const [panelId, terminal] of this.terminals) {
      try {
        terminal.pty.write('\x03');
        signaledPanels.push(panelId);
        console.log(`[TerminalPanelManager] Sent Ctrl+C to terminal panel ${panelId}`);
      } catch (error) {
        console.error(`[TerminalPanelManager] Error sending Ctrl+C to terminal ${panelId}:`, error);
      }
    }

    return signaledPanels;
  }

  /**
   * Save state for all running terminals.
   */
  async saveAllTerminalStates(): Promise<void> {
    for (const panelId of this.terminals.keys()) {
      await this.saveTerminalState(panelId);
    }
  }

  /**
   * Re-spawn every live terminal panel after a ptyHost `UtilityProcess` restart.
   *
   * Order in the supervisor (see `ptyHostSupervisor.onProcExit`):
   *   rejectPendingRpcs → keep manager maps → await nextReady → respawnAll
   *
   * The supervisor intentionally does not emit synthetic exits on host crash:
   * doing so would run `setupTerminalHandlers.onExit` and delete the state this
   * method needs to respawn. Entries here reference stale `PtyHandleShim`s and
   * are replaced in-place.
   *
   * Skip rules:
   * - Legacy (non-ptyHost) terminals: supervisor restart is irrelevant to them.
   *   Their underlying `pty.IPty` is still alive; do not touch.
   * - Panels where spawn never finished (`ptyId` absent): no live PTY to revive.
   *
   * Plan Task 6b: run per-panel respawns in parallel via Promise.all.
   */
  async respawnAll(): Promise<void> {
    // Snapshot entries up-front so we can mutate `this.terminals` (delete
    // stale shims) while iterating without affecting the working set.
    const snapshots: Array<{
      panelId: string;
      sessionId: string;
      panel: ToolPanel;
      cwd: string;
      dimensions: { cols: number; rows: number };
      wslContext: WSLContext | null;
    }> = [];

    for (const [panelId, terminal] of this.terminals) {
      // Only ptyHost-backed terminals participate in supervisor restart.
      // Legacy `pty.spawn` processes survive the ptyHost crash untouched.
      if (!terminal.isPtyHost || !terminal.ptyId) {
        continue;
      }

      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        console.warn(`[ptyHost] respawnAll: panel ${panelId} no longer exists, skipping`);
        terminal.screenEmulator?.dispose();
        this.terminals.delete(panelId);
        this.visibleViewersByPanel.delete(panelId);
        continue;
      }

      // Read state for respawn: cwd is persisted on panel state by
      // `initializeTerminal` (see lines 616-622). Dimensions likewise.
      const cs = terminalCustomState(panel.state);
      const cwd = cs.cwd || process.cwd();
      const dimensions = cs.dimensions || { cols: 80, rows: 30 };

      snapshots.push({
        panelId,
        sessionId: terminal.sessionId,
        panel,
        cwd,
        dimensions,
        // Carry the original wslContext through so WSL panels get the same
        // WSLENV / distro / user propagation on respawn. Without this, WSL
        // terminals lose GIT_COMMITTER_* and PANE_* after a supervisor restart.
        wslContext: terminal.wslContext,
      });

      // Clear the stale entry so `initializeTerminal`'s duplicate-check at
      // `:304` doesn't early-return on the stub we're replacing.
      // We also clear any active timers on the stale entry to prevent
      // zombie callbacks firing against the new process.
      if (terminal.outputFlushTimer) {
        clearTimeout(terminal.outputFlushTimer);
        terminal.outputFlushTimer = null;
      }
      disposeFlowControlRecord(terminal.flowControl);
      terminal.screenEmulator?.dispose();
      this.terminals.delete(panelId);
      this.visibleViewersByPanel.delete(panelId);
    }

    if (snapshots.length === 0) {
      console.log('[ptyHost] TerminalPanelManager respawnAll: no ptyHost-backed panels to restart');
      return;
    }

    console.log(`[ptyHost] TerminalPanelManager respawnAll: ${snapshots.length} terminal panels`);

    // Run respawns in parallel. Individual failures don't cancel siblings.
    // wslContext is the one captured at original spawn time (Option A); see
    // snapshot construction above.
    const results = await Promise.all(snapshots.map(async ({ panel, cwd, dimensions, panelId, wslContext }) => {
      try {
        await this.initializeTerminal(panel, cwd, wslContext, 1, dimensions);
        return { panelId, ok: true as const };
      } catch (err) {
        console.error(`[ptyHost] respawnAll: initializeTerminal failed for panel ${panelId}:`, err);
        return { panelId, ok: false as const };
      }
    }));

    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    console.log(`[ptyHost] respawn complete: ${ok} terminal panels (${failed} failed)`);
  }

  /**
   * Clean plain-text scrollback from the rendered screen model. Returns null
   * without a live emulator so callers can use persisted state.
   */
  async getCleanTerminalScrollback(panelId: string, maxLines: number): Promise<string | null> {
    const text = await this.terminals.get(panelId)?.screenEmulator?.readScrollback(maxLines);
    return text ? text : null;
  }

  /**
   * Returns the alternate screen buffer state for a terminal panel.
   * Used by the renderer to initialize TUI detection when a panel
   * remounts while a full-screen program is already running.
   */
  getAltScreenState(panelId: string): { isAlternateScreen: boolean } | null {
    const terminal = this.terminals.get(panelId);
    if (!terminal) return null;
    return {
      isAlternateScreen: terminal.screenEmulator?.state.isAlternateScreen ?? terminal.isAlternateScreen,
    };
  }

  saveSerializedSnapshot(panelId: string, serializedData: string): void {
    // Enforce 8MB per-snapshot limit
    const MAX_SNAPSHOT_SIZE = 8_000_000;
    if (serializedData.length > MAX_SNAPSHOT_SIZE) {
      console.warn(`[TerminalPanelManager] Serialized snapshot for ${panelId} exceeds 8MB limit (${(serializedData.length / 1_000_000).toFixed(1)}MB), skipping`);
      return;
    }

    this.serializedBuffers.set(panelId, serializedData);

    // Enforce 64MB total limit across all panels
    const MAX_TOTAL_SIZE = 64_000_000;
    let totalSize = 0;
    for (const [, data] of this.serializedBuffers) {
      totalSize += data.length;
    }

    if (totalSize > MAX_TOTAL_SIZE) {
      // Prune oldest entries until under limit
      // Use terminal lastActivity to determine age
      const entries = Array.from(this.serializedBuffers.entries());
      // Sort by terminal activity time (oldest first) using the terminals map
      entries.sort((a, b) => {
        const termA = this.terminals.get(a[0]);
        const termB = this.terminals.get(b[0]);
        const timeA = termA?.lastActivity?.getTime() ?? 0;
        const timeB = termB?.lastActivity?.getTime() ?? 0;
        return timeA - timeB;
      });

      for (const [id] of entries) {
        if (totalSize <= MAX_TOTAL_SIZE) break;
        if (id === panelId) continue; // Don't prune the one we just added
        const removed = this.serializedBuffers.get(id);
        if (removed) {
          totalSize -= removed.length;
          this.serializedBuffers.delete(id);
          console.log(`[TerminalPanelManager] Pruned serialized snapshot for ${id} to stay under 64MB total`);
        }
      }
    }
  }

  destroyAllTerminals(): void {
    for (const [panelId, terminal] of this.terminals) {
      // Outer guard: nothing in one terminal's teardown may abort the loop.
      // That failure is wider than the one this method is fixing — it would
      // leave every later PTY unkilled and skip the `clear()` calls below,
      // and the caller in `index.ts` hard-exits immediately afterwards.
      try {
        // Save state before killing. `saveTerminalState` is async, so no
        // synchronous `try` can observe its rejection; hence the explicit
        // `.catch`. `panelManager.updatePanel` writes to SQLite mid-shutdown
        // and can reject.
        this.saveTerminalState(panelId).catch((error) => {
          console.error(`[TerminalPanelManager] Failed to save state for ${panelId}:`, error);
        });

        // Clear timers
        if (terminal.outputFlushTimer) {
          clearTimeout(terminal.outputFlushTimer);
          terminal.outputFlushTimer = null;
        }
        disposeFlowControlRecord(terminal.flowControl);

        // Inner guards: each step is caught on its own so a failure in one
        // cannot skip `pty.kill()`. The event-sink fanout rethrows its first
        // subscriber error and `dispose()` serializes through a third-party
        // addon, so either can throw. Under a single shared `try` a throwing
        // subscriber skipped the kill, and `this.terminals.clear()` below then
        // dropped the last handle to that PTY — orphaning a shell on the quit
        // path with nothing left able to reclaim it.
        try {
          this.flushOutputBuffer(terminal);
        } catch (error) {
          console.warn(`[TerminalPanelManager] Final output flush failed for ${panelId}:`, error);
        }

        try {
          terminal.screenEmulator?.dispose();
        } catch (error) {
          console.warn(`[TerminalPanelManager] Emulator dispose failed for ${panelId}:`, error);
        }

        try {
          terminal.pty.kill();
        } catch (error) {
          console.error(`[TerminalPanelManager] Error killing terminal ${panelId}:`, error);
        }
      } catch (error) {
        console.error(`[TerminalPanelManager] Error tearing down terminal ${panelId}:`, error);
      }
    }

    this.terminals.clear();
    this.visibleViewersByPanel.clear();
    this.serializedBuffers.clear();
  }

  getActiveTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }
}

// Export singleton instance
export const terminalPanelManager = new TerminalPanelManager();
