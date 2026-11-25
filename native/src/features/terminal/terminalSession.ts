/**
 * Talks to one terminal panel on the host: restores its screen, streams its
 * output, sends input and resizes, and acks rendered bytes so the host's flow
 * control keeps the PTY running. It has no React Native imports; the screen
 * wires it to the daemon client and the xterm WebView.
 */

import { terminalSnapshotText, type HostTerminalSnapshot } from '@shared/remoteClient';

type Invoke = (channel: string, args: unknown[]) => Promise<unknown>;


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
  /** This screen is starting the panel: its shell, and any agent in it, are only now launching. */
  onStart?: () => void;
  /** The panel isn't running and the host didn't start it: this phone only watches. */
  onNotRunning?: () => void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export class TerminalSession {
  private size: TerminalSize | null = null;
  /** The size the host's PTY took from this screen during the current restore. The desktop resizes the same PTY, so it isn't kept across restores. */
  private hostSize: TerminalSize | null = null;
  /** Bumped by every restore and by `detach`, so stale restores stop writing. */
  private generation = 0;
  private live = false;
  private pendingAck = 0;
  private ackInFlight = false;
  private inputQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TerminalSessionOptions) {}

  /** The host's screen is drawn and new output streams in. */
  get isLive(): boolean {
    return this.live;
  }

  /**
   * Shows the panel at `size` in two round trips: the start check, the PTY size and this viewer's
   * visibility go together, then the host's snapshot is read. Call again after reconnecting,
   * since the event stream does not replay output.
   */
  async restore(size: TerminalSize): Promise<void> {
    const generation = ++this.generation;
    this.size = size;
    this.hostSize = null;
    this.live = false;
    const { invoke, panelId, sessionId, viewerId, sink } = this.options;
    // The screen can resize while the restore awaits the host; use the latest size.
    const cols = () => this.size?.cols ?? size.cols;
    const rows = () => this.size?.rows ?? size.rows;
    try {
      const [initialized] = await Promise.all([
        invoke('panels:checkInitialized', [panelId]),
        // Sized before the snapshot is read, so the host serializes it at the width this screen shows.
        // An unstarted panel ignores it and starts at the size below instead.
        this.sizeHostAt(cols(), rows()),
        invoke('terminal:setVisibility', [panelId, true, viewerId]),
      ]);
      if (generation !== this.generation) return;
      if (initialized !== true) {
        // A panel this screen starts has nothing to restore. Going live first
        // shows its first frame, which the host's snapshot can lag behind.
        sink.reset('');
        this.live = true;
        this.options.onStart?.();
        const started = await invoke('panels:initialize', [panelId, { sessionId, cols: cols(), rows: rows() }]);
        if (started === false && generation === this.generation) this.options.onNotRunning?.();
        return;
      }
      // The screen resized while the first trip was out.
      await this.sizeHostAt(cols(), rows());
      const state = await invoke('terminal:getState', [panelId]) as HostTerminalSnapshot | null;
      if (generation !== this.generation) return;
      sink.reset(terminalSnapshotText(state));
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

  /** Sizes the host's PTY unless it is already at this size. */
  private async sizeHostAt(cols: number, rows: number): Promise<void> {
    if (this.hostSize?.cols === cols && this.hostSize.rows === rows) return;
    await this.options.invoke('terminal:resize', [this.options.panelId, cols, rows]).then(
      () => { this.hostSize = { cols, rows }; },
      () => undefined,
    );
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
    void this.sizeHostAt(size.cols, size.rows);
  }

  /** Tells the host nobody is watching, so it stops pacing the PTY to this screen. */
  detach(): void {
    this.generation++;
    this.hostSize = null;
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


function isOutputPayload(value: unknown): value is { panelId: string; output: string } {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.panelId === 'string' && typeof payload.output === 'string';
}
