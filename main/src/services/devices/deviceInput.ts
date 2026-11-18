import WebSocket from 'ws';
import type { DeviceInput, DeviceStreamInfo } from '../../../../shared/types/devices';

/** The hub admits input on a socket by sending this one byte. */
const ADMITTED = 131;
const TOUCH = 3;
const BUTTON = 4;
const KEY = 6;
const ROTATE = 7;
const SCROLL = 11;
const POSTURE = 16;
const COMMIT = 17;
/** One key in the hub's key message: its HID usage, whether Shift makes it, and the character it types. */
interface KeyPress { usage: number; shifted: boolean; key?: string }
/** HID usage of the left Shift key. */
const LEFT_SHIFT = 225;
/** The hub's pose for each posture the tab offers. */
const POSES = { closed: 'closed', half: 'laptop', open: 'open' } as const;
const IDLE_CLOSE_MS = 60_000;

/** `socket` is unset while Pane is still asking where the device's input goes. */
interface InputSocket { socket?: WebSocket; admitted: boolean; queue: Buffer[]; timer?: NodeJS.Timeout }

/** The JSON the hub reads after an input byte. */
type InputBody =
  | { type: 'begin' | 'move' | 'end'; x: number; y: number }
  | { button: 'home' | 'back' }
  | { type: 'home' | 'back' }
  | { type: 'down' | 'up'; usage: number; key?: string; shifted?: boolean }
  | { orientation: string }
  | { dx: number; dy: number; x: number; y: number }
  | { requestId: number; command: { control: 'pose'; value: string } };

/** USB HID keyboard usages (HID Usage Tables, page 7) for the keys a person types into a simulator. */
const NAMED_KEYS = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, ' ': 44, Delete: 76,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
} as const satisfies Record<string, number>;
/** Unshifted and shifted characters on a US keyboard, by usage. */
const CHARACTER_KEYS: [number, string, string][] = [
  [30, '1', '!'], [31, '2', '@'], [32, '3', '#'], [33, '4', '$'], [34, '5', '%'], [35, '6', '^'], [36, '7', '&'], [37, '8', '*'], [38, '9', '('], [39, '0', ')'],
  [45, '-', '_'], [46, '=', '+'], [47, '[', '{'], [48, ']', '}'], [49, '\\', '|'], [51, ';', ':'], [52, "'", '"'], [53, '`', '~'], [54, ',', '<'], [55, '.', '>'], [56, '/', '?'],
];

/** The HID usage for a KeyboardEvent key, and whether Shift makes it; undefined for keys a simulator has no use for. */
function hidKey(key: string): { usage: number; shifted: boolean } | undefined {
  const named = Object.entries(NAMED_KEYS).find(([name]) => name === key);
  if (named) return { usage: named[1], shifted: false };
  if (/^[a-z]$/.test(key)) return { usage: 4 + key.charCodeAt(0) - 97, shifted: false };
  if (/^[A-Z]$/.test(key)) return { usage: 4 + key.charCodeAt(0) - 65, shifted: true };
  for (const [usage, plain, shifted] of CHARACTER_KEYS) {
    if (key === plain) return { usage, shifted: false };
    if (key === shifted) return { usage, shifted: true };
  }
  return undefined;
}

let nextRequestId = 1;

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
  if (input.kind === 'rotate') return [frame(ROTATE, { orientation: input.orientation })];
  if (input.kind === 'fold') return [frame(POSTURE, { requestId: nextRequestId++, command: { control: 'pose', value: POSES[input.posture] } })];
  if (input.kind === 'scroll') return [frame(SCROLL, { x: clamp(input.x), y: clamp(input.y), dx: input.dx, dy: input.dy })];
  const key = hidKey(input.key);
  if (!key) return [];
  // `key` lets the hub type the character itself when the simulator has no hardware keyboard;
  // with one, Shift is pressed around the key so capitals and symbols arrive shifted.
  const press: KeyPress = { usage: key.usage, shifted: key.shifted };
  if (input.key.length === 1) press.key = input.key;
  const keyPress = [frame(KEY, { type: 'down', ...press }), frame(KEY, { type: 'up', ...press })];
  return key.shifted ? [frame(KEY, { type: 'down', usage: LEFT_SHIFT }), ...keyPress, frame(KEY, { type: 'up', usage: LEFT_SHIFT })] : keyPress;
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
