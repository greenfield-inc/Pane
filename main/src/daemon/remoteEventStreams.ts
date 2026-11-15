import { EventEmitter } from 'events';

/**
 * How many remote event streams that show this computer to a person (a phone, a desktop in remote
 * mode, glasses) are open, over its paired or its Tailscale transport. A saved machine's Notify
 * stream is not counted. Emits `change` when the count changes.
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
