import { EventEmitter } from 'events';

/**
 * How many remote event streams (a phone, another desktop, glasses) are open to this computer,
 * over its paired or its Tailscale transport. Emits `change` when the count changes.
 */
class RemoteEventStreams extends EventEmitter {
  private open = 0;

  add(): void {
    this.open += 1;
    this.emit('change');
  }

  remove(): void {
    this.open = Math.max(0, this.open - 1);
    this.emit('change');
  }

  count(): number {
    return this.open;
  }
}

export const remoteEventStreams = new RemoteEventStreams();
