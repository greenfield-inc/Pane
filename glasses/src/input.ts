// Adapted from GlanceCode (https://github.com/sousyllc/glancecode), MIT License, Copyright (c) 2026 Sousy LLC. See LICENSE.
// Turns Even Hub events into the gesture map: swipe, press, double press, hold and release.
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';

export type Gesture =
  | { type: 'press' }
  /** A press on a native list row. */
  | { type: 'select'; index: number }
  | { type: 'double' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'hold' }
  | { type: 'release' }
  | { type: 'audio'; pcm: Uint8Array }
  | { type: 'foreground' }
  | { type: 'background' }
  | { type: 'exit' };

/** A long swipe can arrive as several scroll events; they count as one until the ring is quiet this long. */
const SWIPE_QUIET_MS = 300;
/** Text updates can make the firmware report a boundary scroll right after a write. */
const PHANTOM_SCROLL_MS = 120;
/** The release of a long press can also arrive as a click. */
const RELEASE_CLICK_MS = 500;

function typeOf(envelope: { eventType?: OsEventTypeList } | undefined): OsEventTypeList | null {
  if (!envelope) return null;
  // A click is value 0, which protobuf omits: an envelope with no type is a click.
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT;
}

export class InputRouter {
  private lastScroll = { dir: '', at: 0 };
  private last = new Map<string, number>();
  private holding = false;
  private releasedAt = 0;

  constructor(
    private readonly emit: (gesture: Gesture) => void,
    private readonly lastDisplayWrite: () => number = () => 0,
    private readonly now: () => number = Date.now,
  ) {}

  handle(event: EvenHubEvent): void {
    if (event.audioEvent?.audioPcm) {
      this.emit({ type: 'audio', pcm: event.audioEvent.audioPcm });
      return;
    }
    const sys = typeOf(event.sysEvent);
    const text = typeOf(event.textEvent);
    const list = typeOf(event.listEvent);
    const type = [sys, text, list].find((value) => value !== null && value !== OsEventTypeList.CLICK_EVENT) ?? sys ?? text ?? list;
    if (type === null) return;
    const now = this.now();

    switch (type) {
      case OsEventTypeList.SCROLL_TOP_EVENT:
      case OsEventTypeList.SCROLL_BOTTOM_EVENT: {
        if (now - this.lastDisplayWrite() < PHANTOM_SCROLL_MS) return;
        const dir = type === OsEventTypeList.SCROLL_TOP_EVENT ? 'up' : 'down';
        const sameSwipe = this.lastScroll.dir === dir && now - this.lastScroll.at < SWIPE_QUIET_MS;
        this.lastScroll = { dir, at: now };
        if (!sameSwipe) this.emit({ type: dir });
        return;
      }
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        if (this.debounce('double', 350, now)) this.emit({ type: 'double' });
        return;
      case OsEventTypeList.LONG_PRESS_EVENT:
        if (!this.holding) {
          this.holding = true;
          this.emit({ type: 'hold' });
        }
        return;
      case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
        if (this.holding) {
          this.holding = false;
          this.releasedAt = now;
          this.emit({ type: 'release' });
        }
        return;
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        if (this.debounce('fg', 600, now)) this.emit({ type: 'foreground' });
        return;
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
        if (this.debounce('bg', 600, now)) this.emit({ type: 'background' });
        return;
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        this.emit({ type: 'exit' });
        return;
      case OsEventTypeList.CLICK_EVENT:
        if (now - this.releasedAt < RELEASE_CLICK_MS || !this.debounce('press', 250, now)) return;
        // A list press names its row; row 0 arrives without an index (protobuf omits 0).
        if (event.listEvent) this.emit({ type: 'select', index: event.listEvent.currentSelectItemIndex ?? 0 });
        else this.emit({ type: 'press' });
        return;
      default:
        return;
    }
  }

  private debounce(key: string, ms: number, now: number): boolean {
    if (now - (this.last.get(key) ?? -Infinity) < ms) return false;
    this.last.set(key, now);
    return true;
  }
}
