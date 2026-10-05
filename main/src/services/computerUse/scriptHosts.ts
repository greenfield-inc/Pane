import { fork, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import type { ComputerUseEngine, EngineImage, EngineResult } from './engine';
import { childMessageSchema, type ChildMessage, type ParentMessage } from './scriptHostProtocol';

export interface ScriptRunResult {
  ok: boolean;
  text: string;
  images: EngineImage[];
}

export interface ScriptHostSummary {
  connectionId: string;
  running: boolean;
  lastUsedAt: string;
}

interface ScriptHostsOptions {
  getEngine: () => ComputerUseEngine;
  /** Shows the user that an agent is bringing `app` to the front. Resolves with a line for the result. */
  showForegroundNotice?: (info: { connectionId: string; app: string }) => Promise<string | undefined>;
  /** The compiled child next to this file; tests point it at the TypeScript source. */
  childEntry?: string;
  idleTimeoutMs?: number;
  runTimeoutMs?: number;
  maxOutputChars?: number;
}

// Starting values from the plan: Codex caps output near 25k tokens (~4 characters each).
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
// The child enforces these too; the daemon re-checks because the child runs agent code.
const MAX_IMAGES = 20;
// Room for the note the child adds when it truncates.
const TRUNCATION_NOTE_CHARS = 100;
const MAX_IMAGE_BASE64_CHARS = 20_000_000;
// A hold that outlives this is a stuck or hostile script; other agents get the app back.
const MAX_HOLD_MS = 30_000;
const GLOBAL_LANE = 'global';
const CLIPBOARD_LANE = 'clipboard';
const STOPPED: EngineResult = { ok: false, error: { code: 'script_stopped', message: 'The script was stopped before this call ran.' } };
const MACOS_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// Scripts reach the desktop only through the daemon's IPC channel, an inherited socket pair.
const NO_NETWORK_PROFILE = '(version 1)(allow default)(deny network-outbound)(deny network-bind)';

const appListSchema = boundary.object({
  apps: boundary.array(boundary.object({ pid: boundary.optional(boundary.number), name: boundary.optional(boundary.string) })),
});

function resolvedPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

// Script processes die with the daemon, even one stuck in a loop that never sees the IPC disconnect.
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackChild(child: ChildProcess): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const live of liveChildren) live.kill('SIGKILL');
    });
  }
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
}

interface Hold {
  lanes: string[];
  release: () => void;
  /** The notice line once this action has shown one: one notice per action, not per call. */
  notice?: string;
}

interface Host {
  child: ChildProcess;
  /** Runs on one connection go one at a time, in order. */
  queue: Promise<unknown>;
  running: boolean;
  closed: boolean;
  lastUsedAt: Date;
  idleTimer?: ReturnType<typeof setTimeout>;
  finishRun?: (result: ScriptRunResult) => void;
  onStep?: (step: JsonValue) => void;
  holds: Map<number, Hold>;
}

/**
 * One script process per agent connection, created on its first run and closed on reset, after
 * sitting idle, or by `stopAll`. Engine calls from every host share one lane per target app, so
 * two agents never interleave input into the same window, while different apps run in parallel.
 * A host can hold an app's lane (and the clipboard's) across the several calls of one action.
 */
export class ScriptHosts {
  private readonly hosts = new Map<string, Host>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private nextRunId = 1;
  private readonly childEntry: string;
  private readonly idleTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly maxOutputChars: number;

  constructor(private readonly options: ScriptHostsOptions) {
    this.childEntry = options.childEntry ?? path.join(__dirname, 'scriptHostChild.js');
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  /** `onStep` gets each step the script reports while this run is in flight. */
  run(connectionId: string, code: string, onStep?: (step: JsonValue) => void): Promise<ScriptRunResult> {
    const host = this.hosts.get(connectionId) ?? this.startHost(connectionId);
    const result = host.queue.then(() => this.runOnHost(connectionId, host, code, onStep));
    host.queue = result.catch(() => undefined);
    return result;
  }

  /** Discards a connection's script state. Returns whether it had any. */
  reset(connectionId: string): boolean {
    const host = this.hosts.get(connectionId);
    if (!host) return false;
    this.closeHost(connectionId, host, 'The script state was reset while this script ran.');
    return true;
  }

  summaries(): ScriptHostSummary[] {
    return [...this.hosts].map(([connectionId, host]) => ({
      connectionId,
      running: host.running,
      lastUsedAt: host.lastUsedAt.toISOString(),
    }));
  }

  /** Stops every script and the engine, as when computer use is turned off. */
  async stopAll(reason: string): Promise<void> {
    for (const [connectionId, host] of [...this.hosts]) this.closeHost(connectionId, host, reason);
    await this.options.getEngine().stop();
  }

  private startHost(connectionId: string): Host {
    const child = this.spawnConfined();
    trackChild(child);
    const host: Host = { child, queue: Promise.resolve(), running: false, closed: false, lastUsedAt: new Date(), holds: new Map() };
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      console.error(`[computer-use script ${connectionId}] ${chunk.trimEnd()}`);
    });
    child.on('message', (message: JsonValue) => {
      // The script can reach `process.send`, so its messages are parsed like any other untrusted input.
      const parsed = decodeOptionalBoundary(message, childMessageSchema);
      if (parsed) this.onChildMessage(connectionId, host, parsed);
      else this.closeHost(connectionId, host, 'The script process sent a malformed message and was stopped.');
    });
    // A failed fork or a send on a closed channel lands here; unhandled, it would take down the daemon.
    child.on('error', (error) => {
      console.error(`[computer-use script ${connectionId}] ${error.message}`);
      this.closeHost(connectionId, host, `The script process failed: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      host.closed = true;
      if (this.hosts.get(connectionId) === host) this.hosts.delete(connectionId);
      if (host.idleTimer) clearTimeout(host.idleTimer);
      this.releaseHolds(host);
      host.finishRun?.({ ok: false, text: `The script process exited (${signal ?? `code ${code}`}); its state was lost.`, images: [] });
    });
    this.hosts.set(connectionId, host);
    return host;
  }

  /**
   * Agent code can climb out of its vm globals to the child's real `process`, so the process itself
   * is confined: Node's permission model allows reading only Pane's own code (no other files, no
   * writes, child processes or workers), and on macOS a sandbox profile also denies the network,
   * which keeps scripts off the daemon's and the engine's sockets. The child gets no inherited
   * environment or flags.
   */
  private spawnConfined(): ChildProcess {
    // The child's code: its own folder, and the compiled tree it imports from (`shared/` included).
    // The permission model compares resolved paths (macOS temp folders sit behind a symlink).
    const entry = resolvedPath(this.childEntry);
    const readable = [path.dirname(entry), resolvedPath(path.resolve(__dirname, '../../../..'))];
    const nodeArgs = ['--permission', ...readable.flatMap((dir) => [`--allow-fs-read=${dir}`, `--allow-fs-read=${path.join(dir, '*')}`])];
    const options = { env: { ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] as const };
    if (process.platform === 'darwin' && fs.existsSync(MACOS_SANDBOX_EXEC)) {
      return spawn(MACOS_SANDBOX_EXEC, ['-p', NO_NETWORK_PROFILE, process.execPath, ...nodeArgs, entry], { ...options, stdio: [...options.stdio] });
    }
    return fork(entry, [], { ...options, stdio: [...options.stdio], execArgv: nodeArgs });
  }

  private runOnHost(connectionId: string, host: Host, code: string, onStep?: (step: JsonValue) => void): Promise<ScriptRunResult> {
    if (host.closed) {
      return Promise.resolve({ ok: false, text: 'The script state was reset before this script ran.', images: [] });
    }
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.running = true;
    host.onStep = onStep;
    host.lastUsedAt = new Date();
    const runId = this.nextRunId++;
    return new Promise<ScriptRunResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.closeHost(connectionId, host, `The script ran longer than ${Math.round(this.runTimeoutMs / 1000)} s and was stopped; its state was reset.`);
      }, this.runTimeoutMs);
      host.finishRun = (result) => {
        clearTimeout(timeout);
        host.finishRun = undefined;
        host.onStep = undefined;
        host.running = false;
        host.lastUsedAt = new Date();
        // A hold never spans runs.
        this.releaseHolds(host);
        if (this.hosts.get(connectionId) === host) {
          host.idleTimer = setTimeout(() => this.closeHost(connectionId, host, ''), this.idleTimeoutMs);
        }
        resolve(this.capResult(result));
      };
      host.child.send({ type: 'run', runId, code, maxOutputChars: this.maxOutputChars, engine: this.options.getEngine().id } satisfies ParentMessage);
    });
  }

  private onChildMessage(connectionId: string, host: Host, message: ChildMessage): void {
    if (message.type === 'done') {
      host.finishRun?.({ ok: message.ok, text: message.text, images: message.images });
      return;
    }
    if (message.type === 'step') {
      host.onStep?.(message.step);
      return;
    }
    if (message.type === 'hold') {
      void this.hold(host, message.holdId, message.pid, message.clipboard);
      return;
    }
    if (message.type === 'release') {
      this.release(host, message.holdId);
      return;
    }
    // A call queued behind others must not act once its script was stopped, reset, or turned off.
    const lane = laneFor(message.tool, message.args);
    const hold = this.holdFor(host, lane);
    const call = () => (host.closed ? Promise.resolve(STOPPED) : this.callEngine(connectionId, message.tool, message.args, hold));
    // Calls inside the host's own hold already own their lane.
    const run = hold ? call() : this.inLane(lane, call);
    void run.then((result) => {
      if (!host.closed) host.child.send({ type: 'callResult', callId: message.callId, result } satisfies ParentMessage);
    });
  }

  private async callEngine(connectionId: string, tool: string, args: JsonObject, hold?: Hold): Promise<EngineResult> {
    try {
      // The notice is the daemon's job: a script can send a foreground call without asking the layer.
      let notice: string | undefined;
      if (args.delivery_mode === 'foreground') {
        notice = hold?.notice ?? await this.showForegroundNotice(connectionId, args);
        if (hold) hold.notice = notice;
      }
      const result = await this.options.getEngine().call(tool, args);
      return notice === undefined ? result : { ...result, notice };
    } catch (error) {
      return { ok: false, error: { code: 'engine_error', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /** A failed notice never blocks the action the agent opted into; it's logged instead. */
  private async showForegroundNotice(connectionId: string, args: JsonObject): Promise<string | undefined> {
    if (!this.options.showForegroundNotice) return undefined;
    try {
      return await this.options.showForegroundNotice({ connectionId, app: await this.appName(args) });
    } catch (error) {
      console.error('[computer-use] Failed to show the foreground notice:', error);
      return undefined;
    }
  }

  private async appName(args: JsonObject): Promise<string> {
    const pid = decodeOptionalBoundary(args.pid, boundary.number);
    if (pid === undefined) return 'an app';
    const listed = decodeOptionalBoundary((await this.options.getEngine().call('list_apps', {})).data, appListSchema);
    return listed?.apps.find((app) => app.pid === pid)?.name ?? `the app with pid ${pid}`;
  }

  /** Takes the app's lane, and the clipboard's when asked, always in the same order so holds can't deadlock. */
  private async hold(host: Host, holdId: number, pid: number | undefined, clipboard: boolean): Promise<void> {
    const lanes = [pid === undefined ? GLOBAL_LANE : `pid:${pid}`, ...(clipboard ? [CLIPBOARD_LANE] : [])].sort();
    const releases: Array<() => void> = [];
    for (const lane of lanes) releases.push(await this.acquire(lane));
    const timer = setTimeout(() => this.release(host, holdId), MAX_HOLD_MS);
    const release = () => {
      clearTimeout(timer);
      for (const free of releases) free();
    };
    if (host.closed) {
      release();
      return;
    }
    host.holds.set(holdId, { lanes, release });
    host.child.send({ type: 'held', holdId } satisfies ParentMessage);
  }

  private release(host: Host, holdId: number): void {
    host.holds.get(holdId)?.release();
    host.holds.delete(holdId);
  }

  private releaseHolds(host: Host): void {
    for (const holdId of [...host.holds.keys()]) this.release(host, holdId);
  }

  private holdFor(host: Host, lane: string): Hold | undefined {
    return [...host.holds.values()].find((hold) => hold.lanes.includes(lane));
  }

  /** Resolves once `lane` is ours, with the function that gives it back. */
  private acquire(lane: string): Promise<() => void> {
    return new Promise((acquired) => {
      void this.inLane(lane, () => new Promise<void>((release) => acquired(release)));
    });
  }

  private inLane<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.lanes.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => undefined);
    this.lanes.set(key, tail);
    void tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    });
    return result;
  }

  private closeHost(connectionId: string, host: Host, reason: string): void {
    host.closed = true;
    if (this.hosts.get(connectionId) === host) this.hosts.delete(connectionId);
    if (host.idleTimer) clearTimeout(host.idleTimer);
    this.releaseHolds(host);
    host.finishRun?.({ ok: false, text: reason, images: [] });
    host.child.kill();
  }

  private capResult(result: ScriptRunResult): ScriptRunResult {
    const notes: string[] = [];
    let text = result.text;
    if (text.length > this.maxOutputChars + TRUNCATION_NOTE_CHARS) {
      notes.push(`[output truncated: ${text.length - this.maxOutputChars} more characters]`);
      text = text.slice(0, this.maxOutputChars);
    }
    const images: EngineImage[] = [];
    let base64Chars = 0;
    for (const image of result.images) {
      if (images.length === MAX_IMAGES || base64Chars + image.base64.length > MAX_IMAGE_BASE64_CHARS) break;
      images.push(image);
      base64Chars += image.base64.length;
    }
    if (images.length < result.images.length) notes.push(`[${result.images.length - images.length} more images dropped]`);
    return { ok: result.ok, text: notes.length === 0 ? text : [text, ...notes].join('\n'), images };
  }
}

/**
 * Cua names the app by `pid`, the Codex runtime by `app` or `window_id`. Clipboard tools share one
 * lane because the clipboard is one per machine; other calls without a target share a lane too.
 */
function laneFor(tool: string, args: JsonObject): string {
  if (tool.startsWith('clipboard')) return CLIPBOARD_LANE;
  const pid = decodeOptionalBoundary(args.pid, boundary.number);
  if (pid !== undefined) return `pid:${pid}`;
  const app = decodeOptionalBoundary(args.app, boundary.string);
  if (app !== undefined) return `app:${app}`;
  const windowId = decodeOptionalBoundary(args.window_id, boundary.number);
  return windowId === undefined ? GLOBAL_LANE : `window:${windowId}`;
}
