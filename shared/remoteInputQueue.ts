import { boundary, decodeBoundary } from './validation/boundaryDecoder';

/** Order stamp for one input request: the host writes each stream's requests in `seq` order. */
export interface RemoteInputSequence {
  stream: string;
  seq: number;
}

interface InputBatch<Result> {
  channel: string;
  data: string;
  waiters: Array<{ resolve: (result: Result) => void; reject: (error: Error) => void }>;
}

interface InFlight<Result> {
  batch: InputBatch<Result>;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
}

interface PanelInputQueue<Result> {
  pending: InputBatch<Result>[];
  active: InFlight<Result>[];
  stream: string;
  nextSeq: number;
}

interface RemoteInputQueueOptions {
  /**
   * How many requests per terminal may be in flight. 1 (the default) waits for each write before the
   * next. More is only safe when the host orders writes by RemoteInputSequence (its `input-seq`
   * capability); the queue then stops waiting a full round trip between keys.
   */
  pipelineDepth?: () => number;
}

// Bound merged requests without splitting a paste or terminal escape sequence.
const MAX_BATCH_CHARACTERS = 64 * 1024;
const INPUT_TIMEOUT_MS = 10_000;
// A bare ESC must end its write. Terminal apps that parse by read boundary, such
// as Codex and Claude Code, treat ESC followed by a key in one read as Alt+key.
const ESCAPE = '\x1b';
const inputSchema = boundary.object({ panelId: boundary.nonEmptyString, data: boundary.string });

/**
 * Serializes remote input per terminal. Keys typed while the allowed number of requests is in flight
 * are batched into the next one.
 */
export class RemoteInputQueue<Result> {
  private readonly panels = new Map<string, PanelInputQueue<Result>>();
  private readonly pipelineDepth: () => number;

  constructor(
    private readonly send: (
      channel: string,
      args: unknown[],
      signal?: AbortSignal,
      sequence?: RemoteInputSequence,
    ) => Promise<Result>,
    options: RemoteInputQueueOptions = {},
  ) {
    this.pipelineDepth = options.pipelineDepth ?? (() => 1);
  }

  invoke(channel: string, args: unknown[]): Promise<Result> {
    if (channel !== 'terminal:input' && channel !== 'panels:send-terminal-input') {
      return this.send(channel, args);
    }
    const { panelId, data } = decodeBoundary({ panelId: args[0], data: args[1] }, inputSchema);

    let queue = this.panels.get(panelId);
    if (!queue) {
      queue = { pending: [], active: [], stream: createStreamId(), nextSeq: 0 };
      this.panels.set(panelId, queue);
    }
    const result = new Promise<Result>((resolve, reject) => {
      const last = queue.pending[queue.pending.length - 1];
      if (
        last
        && last.channel === channel
        && !last.data.endsWith(ESCAPE)
        && last.data.length + data.length <= MAX_BATCH_CHARACTERS
      ) {
        last.data += data;
        last.waiters.push({ resolve, reject });
      } else {
        queue.pending.push({ channel, data, waiters: [{ resolve, reject }] });
      }
    });
    this.drain(panelId, queue);
    return result;
  }

  cancel(error: Error): void {
    for (const [panelId, queue] of this.panels) {
      this.fail(panelId, queue, error);
    }
  }

  private drain(panelId: string, queue: PanelInputQueue<Result>): void {
    const depth = Math.max(1, Math.floor(this.pipelineDepth()));
    while (queue.active.length < depth) {
      const batch = queue.pending.shift();
      if (!batch) break;
      this.start(panelId, queue, batch, depth > 1 ? { stream: queue.stream, seq: queue.nextSeq++ } : undefined);
    }
    if (queue.active.length === 0 && queue.pending.length === 0 && this.panels.get(panelId) === queue) {
      this.panels.delete(panelId);
    }
  }

  private start(
    panelId: string,
    queue: PanelInputQueue<Result>,
    batch: InputBatch<Result>,
    sequence: RemoteInputSequence | undefined,
  ): void {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      this.fail(panelId, queue, new Error('Remote terminal input timed out; pending input was discarded'));
    }, INPUT_TIMEOUT_MS);
    const entry: InFlight<Result> = { batch, controller, timeout };
    queue.active.push(entry);

    const args = [panelId, batch.data];
    const request = sequence
      ? this.send(batch.channel, args, controller.signal, sequence)
      : this.send(batch.channel, args, controller.signal);
    void request.then((result) => {
      // A disconnect may have canceled this queue and created a new one for the same panel.
      if (this.panels.get(panelId) !== queue) return;
      clearTimeout(timeout);
      queue.active = queue.active.filter(candidate => candidate !== entry);
      for (const waiter of batch.waiters) waiter.resolve(result);
      this.drain(panelId, queue);
    }, (error: unknown) => {
      this.fail(panelId, queue, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private fail(panelId: string, queue: PanelInputQueue<Result>, error: Error): void {
    if (this.panels.get(panelId) !== queue) return;
    this.panels.delete(panelId);
    const batches = [...queue.active.map(entry => entry.batch), ...queue.pending];
    for (const entry of queue.active) {
      clearTimeout(entry.timeout);
      entry.controller.abort();
    }
    queue.active = [];
    queue.pending = [];
    // Delivery of an in-flight request is uncertain. Never replay it or send its queued suffix.
    for (const batch of batches) {
      for (const waiter of batch.waiters) waiter.reject(error);
    }
  }
}

function createStreamId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
