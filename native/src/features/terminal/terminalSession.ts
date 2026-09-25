/**
 * Talks to one terminal panel on the host: restores its screen, streams its
 * output, sends input and resizes, and acks rendered bytes so the host's flow
 * control keeps the PTY running. It has no React Native imports; the screen
 * wires it to the daemon client and the xterm WebView.
 */

type Invoke = (channel: string, args: unknown[]) => Promise<unknown>;

/** What `terminal:getState` returns (a subset of `TerminalPanelState`). */
interface HostTerminalState {
  scrollbackBuffer?: string | string[];
  alternateScreenBuffer?: string;
  isAlternateScreen?: boolean;
  serializedBuffer?: string;
}

interface TerminalSink {
  /** Replace everything on screen with `data`. */
  reset(data: string): void;
  write(data: string): void;
}

export interface TerminalSessionOptions {
  invoke: Invoke;
  panelId: string;
  sessionId: string;
  /** Identifies this viewer to the host's visibility tracking. */
  viewerId: string;
  sink: TerminalSink;
  /** A restore failed; the screen shows stale or no output until the next one. */
  onError?: (error: unknown) => void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export class TerminalSession {
  private size: TerminalSize | null = null;
  /** Bumped by every restore and by `detach`, so stale restores stop writing. */
  private generation = 0;
  private live = false;
  private pendingAck = 0;
  private ackInFlight = false;
  private inputQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TerminalSessionOptions) {}

  /**
   * Shows the panel at `size`: starts the PTY if needed, sizes it, then replaces
   * the screen with the host's snapshot. Call again after reconnecting or
   * returning to the foreground, since the event stream does not replay output.
   */
  async restore(size: TerminalSize): Promise<void> {
    const generation = ++this.generation;
    this.size = size;
    this.live = false;
    const { invoke, panelId, sessionId, viewerId, sink } = this.options;
    // The screen can resize while the restore awaits the host; use the latest size.
    const cols = () => this.size?.cols ?? size.cols;
    const rows = () => this.size?.rows ?? size.rows;
    try {
      const initialized = await invoke('panels:checkInitialized', [panelId]);
      if (generation !== this.generation) return;
      if (initialized !== true) {
        // A panel this screen starts has nothing to restore. Going live first
        // shows its first frame, which the host's snapshot can lag behind.
        sink.reset('');
        this.live = true;
        await invoke('terminal:setVisibility', [panelId, true, viewerId]);
        await invoke('panels:initialize', [panelId, { sessionId, cols: cols(), rows: rows() }]);
        return;
      }
      // Size the PTY before reading the snapshot, so the host serializes it at
      // the width this screen shows.
      await invoke('terminal:resize', [panelId, cols(), rows()]);
      await invoke('terminal:setVisibility', [panelId, true, viewerId]);
      const state = await invoke('terminal:getState', [panelId]) as HostTerminalState | null;
      if (generation !== this.generation) return;
      sink.reset(snapshotText(state));
      this.live = true;
      if (state?.isAlternateScreen) {
        // A restored full-screen app frame can't be trusted at a new size; a
        // forced resize makes the app itself repaint.
        await invoke('terminal:resize', [panelId, cols(), rows(), { force: true }]);
      }
    } catch (error) {
      if (generation === this.generation) this.options.onError?.(error);
    }
  }

  /**
   * Handles one `terminal:output` event. Output that arrives while a snapshot
   * is in flight is acked but not drawn, as on the desktop: the snapshot
   * usually contains it. Events and invoke responses travel on separate
   * connections, so a chunk right at the boundary can be lost or drawn twice.
   */
  receiveOutput(payload: unknown): void {
    if (!isOutputPayload(payload) || payload.panelId !== this.options.panelId) return;
    if (this.live) {
      this.options.sink.write(payload.output);
    } else {
      this.ack(payload.output.length);
    }
  }

  /**
   * The screen is done with `units` of output, counted in UTF-16 code units
   * (`string.length`) like the host's flow control. Acks are sent one at a
   * time and coalesced.
   */
  ack(units: number): void {
    this.pendingAck += units;
    if (this.ackInFlight || this.pendingAck === 0) return;
    const sending = this.pendingAck;
    this.pendingAck = 0;
    this.ackInFlight = true;
    this.options.invoke('terminal:ack', [this.options.panelId, sending])
      .catch(() => undefined)
      .finally(() => {
        this.ackInFlight = false;
        this.ack(0);
      });
  }

  /** Sends keystrokes in order: each waits for the previous one to reach the host. */
  sendInput(data: string): Promise<void> {
    const { invoke, panelId } = this.options;
    const sent = this.inputQueue.then(() => invoke('terminal:input', [panelId, data]));
    this.inputQueue = sent.catch(() => undefined);
    return sent.then(() => undefined);
  }

  resize(size: TerminalSize): void {
    if (this.size && this.size.cols === size.cols && this.size.rows === size.rows) return;
    this.size = size;
    // A lost resize only leaves the PTY at the old size until the next one.
    void this.options.invoke('terminal:resize', [this.options.panelId, size.cols, size.rows])
      .catch(() => undefined);
  }

  /** Tells the host nobody is watching, so it stops pacing the PTY to this screen. */
  detach(): void {
    this.generation++;
    this.live = false;
    void this.options.invoke('terminal:setVisibility', [this.options.panelId, false, this.options.viewerId])
      .catch(() => undefined);
  }

  /** Re-announces this viewer; the host forgets viewers it hasn't heard from in a while. */
  keepAlive(): void {
    if (!this.live) return;
    void this.options.invoke('terminal:setVisibility', [this.options.panelId, true, this.options.viewerId])
      .catch(() => undefined);
  }
}

function snapshotText(state: HostTerminalState | null): string {
  if (!state) return '';
  if (state.isAlternateScreen) return state.serializedBuffer ?? state.alternateScreenBuffer ?? '';
  const scrollback = Array.isArray(state.scrollbackBuffer)
    ? state.scrollbackBuffer.join('')
    : state.scrollbackBuffer ?? '';
  return scrollback || state.serializedBuffer || '';
}

function isOutputPayload(value: unknown): value is { panelId: string; output: string } {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.panelId === 'string' && typeof payload.output === 'string';
}
