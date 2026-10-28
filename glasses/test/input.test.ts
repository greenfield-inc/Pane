import { List_ItemEvent, OsEventTypeList, Sys_ItemEvent, Text_ItemEvent, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import { describe, expect, it } from 'vitest';
import { InputRouter, type Gesture } from '../src/input';

function router() {
  let now = 1_000;
  const gestures: Gesture['type'][] = [];
  const input = new InputRouter((gesture) => gestures.push(gesture.type === 'select' ? 'select' : gesture.type), () => 0, () => now);
  const send = (event: EvenHubEvent, at: number) => {
    now = at;
    input.handle(event);
  };
  return { gestures, send, input };
}

const scrollDown: EvenHubEvent = { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT }) };
const scrollUp: EvenHubEvent = { textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_TOP_EVENT }) };
// A click is value 0, which protobuf omits.
const click: EvenHubEvent = { sysEvent: new Sys_ItemEvent({}) };

describe('InputRouter', () => {
  it('turns one long swipe that arrives as several scroll events into one swipe', () => {
    const { gestures, send } = router();
    for (const at of [1_000, 1_080, 1_160, 1_240]) send(scrollDown, at);
    expect(gestures).toEqual(['down']);
  });

  it('counts two swipes with a pause between them as two', () => {
    const { gestures, send } = router();
    send(scrollDown, 1_000);
    send(scrollDown, 1_400);
    send(scrollUp, 1_450);
    expect(gestures).toEqual(['down', 'down', 'up']);
  });

  it('names the list row a press picked, row 0 included', () => {
    const picked: number[] = [];
    let now = 0;
    const input = new InputRouter((gesture) => {
      if (gesture.type === 'select') picked.push(gesture.index);
    }, () => 0, () => (now += 1_000));
    input.handle({ listEvent: new List_ItemEvent({ currentSelectItemIndex: 2 }) });
    input.handle({ listEvent: new List_ItemEvent({}) });
    expect(picked).toEqual([2, 0]);
  });

  it('maps hold and release, and ignores the click a release can bring', () => {
    const { gestures, send } = router();
    send({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_EVENT }) }, 1_000);
    send({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT }) }, 3_000);
    send(click, 3_100);
    send(click, 4_000);
    expect(gestures).toEqual(['hold', 'release', 'press']);
  });

  it('maps double press', () => {
    const { gestures, send } = router();
    send({ sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }) }, 1_000);
    expect(gestures).toEqual(['double']);
  });

  it('ignores a boundary scroll the firmware reports right after a text write', () => {
    const gestures: string[] = [];
    const input = new InputRouter((gesture) => gestures.push(gesture.type), () => 1_000, () => 1_050);
    input.handle(scrollDown);
    expect(gestures).toEqual([]);
  });
});
