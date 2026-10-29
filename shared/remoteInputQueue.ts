import { PaneError } from './paneError';
import { boundary, decodeBoundary } from './validation/boundaryDecoder';

interface InputBatch<Result> {
  channel: string;
  data: string;
  waiters: Array<{ resolve: (result: Result) => void; reject: (error: Error) => void }>;
}

interface PanelInputQueue<Result> {
  pending: InputBatch<Result>[];
  active?: {
    batch: InputBatch<Result>;
    controller: AbortController;
    timeout: ReturnType<typeof setTimeout> | undefined;
  };
}

// Bound merged requests without splitting a paste or terminal escape sequence.
const MAX_BATCH_CHARACTERS = 64 * 1024;
const INPUT_TIMEOUT_MS = 10_000;
// A bare ESC must end its write. Terminal apps that parse by read boundary, such
// as Codex and Claude Code, treat ESC followed by a key in one read as Alt+key.
const ESCAPE = '\x1b';
const inputSchema = boundary.object({ panelId: boundary.nonEmptyString, data: boundary.string });

/** Serializes remote input per terminal, batching only while a request is in flight. */
export class RemoteInputQueue<Result> {
  private readonly panels = new Map<string, PanelInputQueue<Result>>();

  constructor(
    private readonly send: (channel: string, args: unknown[], signal?: AbortSignal) => Promise<Result>,
    /** Called when the host never answered a request, after its input is failed. */
    private readonly onTimeout?: () => void,
    /** True while `send` itself resends unanswered input until the host answers; the queue then sets no timeout. */
    private readonly resends: () => boolean = () => false,
  ) {}

  invoke(channel: string, args: unknown[]): Promise<Result> {
    if (channel !== 'terminal:input' && channel !== 'panels:send-terminal-input') {
      return this.send(channel, args);
    }
    const { panelId, data } = decodeBoundary({ panelId: args[0], data: args[1] }, inputSchema);

    let queue = this.panels.get(panelId);
    if (!queue) {
      queue = { pending: [] };
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
    if (!queue.active) void this.drain(panelId, queue);
    return result;
  }

  cancel(error: Error): void {
    for (const [panelId, queue] of this.panels) {
      this.fail(panelId, queue, new PaneError('ERR_REMOTE_DELIVERY_UNKNOWN', `Delivery unknown: terminal input was in flight when the connection changed. Check the original panel before resubmitting. ${error.message}`));
    }
  }

  private async drain(panelId: string, queue: PanelInputQueue<Result>): Promise<void> {
    const batch = queue.pending.shift();
    if (!batch) {
      this.panels.delete(panelId);
      return;
    }
    const controller = new AbortController();
    const timeout = this.resends() ? undefined : setTimeout(() => {
      this.fail(panelId, queue, new PaneError('ERR_REMOTE_DELIVERY_UNKNOWN', 'Delivery unknown: terminal input timed out. Check the original panel before resubmitting; pending input was discarded.'));
      this.onTimeout?.();
    }, INPUT_TIMEOUT_MS);
    queue.active = { batch, controller, timeout };

    try {
      const result = await this.send(batch.channel, [panelId, batch.data], controller.signal);
      // A disconnect may have canceled this queue and created a new one for the same panel.
      if (this.panels.get(panelId) !== queue) return;
      clearTimeout(timeout);
      queue.active = undefined;
      for (const waiter of batch.waiters) waiter.resolve(result);
      void this.drain(panelId, queue);
    } catch (error) {
      this.fail(panelId, queue, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(panelId: string, queue: PanelInputQueue<Result>, error: Error): void {
    if (this.panels.get(panelId) !== queue) return;
    this.panels.delete(panelId);
    if (queue.active) {
      clearTimeout(queue.active.timeout);
      queue.active.controller.abort();
      for (const waiter of queue.active.batch.waiters) waiter.reject(error);
    }
    // Delivery of an in-flight request is uncertain. Never replay it or send its queued suffix.
    for (const batch of queue.pending) {
      for (const waiter of batch.waiters) waiter.reject(new Error('Remote connection interrupted: queued terminal input was not sent. Check the panel and re-enter it after reconnecting.'));
    }
  }
}
