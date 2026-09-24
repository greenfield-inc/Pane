import {
  startTerminalEmulatorHost,
  type EmulatorHost,
  type EmulatorQuery,
  type EmulatorReply,
  type EmulatorRequest,
  type RestoreSnapshot,
  type ScreenState,
} from './terminalEmulatorHost';

type Reply = ScreenState | RestoreSnapshot | string | null;

const EMPTY_STATE: ScreenState = { screenText: '', inputScreenText: '', isAlternateScreen: false, oscTitle: '', oscProgress: '' };

/** Main-side end of an emulator host; one host serves many terminals. */
export class TerminalEmulatorHostConnection {
  private nextId = 1;
  private nextReq = 1;
  private closed = false;
  private readonly pending = new Map<number, (reply: Reply) => void>();
  private readonly stateListeners = new Map<number, (state: ScreenState) => void>();

  constructor(private readonly host: EmulatorHost) {
    host.on('message', (message) => this.onMessage(message));
    host.once('error', (error) => {
      console.error('[TerminalEmulatorHost] emulator thread failed:', error);
      this.close();
    });
    host.once('exit', () => this.close());
    host.unref();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  createEmulator(cols: number, rows: number): RemoteTerminalEmulator {
    return new RemoteTerminalEmulator(this, cols, rows);
  }

  register(cols: number, rows: number, onState: (state: ScreenState) => void): number {
    const id = this.nextId++;
    this.stateListeners.set(id, onState);
    this.post({ op: 'create', id, cols, rows });
    return id;
  }

  post(message: Exclude<EmulatorRequest, { req: number }>): void {
    if (!this.closed) this.host.postMessage(message);
  }

  /** Screen state once every write sent so far has been parsed. */
  readState(id: number): Promise<ScreenState | null> {
    // SAFETY: the host answers 'state' with a ScreenState (or null).
    return this.request({ op: 'state', id }) as Promise<ScreenState | null>;
  }

  readRestore(id: number): Promise<RestoreSnapshot | null> {
    // SAFETY: the host answers 'restore' with a RestoreSnapshot (or null).
    return this.request({ op: 'restore', id }) as Promise<RestoreSnapshot | null>;
  }

  /** Rendered plain-text scrollback plus viewport, once every write sent so far has been parsed. */
  readScrollback(id: number, maxLines: number): Promise<string | null> {
    // SAFETY: the host answers 'scrollback' with a string (or null).
    return this.request({ op: 'scrollback', id, maxLines }) as Promise<string | null>;
  }

  /** Drop the model; resolves to its final capture, scrollback included. */
  release(id: number): Promise<RestoreSnapshot | null> {
    this.stateListeners.delete(id);
    // SAFETY: the host answers 'dispose' with a RestoreSnapshot (or null).
    return this.request({ op: 'dispose', id }) as Promise<RestoreSnapshot | null>;
  }

  private request(query: EmulatorQuery): Promise<Reply> {
    if (this.closed) return Promise.resolve(null);
    const req = this.nextReq++;
    return new Promise((resolve) => {
      this.pending.set(req, resolve);
      this.host.postMessage({ ...query, req });
    });
  }

  private onMessage(message: EmulatorReply): void {
    if (message.op === 'screen') {
      this.stateListeners.get(message.id)?.(message.state);
      return;
    }
    this.pending.get(message.req)?.(message.op === 'scrollbackReply' ? message.text : message.state);
    this.pending.delete(message.req);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.stateListeners.clear();
  }
}

let sharedThread: TerminalEmulatorHostConnection | null = null;

/** The app's one emulator thread, started on first use and again if it dies. */
export function sharedEmulatorThread(): TerminalEmulatorHostConnection {
  if (!sharedThread || sharedThread.isClosed) {
    sharedThread = new TerminalEmulatorHostConnection(startTerminalEmulatorHost());
  }
  return sharedThread;
}

/**
 * Main-process handle to a TerminalStateEmulator that lives on an emulator
 * host. Writes are fire-and-forget; `state` is the last screen the host
 * reported (at most ~50 ms old), and `refresh()` / `restoreSnapshot()` wait
 * for every write sent so far to be parsed. If the host dies, reads settle to
 * the cached state and restore snapshots to null.
 */
export class RemoteTerminalEmulator {
  private readonly id: number;
  private cached: ScreenState = EMPTY_STATE;
  private final: Promise<RestoreSnapshot | null> | null = null;

  constructor(private readonly host: TerminalEmulatorHostConnection, cols: number, rows: number) {
    this.id = host.register(cols, rows, (state) => {
      this.cached = state;
    });
  }

  get state(): ScreenState {
    return this.cached;
  }

  write(data: string): void {
    if (data && !this.final) this.host.post({ op: 'write', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    if (!this.final) this.host.post({ op: 'resize', id: this.id, cols, rows });
  }

  clearScrollback(): void {
    if (!this.final) this.host.post({ op: 'clear', id: this.id });
  }

  async refresh(): Promise<ScreenState> {
    const state = await (this.final ?? this.host.readState(this.id));
    if (state) this.cached = state;
    return this.cached;
  }

  async restoreSnapshot(): Promise<RestoreSnapshot | null> {
    const snapshot = await (this.final ?? this.host.readRestore(this.id));
    if (snapshot) this.cached = snapshot;
    return snapshot;
  }

  /** Null once disposed, so callers fall back to persisted scrollback. */
  readScrollback(maxLines: number): Promise<string | null> {
    return this.final ? Promise.resolve(null) : this.host.readScrollback(this.id, maxLines);
  }

  /** Stop the model; later reads return its final capture, scrollback included. */
  dispose(): void {
    this.final ??= this.host.release(this.id);
  }
}
