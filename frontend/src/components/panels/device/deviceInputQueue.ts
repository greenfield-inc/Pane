import type { DeviceInput } from '../../../../../shared/types/devices';

/**
 * Sends a device tab's input one at a time, in the order the person made it, so a tap's end never
 * overtakes its start on a slow link. While one input is on its way, a drag's moves that wait
 * behind it merge into the latest, and scrolls add up, so input never queues up behind the link;
 * taps, buttons and keys are each sent. An input that fails is skipped and the rest still go.
 * `onSent` hears each input once it has been sent.
 */
export function deviceInputQueue(send: (input: DeviceInput) => Promise<void>, onSent?: (input: DeviceInput) => void): (input: DeviceInput) => void {
  const waiting: DeviceInput[] = [];
  let sending = false;
  const pump = async () => {
    if (sending) return;
    sending = true;
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      await send(next).catch(() => undefined);
      onSent?.(next);
    }
    sending = false;
  };
  return (input) => {
    const last = waiting.at(-1);
    if (last?.kind === 'touch' && last.phase === 'move' && input.kind === 'touch' && input.phase === 'move') waiting[waiting.length - 1] = input;
    else if (last?.kind === 'scroll' && input.kind === 'scroll') waiting[waiting.length - 1] = { ...input, dx: last.dx + input.dx, dy: last.dy + input.dy };
    else waiting.push(input);
    void pump();
  };
}
