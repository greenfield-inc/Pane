import type { ConfigManager } from '../services/configManager';
import type { PtyHostSpawnOpts } from '../ptyHost/types';
import { noopPaneEventSink, type PaneEventSink } from './eventSink';

export interface PaneWebviewContext {
  panelId: string;
  sessionId: string;
}

export interface PtyHandleLike {
  readonly id: string;
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (exitCode: number | null, signal: number | null) => void): { dispose(): void };
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

/**
 * Narrow PTY host contract consumed by daemon-owned services.
 *
 * This intentionally omits Electron window attachment and other client-facing
 * concerns. Those stay in the Electron adapter around the runtime.
 */
export interface PtyHostRuntime {
  spawn(opts: PtyHostSpawnOpts): Promise<{ ptyId: string; pid: number }>;
  write(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  kill(ptyId: string, signal?: NodeJS.Signals): Promise<void>;
  ack(ptyId: string, bytes: number): Promise<void>;
  pause(ptyId: string): Promise<void>;
  resume(ptyId: string): Promise<void>;
  getHandle(ptyId: string): PtyHandleLike | undefined;
}

/**
 * Daemon runtime dependencies installed by the Electron bootstrap today and by
 * a future headless daemon bootstrap later.
 *
 * This layer is intentionally local-only in Phase 1. Network listeners,
 * authentication, pairing, relays, and hosted VM orchestration attach later.
 */
export interface PaneRuntime {
  eventSink: PaneEventSink;
  /**
   * Non-renderer daemon subscribers, such as the local socket server and the
   * remote HTTP/SSE transport. This stream is live-only; reconnecting clients
   * are expected to refetch state instead of relying on server-side replay.
   */
  daemonEventSink?: PaneEventSink;
  getConfigManager(): ConfigManager;
  getPtyHostRuntime(): PtyHostRuntime | null;
  getWebviewContextMap(): Map<number, PaneWebviewContext>;
}

let paneRuntime: PaneRuntime | null = null;

export function setPaneRuntime(runtime: PaneRuntime): void {
  paneRuntime = runtime;
}

export function getPaneRuntime(): PaneRuntime {
  if (!paneRuntime) {
    throw new Error('Pane runtime has not been initialized');
  }

  return paneRuntime;
}

export function getPaneEventSink(): PaneEventSink {
  return paneRuntime?.eventSink ?? noopPaneEventSink;
}

export function getPaneDaemonEventSink(): PaneEventSink {
  return paneRuntime?.daemonEventSink ?? noopPaneEventSink;
}

export function getRuntimeConfigManager(): ConfigManager {
  return getPaneRuntime().getConfigManager();
}

export function getPtyHostRuntime(): PtyHostRuntime | null {
  return getPaneRuntime().getPtyHostRuntime();
}

export function getPaneWebviewContextMap(): Map<number, PaneWebviewContext> {
  return getPaneRuntime().getWebviewContextMap();
}

export function resetPaneRuntimeForTests(): void {
  paneRuntime = null;
}
