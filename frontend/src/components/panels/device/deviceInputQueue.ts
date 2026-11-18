import type { DeviceInput } from '../../../../../shared/types/devices';

interface Waiting {
  input: DeviceInput;
  /** Told when the input (or the later one merged into it) has been sent: with its error when it failed. */
  sent: Array<(failure: Error | undefined) => void>;
}

/**
 * Sends a device tab's input one at a time, in the order the person made it, so a tap's end never
 * overtakes its start on a slow link. While one input is on its way, a drag's moves that wait
 * behind it merge into the latest, and scrolls add up, so input never queues up behind the link;
 * taps, buttons, keys, turns and folds are each sent. An input that fails is skipped and the rest
 * still go. Each call answers once its input has been sent, with the error when it failed (it
 * never rejects, so a caller may ignore it). `onSent` hears each input once it has been sent.
 */
export function deviceInputQueue(send: (input: DeviceInput) => Promise<void>, onSent?: (input: DeviceInput) => void): (input: DeviceInput) => Promise<Error | undefined> {
  const waiting: Waiting[] = [];
  let sending = false;
  const pump = async () => {
    if (sending) return;
    sending = true;
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      const failure = await send(next.input).then(() => undefined, (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))));
      for (const told of next.sent) told(failure);
      onSent?.(next.input);
    }
    sending = false;
  };
  return (input) => new Promise((resolve) => {
    const last = waiting.at(-1);
    if (last?.input.kind === 'touch' && last.input.phase === 'move' && input.kind === 'touch' && input.phase === 'move') {
      last.input = input;
      last.sent.push(resolve);
    } else if (last?.input.kind === 'scroll' && input.kind === 'scroll') {
      last.input = { ...input, dx: last.input.dx + input.dx, dy: last.input.dy + input.dy };
      last.sent.push(resolve);
    } else {
      waiting.push({ input, sent: [resolve] });
    }
    void pump();
  });
}
