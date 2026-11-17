import WebSocket from 'ws';
import type { DeviceInput, DeviceStreamInfo } from '../../../../shared/types/devices';

/** The hub admits input on a socket by sending this one byte. */
const ADMITTED = 131;
const TOUCH = 3;
const BUTTON = 4;
const COMMIT = 17;
const IDLE_CLOSE_MS = 60_000;

/** `socket` is unset while Pane is still asking where the device's input goes. */
interface InputSocket { socket?: WebSocket; admitted: boolean; queue: Buffer[]; timer?: NodeJS.Timeout }

/** The JSON the hub reads after a touch or button byte. */
type InputBody = { type: 'begin' | 'move' | 'end'; x: number; y: number } | { button: 'home' | 'back' } | { type: 'home' | 'back' };

function frame(kind: number, body: InputBody): Buffer {
  return Buffer.concat([Buffer.from([kind]), Buffer.from(JSON.stringify(body))]);
}

/** The hub's wire messages for one input from the person's device tab. */
export function inputMessages(input: DeviceInput, platform: 'ios' | 'android'): Buffer[] {
  if (input.kind === 'touch') {
    const touch = frame(TOUCH, { type: input.phase, x: clamp(input.x), y: clamp(input.y) });
    return input.phase === 'end' ? [touch, Buffer.from([COMMIT])] : [touch];
  }
  if (input.kind === 'button') return [frame(BUTTON, platform === 'ios' ? { button: input.button } : { type: input.button })];
  return [];
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * One input socket per device, held in main so the hub token never reaches a renderer. Input
 * waits until the hub admits it; a socket idle for a minute closes.
 */
export class DeviceInputSockets {
  private readonly sockets = new Map<string, InputSocket>();

  /**
   * Sends `messages` to the device in order. The socket opens once per device, asking `stream`
   * where its input goes only then; messages wait in order until it is admitted.
   */
  send(deviceId: string, messages: Buffer[], stream: () => Promise<DeviceStreamInfo>): void {
    let entry = this.sockets.get(deviceId);
    const closed = entry?.socket && (entry.socket.readyState === WebSocket.CLOSED || entry.socket.readyState === WebSocket.CLOSING);
    if (!entry || closed) entry = this.open(deviceId, stream);
    for (const message of messages) {
      if (entry.admitted && entry.socket?.readyState === WebSocket.OPEN) entry.socket.send(message);
      else entry.queue.push(message);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.close(deviceId), IDLE_CLOSE_MS);
    entry.timer.unref();
  }

  close(deviceId: string): void {
    const entry = this.sockets.get(deviceId);
    if (!entry) return;
    this.sockets.delete(deviceId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.socket?.close();
  }

  closeAll(): void {
    for (const id of [...this.sockets.keys()]) this.close(id);
  }

  private open(deviceId: string, stream: () => Promise<DeviceStreamInfo>): InputSocket {
    const entry: InputSocket = { admitted: false, queue: [] };
    this.sockets.set(deviceId, entry);
    stream().then((info) => {
      if (this.sockets.get(deviceId) !== entry) return;
      const socket = new WebSocket(info.inputUrl, { headers: { Authorization: `Bearer ${info.token}` } });
      entry.socket = socket;
      socket.on('message', (data: Buffer) => {
        if (entry.admitted || data.length !== 1 || data[0] !== ADMITTED) return;
        entry.admitted = true;
        for (const message of entry.queue.splice(0)) socket.send(message);
      });
      socket.on('error', () => this.close(deviceId));
      socket.on('close', () => { if (this.sockets.get(deviceId) === entry) this.sockets.delete(deviceId); });
    }, () => this.close(deviceId));
    return entry;
  }
}
