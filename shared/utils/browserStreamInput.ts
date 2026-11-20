import type { BrowserInput, BrowserInputResult, BrowserTabView } from '../types/browserStream';
import type { DeviceDriver } from '../types/devices';

/** Where the frame is drawn inside its box: scaled to fit whole, centred (letterboxed). */
export interface FrameBox { left: number; top: number; width: number; height: number }

export function fitFrame(box: { width: number; height: number }, page: { width: number; height: number }): FrameBox {
  if (page.width <= 0 || page.height <= 0 || box.width <= 0 || box.height <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const width = page.width * scale;
  const height = page.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/**
 * The page point under a point in the box (both relative to the box's top left), or undefined in
 * the letterbox bars around the page.
 */
export function pagePoint(x: number, y: number, box: { width: number; height: number }, page: { width: number; height: number }): { x: number; y: number } | undefined {
  const drawn = fitFrame(box, page);
  if (drawn.width === 0) return undefined;
  const px = (x - drawn.left) / drawn.width;
  const py = (y - drawn.top) / drawn.height;
  if (px < 0 || py < 0 || px > 1 || py > 1) return undefined;
  return { x: Math.round(px * page.width * 100) / 100, y: Math.round(py * page.height * 100) / 100 };
}

/** Chromium's modifier bits from a DOM event: Alt 1, Control 2, Meta 4, Shift 8. */
export function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/**
 * Sends a screen's input to the host in order, one batch on the way at a time. Input made while a
 * batch travels waits and goes in the next one, so a click's release never overtakes its press on
 * a slow link; while waiting, pointer moves merge into the latest and wheel turns add up, so input
 * never queues behind the link. `onResult` hears each batch's answer (the focused field, copied text).
 */
export function browserInputQueue(send: (batch: BrowserInput[]) => Promise<BrowserInputResult>, onResult?: (result: BrowserInputResult) => void): (input: BrowserInput | null) => void {
  let waiting: BrowserInput[] = [];
  let sending = false;
  let takeControl = false;
  const pump = async () => {
    if (sending) return;
    sending = true;
    while (waiting.length > 0 || takeControl) {
      const batch = waiting;
      waiting = [];
      takeControl = false;
      // A refused batch is dropped; the next one still goes.
      const result = await send(batch).catch(() => undefined);
      if (result) onResult?.(result);
    }
    sending = false;
  };
  return (input) => {
    // null: take control without input (a phone's first tap).
    if (input === null) takeControl = true;
    else {
      const last = waiting.at(-1);
      if (last?.kind === 'mouse' && last.action === 'move' && input.kind === 'mouse' && input.action === 'move') waiting[waiting.length - 1] = input;
      else if (last?.kind === 'touch' && last.action === 'move' && input.kind === 'touch' && input.action === 'move') waiting[waiting.length - 1] = input;
      else if (last?.kind === 'wheel' && input.kind === 'wheel') waiting[waiting.length - 1] = { ...input, dx: last.dx + input.dx, dy: last.dy + input.dy };
      else waiting.push(input);
    }
    void pump();
  };
}

/** Presses closer together than this, in time and distance, count as a double or triple click. */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;

/**
 * Counts clicks the way the OS does, for pointer events (whose `detail` Chromium leaves at 0):
 * each press at about the same place soon after the last adds one, up to a triple click.
 */
export function clickCounter(): (x: number, y: number, at: number) => number {
  let last: { x: number; y: number; at: number; count: number } | undefined;
  return (x, y, at) => {
    const again = last !== undefined && at - last.at < MULTI_CLICK_MS && Math.hypot(x - last.x, y - last.y) <= MULTI_CLICK_PX;
    const count = again && last ? (last.count % 3) + 1 : 1;
    last = { x, y, at, count };
    return count;
  };
}

/** Enter, Tab or a navigation: the page may move focus by itself, to a password field in a two-step sign-in. */
export function movesFocus(input: BrowserInput | null): boolean {
  return (input?.kind === 'key' && (input.key === 'Enter' || input.key === 'Tab')) || input?.kind === 'navigate' || input?.kind === 'history';
}

/**
 * The field a screen's keyboard serves after a batch's answer. The answer to a batch that moves
 * focus can name the field before the page moves on (a sign-in answers Enter with the email field,
 * then focuses the password), so that answer keeps the keyboard secure; every other answer, and
 * "no field", is taken as given.
 */
export function keyboardField(batch: readonly BrowserInput[], answered: BrowserInputResult['field']): BrowserInputResult['field'] {
  return answered === 'text' && batch.some(movesFocus) ? 'password' : answered;
}

/**
 * Whether this phone (the app or the web app on a touch screen) controls the page. Its first touch only takes control (the page resizes to the
 * phone and gets its phone layout); later touches act. Control ends when the page leaves the phone's
 * size (another screen took it) or an agent starts driving.
 */
export class PhoneControl {
  private held = false;
  private sawPhoneSize = false;
  private lastDriver: DeviceDriver['by'] | undefined;

  /** A touch: true when it only takes control and must not act on the page. */
  touch(): boolean {
    if (this.held) return false;
    this.held = true;
    this.sawPhoneSize = false;
    return true;
  }

  /** The tab's newest state from the host. */
  view(view: Pick<BrowserTabView, 'size' | 'driver'>): void {
    const phoneSize = view.size?.mobile === true;
    const driver = view.driver?.by;
    if (driver === 'agent' && this.lastDriver !== 'agent') this.held = false;
    if (this.held && this.sawPhoneSize && !phoneSize) this.held = false;
    this.sawPhoneSize = phoneSize;
    this.lastDriver = driver;
  }
}
