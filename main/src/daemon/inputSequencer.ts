/**
 * Orders pipelined terminal input. A remote client may keep several `terminal:input` requests in
 * flight (each on its own connection, so they can arrive out of order); each carries
 * `X-Pane-Input-Seq: <stream>:<seq>` and the host writes a stream's requests strictly in `seq` order.
 * A request that never arrives (its connection died) holds the stream back for at most `gapMs`, then
 * the next waiting one goes ahead: input is never replayed, and never stalls for long.
 */
export const INPUT_SEQUENCE_HEADER = 'x-pane-input-seq';

interface StreamState {
  next: number;
  busy: boolean;
  waiting: Map<number, () => void>;
  gapTimer: ReturnType<typeof setTimeout> | null;
  lastUsedAt: number;
}

const DEFAULT_GAP_MS = 1_000;
const STREAM_IDLE_MS = 5 * 60_000;
const MAX_STREAMS = 1_000;
const SEQUENCE_PATTERN = /^([A-Za-z0-9_-]{1,64}):(\d{1,9})$/;

export function parseInputSequenceHeader(value: string | string[] | undefined): { stream: string; seq: number } | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = raw ? SEQUENCE_PATTERN.exec(raw.trim()) : null;
  return match ? { stream: match[1], seq: Number(match[2]) } : null;
}

export class InputSequencer {
  private readonly streams = new Map<string, StreamState>();

  constructor(private readonly gapMs = DEFAULT_GAP_MS, private readonly now: () => number = Date.now) {}

  /** Resolves when it is `seq`'s turn in `stream`; call the returned release once its write is done. */
  async enter(stream: string, seq: number): Promise<() => void> {
    const state = this.state(stream);
    state.lastUsedAt = this.now();
    // Earlier than the cursor: its turn was skipped after a gap. Write it now rather than drop it.
    // A repeated number (a client bug) must not strand the first waiter: write it now too.
    if (seq < state.next || state.waiting.has(seq)) return () => undefined;
    if (seq > state.next || state.busy) {
      await new Promise<void>((resolve) => {
        state.waiting.set(seq, resolve);
        this.armGapTimer(state);
      });
    }
    state.busy = true;
    state.next = seq;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.busy = false;
      state.next = Math.max(state.next, seq + 1);
      state.lastUsedAt = this.now();
      this.wakeNext(state);
    };
  }

  private state(stream: string): StreamState {
    let state = this.streams.get(stream);
    if (!state) {
      this.prune();
      state = { next: 0, busy: false, waiting: new Map(), gapTimer: null, lastUsedAt: this.now() };
      this.streams.set(stream, state);
    }
    return state;
  }

  private wakeNext(state: StreamState): void {
    if (state.busy) return;
    const resolve = state.waiting.get(state.next);
    if (resolve) {
      state.waiting.delete(state.next);
      this.clearGapTimer(state);
      resolve();
      return;
    }
    if (state.waiting.size > 0) this.armGapTimer(state);
    else this.clearGapTimer(state);
  }

  private armGapTimer(state: StreamState): void {
    if (state.gapTimer || state.busy) return;
    state.gapTimer = setTimeout(() => {
      state.gapTimer = null;
      if (state.busy || state.waiting.size === 0) return;
      // The missing request is not coming: skip to the earliest one that did.
      state.next = Math.min(...state.waiting.keys());
      this.wakeNext(state);
    }, this.gapMs);
  }

  private clearGapTimer(state: StreamState): void {
    if (state.gapTimer) clearTimeout(state.gapTimer);
    state.gapTimer = null;
  }

  private prune(): void {
    const cutoff = this.now() - STREAM_IDLE_MS;
    for (const [stream, state] of this.streams) {
      if (state.busy || state.waiting.size > 0) continue;
      if (state.lastUsedAt < cutoff || this.streams.size >= MAX_STREAMS) this.streams.delete(stream);
    }
  }
}
