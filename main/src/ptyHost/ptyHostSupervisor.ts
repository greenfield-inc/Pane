/**
 * Main-side supervisor for the ptyHost UtilityProcess.
 *
 * Owns:
 * - the `UtilityProcess` handle and its lifecycle (start, exit, backoff restart)
 * - the main-side end of the RPC `MessageChannelMain` to `ptyHostMain.ts`
 * - a per-BrowserWindow `MessageChannelMain` pair for direct renderer data flow
 *   (delivered to the renderer via `webContents.postMessage('ptyHost-port', ...)`)
 * - live `PtyHandle` shims keyed by `ptyId`, used by the managers as an
 *   `IPty`-compatible surface
 *
 * Chunk C scope:
 * - wire the RPC channel and fan data events to `PtyHandle`s (for SQLite /
 *   sync-block strip / alt-screen detection in main)
 * - stand up the per-window renderer port as a passthrough: the supervisor
 *   creates the channel, retains both ends, and posts one to the renderer
 * - heartbeat + restart with manager-state-preserving respawn + exponential backoff
 *
 * Out of scope for Chunk C: true two-port tee from ptyHost to (main + renderer).
 * Chunk D/E/F will extend `ptyHostMain.ts` with an `attach-renderer` port so
 * bytes can flow directly to the renderer without traversing main.
 *
 * Wire constraints enforced here (see plan gotchas lines 320-340, 734-743):
 * - Every `MessagePortMain` is stored as a class field; closure locals would
 *   let GC close the channel.
 * - `.start()` is called on every port before `.on('message', ...)` or
 *   `.postMessage(...)`.
 * - The init frame is exactly `{ type: 'init' }` with the RPC port in the
 *   `transfer` array (see `ptyHostMain.ts:110-132`).
 * - The host sends `{ type: 'host-ready' }` on UtilityProcess `parentPort`
 *   after it attaches the transferred RPC port. `start()` does not resolve
 *   before this handshake lands.
 * - Heartbeat frames are raw `{ type: 'heartbeat-ping' | 'heartbeat-pong' }`;
 *   NOT RPC-framed.
 * - No renderer-facing reconnect banner; log-only per locked decision.
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents,
} from 'electron';

import {
  isPtyHostResponse,
  RpcDispatcher,
} from './rpc';
import type {
  PtyHostEvent,
  PtyHostRequest,
  PtyHostSpawnOpts,
} from './types';
import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '../../../shared/validation/boundaryDecoder';

/** Max restart attempts before we give up and leave the host down. */
const MAX_RESTART_ATTEMPTS = 5;
/** Heartbeat ping interval in ms. */
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Max time (ms) with no pong before we kill the host and let restart fire. */
const HEARTBEAT_DEAD_MS = 30_000;
/** Reset the restart counter only after the host has stayed up this long. */
const RESTART_STABLE_MS = 60_000;
/** Fail startup if the child does not confirm the RPC port was attached. */
const STARTUP_READY_TIMEOUT_MS = 5_000;

/**
 * Narrow shape of inbound frames on the RPC port. The supervisor multiplexes
 * four kinds: the two heartbeat events, data/exit events, and RPC responses.
 * The rest is handled in `onRpcMessage` via the shared `isPtyHostResponse`.
 */
const heartbeatPongSchema = boundary.object({ type: boundary.literal('heartbeat-pong') });
const hostReadySchema = boundary.object({ type: boundary.literal('host-ready') });
const dataEventSchema = boundary.object({
  type: boundary.literal('data'), ptyId: boundary.string, data: boundary.string,
});
const exitEventSchema = boundary.object({
  type: boundary.literal('exit'),
  ptyId: boundary.string,
  exitCode: boundary.nullable(boundary.number),
  signal: boundary.nullable(boundary.number),
});
const rendererFrameSchema = boundary.union(
  boundary.object({ type: boundary.literal('ack'), ptyId: boundary.string, bytes: boundary.number }),
  boundary.object({ type: boundary.literal('write'), ptyId: boundary.string, data: boundary.string }),
);

function decodeFrame<Value>(frame: JsonValue, schema: BoundarySchema<Value>): Value | undefined {
  try {
    return decodeBoundary(frame, schema);
  } catch {
    return undefined;
  }
}

/** Listener signatures kept explicit so `PtyHandle` type stays analyzable. */
type DataListener = (data: string) => void;
type ExitListener = (exitCode: number | null, signal: number | null) => void;

interface DisposableListener {
  dispose(): void;
}

/**
 * Thin `IPty`-compatible shim.
 *
 * The managers (`terminalPanelManager`, `AbstractCliManager`, ...) treat this
 * as a stand-in for `pty.IPty` so their existing `onData` / `onExit` wiring
 * continues to work across the async seam. `pid` is cached from the spawn
 * response so synchronous `.pid` reads in the three `killProcessTree`
 * implementations keep working.
 *
 * Chunks D/E replace the direct `pty.IPty` with this shim in each manager.
 */
export class PtyHandle {
  readonly id: string;
  readonly pid: number;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private exited = false;

  constructor(
    id: string,
    pid: number,
    private readonly supervisor: PtyHostSupervisor,
  ) {
    this.id = id;
    this.pid = pid;
  }

  /**
   * Subscribe to PTY byte output. Returns an `IDisposable`-shaped object so
   * callers that previously used `pty.onData(...).dispose()` keep working.
   */
  onData(listener: DataListener): DisposableListener {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  /**
   * Subscribe to PTY exit. Callback receives `{exitCode, signal}` verbatim
   * from the host; `signal` is the raw number so SIGSEGV/SIGABRT/SIGBUS
   * detection at `AbstractCliManager.ts:781-795` keeps working.
   */
  onExit(listener: ExitListener): DisposableListener {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  /** Used by the supervisor to fan incoming data frames to listeners. */
  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('[ptyHost] onData listener threw', err);
      }
    }
  }

  /**
   * Used by the supervisor to fan incoming real exit frames.
   * Idempotent: once `exited` is set, subsequent calls are no-ops so a real
   * repeated host exit frames don't double-fire.
   */
  emitExit(exitCode: number | null, signal: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) {
      try {
        listener(exitCode, signal);
      } catch (err) {
        console.error('[ptyHost] onExit listener threw', err);
      }
    }
  }

  async write(data: string): Promise<void> {
    await this.supervisor.write(this.id, data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.supervisor.resize(this.id, cols, rows);
  }

  async kill(signal?: NodeJS.Signals): Promise<void> {
    await this.supervisor.kill(this.id, signal);
  }

  async pause(): Promise<void> {
    await this.supervisor.pause(this.id);
  }

  async resume(): Promise<void> {
    await this.supervisor.resume(this.id);
  }
}

/**
 * Per-window MessageChannel pair. Both ends are retained on the supervisor
 * because port GC closes the channel (plan gotcha line 323).
 */
interface WindowPortPair {
  mainPort: MessagePortMain;
  rendererPort: MessagePortMain;
}

export class PtyHostSupervisor extends EventEmitter {
  private proc: UtilityProcess | null = null;
  /** Main-side end of the RPC channel to `ptyHostMain.ts`. Field, not local. */
  private rpcPort: MessagePortMain | null = null;
  /** Per-BrowserWindow data port pairs keyed by `webContents.id`. */
  private readonly windowPorts = new Map<number, WindowPortPair>();
  /** Live PTY shims keyed by host-allocated `ptyId`. */
  private readonly liveHandles = new Map<string, PtyHandle>();
  private readonly dispatcher = new RpcDispatcher();
  private restartCount = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  /** Resolves on the first successful `start()`. Replaced on every restart. */
  private readyResolved = false;
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private hostReadyResolve: (() => void) | null = null;
  private hostReadyReject: ((err: Error) => void) | null = null;

  constructor() {
    super();
    // Seed the first ready promise; `start()` replaces these on restart.
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  /**
   * Promise that resolves on the first successful `start()`. Managers await
   * this before posting their first RPC so the port is guaranteed live.
   */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Fork the UtilityProcess and wire the RPC channel. On restart this is
   * called again from `onProcExit`; we reset `proc`/`rpcPort` and rebuild.
   */
  async start(): Promise<void> {
    // After TypeScript build, supervisor lives at
    //   main/dist/main/src/ptyHost/ptyHostSupervisor.js
    // (per `main/tsconfig.json` preserved-source layout + `main/package.json:5`).
    // `ptyHostMain.js` is its sibling. Do NOT hardcode `main/dist/ptyHost/...`.
    const entry = path.join(__dirname, 'ptyHostMain.js');

    const { port1, port2 } = new MessageChannelMain();
    this.rpcPort = port1;

    const execArgv = process.env.PANE_PTY_HOST_DEBUG ? ['--inspect-brk=9230'] : [];
    this.proc = utilityProcess.fork(entry, [], {
      serviceName: 'pane-pty-host',
      stdio: 'pipe',
      execArgv,
    });

    const hostReadyPromise = new Promise<void>((resolve, reject) => {
      this.hostReadyResolve = resolve;
      this.hostReadyReject = reject;
    });
    const startupTimeout = setTimeout(() => {
      console.error(`[ptyHost] host did not signal ready within ${STARTUP_READY_TIMEOUT_MS}ms; killing host`);
      this.hostReadyReject?.(new Error('PTY_HOST_READY_TIMEOUT'));
      this.proc?.kill();
    }, STARTUP_READY_TIMEOUT_MS);

    // Pipe UtilityProcess stdout/stderr into main's console with a `[ptyHost]`
    // prefix so operators can correlate host logs with main (plan line 423).
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[ptyHost] ${chunk.toString()}`);
    });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[ptyHost] ${chunk.toString()}`);
    });

    // Post the init frame with port2 in the transfer array. Shape is fixed by
    // `ptyHostMain.ts:67-69, 110-132`: `{ type: 'init' }` + `[port2]`.
    this.proc.postMessage({ type: 'init' }, [port2]);

    // `.start()` must be called before adding the listener, otherwise any
    // frame that arrives before start() is silently queued until start and
    // can interleave with the listener install (plan gotchas line 322, 738).
    this.rpcPort.start();
    this.rpcPort.on('message', (event: Electron.MessageEvent) => {
      try {
        this.onRpcMessage(decodeBoundary(event.data, boundary.json));
      } catch {
        console.log('[ptyHost] malformed RPC frame, dropping');
      }
    });

    this.proc.on('message', (message) => {
      try {
        const ready = decodeFrame(decodeBoundary(message, boundary.json), hostReadySchema);
        if (ready) {
          this.hostReadyResolve?.();
          this.hostReadyResolve = null;
          this.hostReadyReject = null;
        }
      } catch { /* Ignore non-JSON utility-process control messages. */ }
    });

    this.proc.on('exit', (code: number | null) => {
      this.onProcExit(code);
    });

    try {
      await hostReadyPromise;
    } finally {
      clearTimeout(startupTimeout);
    }

    this.startHeartbeat();

    console.log(
      `[ptyHost] started (flag=${process.env.PANE_USE_PTY_HOST ?? 'unset'}, pid=${this.proc.pid})`,
    );

    if (!this.readyResolved) {
      this.readyResolved = true;
      this.readyResolve?.();
    }

    // Capture whether this was a restart before arming the stability timer. The
    // `ready-after-restart` event is the hook the index.ts listener uses to
    // drive per-manager `respawnAll()` — firing it on the initial boot would
    // re-enter empty maps and waste work.
    const wasRestart = this.restartCount > 0;

    // Reset the restart counter only after the host stays healthy. Resetting
    // immediately on fork lets a fast crash loop restart forever.
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
    }
    this.stableTimer = setTimeout(() => {
      if (this.restartCount > 0) {
        console.log('[ptyHost] host stayed up; resetting restart counter');
      }
      this.restartCount = 0;
      this.stableTimer = null;
    }, RESTART_STABLE_MS);

    // `ready` fires on every successful start (initial + restart) for
    // diagnostic listeners. `ready-after-restart` fires only when we're
    // recovering from a crash; that's what Task 6b's respawn wiring binds to.
    this.emit('ready');
    if (wasRestart) {
      this.emit('ready-after-restart');
    }
  }

  /**
   * Route an inbound frame on the RPC port.
   *
   * Four kinds:
   * - `heartbeat-pong` → clear pong timer
   * - `data` event → fan to `PtyHandle.emitData`
   * - `exit` event → fan to `PtyHandle.emitExit`, drop from `liveHandles`
   * - `PtyHostResponse` → dispatch via `RpcDispatcher`
   */
  private onRpcMessage(data: JsonValue): void {
    if (decodeFrame(data, heartbeatPongSchema)) {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }

    const dataEvent = decodeFrame(data, dataEventSchema);
    if (dataEvent) {
      const handle = this.liveHandles.get(dataEvent.ptyId);
      if (handle) {
        handle.emitData(dataEvent.data);
      }
      // Data frames are NOT auto-teed to renderers here. Main-side managers
      // (`terminalPanelManager.setupTerminalHandlers`) subscribe via the
      // `PtyHandle` and run `filterSyncBlockClears` / alt-screen detection
      // BEFORE forwarding filtered bytes to renderers. Raw broadcasting here
      // would re-introduce the clear-screen scroll yank in xterm.js.
      return;
    }

    const exitEvent = decodeFrame(data, exitEventSchema);
    if (exitEvent) {
      const handle = this.liveHandles.get(exitEvent.ptyId);
      if (handle) {
        handle.emitExit(exitEvent.exitCode, exitEvent.signal);
        this.liveHandles.delete(exitEvent.ptyId);
      }
      // Exit frames ARE mirrored to renderers so `electronAPI.ptyHost.onExit`
      // subscribers fire. No main-side filtering is required for exit frames;
      // the preload dispatches by ptyId. Stale listeners (e.g. for a ptyId
      // whose panel already unmounted) drop the frame on the floor.
      this.broadcastToRenderers(exitEvent);
      return;
    }

    if (isPtyHostResponse(data)) {
      this.dispatcher.handleResponse(data);
      return;
    }

    console.log('[ptyHost] unknown message frame, dropping', data);
  }

  /**
   * UtilityProcess exited (crash, kill, or graceful exit). Clean up every
   * piece of state that referenced the dead process, then schedule a restart
   * unless we've exceeded `MAX_RESTART_ATTEMPTS`.
   *
   * Order:
   * 1. Reject every pending RPC so `withLock` callers release.
   * 2. Drop dead handles but do NOT emit synthetic exits. Manager maps must
   *    remain intact so `ready-after-restart` can snapshot and respawn them.
   * 3. Tear down heartbeat timers.
   * 4. Emit `'restart'` (log-only; no renderer banner per locked decision).
   * 5. If over the cap, log and give up.
   * 6. Otherwise schedule `start()` with exponential backoff.
   */
  private onProcExit(code: number | null): void {
    console.warn(`[ptyHost] UtilityProcess exited (code=${code ?? 'null'})`);

    this.dispatcher.rejectAll(new Error('PTY_HOST_RESTARTED'));

    this.liveHandles.clear();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }

    this.proc = null;
    this.rpcPort = null;
    this.hostReadyReject?.(new Error('PTY_HOST_EXITED_BEFORE_READY'));
    this.hostReadyResolve = null;
    this.hostReadyReject = null;

    if (!this.readyResolved && this.restartCount === 0) {
      this.readyReject?.(new Error('PTY_HOST_EXITED_BEFORE_READY'));
      return;
    }

    this.emit('restart');

    if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
      console.error(
        `[ptyHost] giving up after ${MAX_RESTART_ATTEMPTS} restart attempts; PTY operations will fail until app restart`,
      );
      if (!this.readyResolved) {
        this.readyReject?.(new Error('PTY_HOST_GAVE_UP'));
      }
      return;
    }

    const backoff = Math.min(2000, 200 * 2 ** this.restartCount);
    this.restartCount += 1;
    console.log(`[ptyHost] scheduling restart #${this.restartCount} in ${backoff}ms`);

    // Reset the ready promise so awaiters block until the new start succeeds.
    this.readyResolved = false;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    setTimeout(() => {
      this.start().catch((err) => {
        console.error('[ptyHost] restart failed', err);
      });
    }, backoff);
  }

  /**
   * Arm the heartbeat loop. Every `HEARTBEAT_INTERVAL_MS` we post a ping and
   * (if not already armed) set a pong timer. Arrival of any pong clears the
   * pong timer; failure to pong within `HEARTBEAT_DEAD_MS` kills the host,
   * which triggers `onProcExit` and the restart path.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.rpcPort?.postMessage({ type: 'heartbeat-ping' });
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          console.warn(`[ptyHost] no pong within ${HEARTBEAT_DEAD_MS}ms; killing host`);
          this.pongTimer = null;
          this.proc?.kill();
        }, HEARTBEAT_DEAD_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Spawn a PTY. Awaits `ready()` so callers don't have to worry about
   * posting before the host is attached. Registers a `PtyHandle` on success
   * so subsequent `data` / `exit` events can route by `ptyId`.
   */
  async spawn(opts: PtyHostSpawnOpts): Promise<{ ptyId: string; pid: number }> {
    await this.readyPromise;
    if (!this.rpcPort) {
      throw new Error('PTY_HOST_NOT_READY');
    }
    const req: Omit<PtyHostRequest, 'id'> = { method: 'spawn', args: opts };
    const result = await this.dispatcher.send(this.rpcPort, req);
    const spawned = decodeBoundary(result, boundary.object({ ptyId: boundary.string, pid: boundary.number }));
    const handle = new PtyHandle(spawned.ptyId, spawned.pid, this);
    this.liveHandles.set(spawned.ptyId, handle);
    return spawned;
  }

  async write(ptyId: string, data: string): Promise<void> {
    await this.readyPromise;
    if (!this.rpcPort) throw new Error('PTY_HOST_NOT_READY');
    const req: Omit<PtyHostRequest, 'id'> = { method: 'write', args: { ptyId, data } };
    await this.dispatcher.send(this.rpcPort, req);
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    await this.readyPromise;
    if (!this.rpcPort) throw new Error('PTY_HOST_NOT_READY');
    const req: Omit<PtyHostRequest, 'id'> = { method: 'resize', args: { ptyId, cols, rows } };
    await this.dispatcher.send(this.rpcPort, req);
  }

  async kill(ptyId: string, signal?: NodeJS.Signals): Promise<void> {
    await this.readyPromise;
    if (!this.rpcPort) throw new Error('PTY_HOST_NOT_READY');
    const req: Omit<PtyHostRequest, 'id'> = { method: 'kill', args: { ptyId, signal } };
    await this.dispatcher.send(this.rpcPort, req);
  }

  async pause(ptyId: string): Promise<void> {
    await this.readyPromise;
    if (!this.rpcPort) throw new Error('PTY_HOST_NOT_READY');
    const req: Omit<PtyHostRequest, 'id'> = { method: 'pause', args: { ptyId } };
    await this.dispatcher.send(this.rpcPort, req);
  }

  async resume(ptyId: string): Promise<void> {
    await this.readyPromise;
    if (!this.rpcPort) throw new Error('PTY_HOST_NOT_READY');
    const req: Omit<PtyHostRequest, 'id'> = { method: 'resume', args: { ptyId } };
    await this.dispatcher.send(this.rpcPort, req);
  }

  async ack(ptyId: string, bytes: number): Promise<void> {
    await this.readyPromise;
    if (!this.rpcPort) throw new Error('PTY_HOST_NOT_READY');
    const req: Omit<PtyHostRequest, 'id'> = { method: 'ack', args: { ptyId, bytes } };
    await this.dispatcher.send(this.rpcPort, req);
  }

  /**
   * Look up a live handle by id. Used by managers that stored the id as part
   * of their panel state and need the shim back.
   */
  getHandle(ptyId: string): PtyHandle | undefined {
    return this.liveHandles.get(ptyId);
  }

  /**
   * Stand up the per-BrowserWindow data port pair and deliver the renderer
   * end to the window. Called from `index.ts` on `did-finish-load`.
   *
   * Chunk C scope: the renderer port is a passthrough. Bytes still flow from
   * ptyHost → supervisor → `PtyHandle.emitData` and from there to main-side
   * code (SQLite, sync-block strip). `TerminalPanel.tsx` continues to receive
   * bytes via the existing `terminal:output` IPC path. Chunk D switches the
   * renderer to subscribe on this port, and future work may extend ptyHost to
   * tee bytes directly to the renderer end.
   *
   * Both ports are retained on `windowPorts` — port GC would otherwise close
   * the channel (plan gotcha line 323).
   */
  attachWindow(webContents: WebContents): void {
    // A reload tears down the preload that held the previous renderer port, so
    // every load needs a fresh channel. Close the stale pair before replacing it.
    const existing = this.windowPorts.get(webContents.id);
    if (existing) {
      existing.mainPort.close();
    } else {
      // Clean up on window destroy so the map doesn't retain dead entries.
      webContents.once('destroyed', () => {
        this.windowPorts.get(webContents.id)?.mainPort.close();
        this.windowPorts.delete(webContents.id);
      });
    }

    const { port1: mainPort, port2: rendererPort } = new MessageChannelMain();
    this.windowPorts.set(webContents.id, { mainPort, rendererPort });

    // Start the main-side end before listening. This end will carry ack/write
    // frames from the renderer in Chunk D.
    mainPort.start();
    mainPort.on('message', (event: Electron.MessageEvent) => {
      try {
        this.onRendererMessage(webContents.id, decodeBoundary(event.data, boundary.json));
      } catch {
        /* Ignore malformed renderer frames at the port boundary. */
      }
    });

    // Hand the renderer end to the window. The preload listener for
    // 'ptyHost-port' takes `event.ports[0]` and stores it.
    webContents.postMessage('ptyHost-port', null, [rendererPort]);

    console.log(`[ptyHost] attached window webContentsId=${webContents.id}`);
  }

  /**
   * Inbound message from a renderer over its data port. Chunk D: handles
   * ack frames (`{type: 'ack', ptyId, bytes}`) so the renderer can ack
   * bytes back over the MessagePort instead of round-tripping through
   * `ipcRenderer.invoke('terminal:ack', ...)`. Ack is forwarded to the
   * supervisor's `ack()` RPC which the host currently treats as a no-op;
   * managers track flow-control state on the main side via
   * `acknowledgeBytes()` elsewhere.
   */
  private onRendererMessage(webContentsId: number, data: JsonValue): void {
    void webContentsId;
    const frame = decodeFrame(data, rendererFrameSchema);
    if (!frame) return;

    if (frame.type === 'ack') {
      // Managers still track flow control on the main side. Emit first so
      // TerminalPanelManager can decrement pending bytes and resume the PTY.
      this.emit('renderer-ack', frame.ptyId, frame.bytes);

      // Forward as a no-op RPC for forward compat. Silently swallow errors
      // because an ack failure after a supervisor restart is not actionable.
      this.ack(frame.ptyId, frame.bytes).catch(() => {
        /* ignore; stale ack after host restart */
      });
      return;
    }

    if (frame.type === 'write') {
      this.write(frame.ptyId, frame.data).catch(() => {
        /* ignore; stale write after host restart */
      });
      return;
    }
  }

  /**
   * Post `frame` to every attached renderer's data port. Preload routes the
   * frame to subscribers registered via `electronAPI.ptyHost.onData` /
   * `onExit` by `ptyId`; windows that never registered a subscriber for
   * `frame.ptyId` drop the frame on the floor.
   *
   * Kept narrow: only `data` and `exit` frames flow this way. Heartbeat and
   * RPC-response frames stay on the main-side RPC port.
   */
  private broadcastToRenderers(frame: PtyHostEvent): void {
    for (const { mainPort } of this.windowPorts.values()) {
      try {
        mainPort.postMessage(frame);
      } catch (err) {
        // A destroyed window's port can throw; safe to drop the frame.
        console.warn('[ptyHost] failed to post renderer frame', err);
      }
    }
  }

  /**
   * Post a FILTERED `data` frame to every attached renderer's data port.
   * Called by main-side managers (e.g. `terminalPanelManager.flushOutputBuffer`)
   * AFTER running `filterSyncBlockClears` and alt-screen detection on the raw
   * bytes. This is the hand-off for flag-on renderer subscriptions via
   * `electronAPI.ptyHost.onData(ptyId, cb)`.
   *
   * Kept separate from `broadcastToRenderers` so the intent is explicit:
   * supervisor never auto-broadcasts raw data bytes.
   */
  postDataToRenderers(ptyId: string, data: string): void {
    this.broadcastToRenderers({ type: 'data', ptyId, data });
  }

  /**
   * Snapshot of live handle ids. Used by Chunk E's `respawnAll` wiring to
   * figure out which panels need re-spawning after a restart.
   */
  getLiveHandleIds(): string[] {
    return Array.from(this.liveHandles.keys());
  }
}
