import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';

const EXE = process.platform === 'win32' ? 'pane-direct.exe' : 'pane-direct';
const RESTART_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
/** A run this long counts as healthy, so the next exit restarts after the shortest wait. */
const HEALTHY_RUN_MS = 60_000;
const EXIT_GRACE_MS = 3_000;

/**
 * The `pane-direct` helper: `PANE_DIRECT_BIN`, the copy packaged in the app's resources, or a
 * development build at `direct/target/debug`. Null when none exists, which turns direct paths off.
 */
export function findPaneDirect(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PANE_DIRECT_BIN) return existsSync(env.PANE_DIRECT_BIN) ? env.PANE_DIRECT_BIN : null;
  const { resourcesPath } = decodeBoundary(process, boundary.object({ resourcesPath: boundary.optional(boundary.string) }));
  if (resourcesPath && existsSync(path.join(resourcesPath, EXE))) return path.join(resourcesPath, EXE);
  // From main/src/daemon/relay (tests) or main/dist/main/src/daemon/relay (a dev build).
  for (let dir = __dirname, depth = 0; depth < 8; dir = path.dirname(dir), depth += 1) {
    const candidate = path.join(dir, 'direct', 'target', 'debug', EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** One JSON line `pane-direct` prints (direct/src/main.rs), with the fields Pane reads; `exit` when a run ends. */
interface PaneDirectEvent {
  t: string;
  nodeId?: string;
  addrs?: string[];
  port?: number;
  message?: string;
}

const eventSchema: BoundarySchema<PaneDirectEvent> = boundary.object({
  t: boundary.string,
  nodeId: boundary.optional(boundary.string),
  addrs: boundary.optional(boundary.array(boundary.string)),
  port: boundary.optional(boundary.number),
  message: boundary.optional(boundary.string),
});

export interface PaneDirectOptions {
  bin: string;
  args: string[];
  /** Every line the helper prints, from each run, then `{t: 'exit'}` when the run ends. */
  onEvent(event: PaneDirectEvent): void;
  log?(line: string): void;
}

/**
 * One `pane-direct` child, restarted with backoff (1 s up to 30 s) whenever it exits, until
 * `stop()`. The helper exits on its own when its stdin closes, so it never outlives Pane.
 */
export class PaneDirectProcess {
  private child: ChildProcess | null = null;
  private stopped = false;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PaneDirectOptions) {}

  start(): void {
    this.stopped = false;
    if (!this.child && !this.restartTimer) this.run();
  }

  /** Closes the helper's stdin, then kills it by PID if it has not left within 3 s. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin?.end();
    });
  }

  private run(): void {
    const started = Date.now();
    const child = spawn(this.options.bin, this.options.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { parsed = undefined; }
      const event = decodeOptionalBoundary(parsed, eventSchema);
      if (!event || this.child !== child) return;
      if (event.t === 'error') this.options.log?.(`[direct] ${event.message ?? 'error'}`);
      this.options.onEvent(event);
    });
    createInterface({ input: child.stderr }).on('line', (line) => this.options.log?.(`[direct] ${line}`));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => this.options.log?.(`[direct] could not start ${this.options.bin}: ${error.message}`));
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.options.onEvent({ t: 'exit' });
      if (this.stopped) return;
      this.failures = Date.now() - started > HEALTHY_RUN_MS ? 0 : this.failures + 1;
      const wait = RESTART_MS[Math.min(this.failures, RESTART_MS.length - 1)];
      this.options.log?.(`[direct] pane-direct exited (${signal ?? code}); restarting in ${wait / 1000} s`);
      this.restartTimer = setTimeout(() => { this.restartTimer = null; this.run(); }, wait);
      this.restartTimer.unref();
    });
  }
}
