import { afterEach, describe, expect, it, vi } from 'vitest';
import { Display, type Page } from '../src/display';
import { FakeBridge } from './fakeBridge';

function page(header: string, body: string, footerBrightness: 1 | 4 = 1): Page {
  return {
    boxes: [
      { kind: 'text', name: 'header', x: 0, y: 0, w: 576, h: 32, lines: [header] },
      { kind: 'text', name: 'body', x: 0, y: 36, w: 576, h: 220, lines: [body], capture: true },
      { kind: 'text', name: 'footer', x: 0, y: 256, w: 576, h: 32, lines: ['footer'], brightness: footerBrightness },
    ],
  };
}

const listPage: Page = {
  boxes: [
    { kind: 'text', name: 'header', x: 0, y: 0, w: 576, h: 32, lines: ['Open a Pane · pick a computer'] },
    { kind: 'list', name: 'computers', x: 0, y: 32, w: 576, h: 128, items: ['studio-mac', 'devbox'], capture: true },
  ],
};

describe('Display', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the startup page once, then upgrades only the text that changed', async () => {
    const bridge = new FakeBridge();
    const display = new Display(bridge);
    await display.show(page('1/2', 'first'));
    await display.show(page('1/2', 'second'));
    expect(bridge.calls.map((call) => call.method)).toEqual(['create', 'upgrade']);
    const upgrade = bridge.calls[1];
    expect(upgrade?.method === 'upgrade' && [upgrade.update.containerID, upgrade.update.containerName, upgrade.update.content]).toEqual([2, 'body', 'second']);
  });

  it('counts only real writes as writes, so a poll that changes nothing never blocks a swipe', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const display = new Display(new FakeBridge());
    vi.setSystemTime(1_000);
    await display.show(page('1/2', 'first'));
    vi.setSystemTime(5_000);
    await display.show(page('1/2', 'first'));
    expect(display.lastWriteAt).toBe(1_000);
    await display.show(page('1/2', 'second'));
    expect(display.lastWriteAt).toBe(5_000);
  });

  it('redraws a whole new screen at once, so no frame mixes the old body with the new header', async () => {
    const bridge = new FakeBridge();
    const display = new Display(bridge);
    await display.show(page('devbox · not allowed', 'Allow this app.', 4));
    await display.show(page('1/2 · needs you', 'Stub the clock?', 1));
    expect(bridge.calls.map((call) => call.method)).toEqual(['create', 'rebuild']);
  });

  it('upgrades a brightness change in place', async () => {
    const bridge = new FakeBridge();
    const display = new Display(bridge);
    await display.show(page('a', 'b', 1));
    await display.show(page('a', 'b', 4));
    const last = bridge.calls.at(-1);
    expect(last?.method === 'upgrade' && [last.update.containerName, last.update.textColor]).toEqual(['footer', 4]);
  });

  it('rebuilds when the layout changes', async () => {
    const bridge = new FakeBridge();
    const display = new Display(bridge);
    await display.show(page('a', 'b'));
    await display.show(listPage);
    expect(bridge.calls.map((call) => call.method)).toEqual(['create', 'rebuild']);
    const rebuild = bridge.calls[1];
    expect(rebuild?.method === 'rebuild' && rebuild.page.listObject?.[0]?.itemContainer?.itemName).toEqual(['studio-mac', 'devbox']);
    expect(rebuild?.method === 'rebuild' && rebuild.page.containerTotalNum).toBe(2);
  });

  it('sends only the newest of the pages shown while a write is in flight', async () => {
    const bridge = new FakeBridge();
    const display = new Display(bridge);
    void display.show(page('a', 'one'));
    void display.show(page('a', 'two'));
    await display.show(page('a', 'three'));
    expect(bridge.calls.map((call) => (call.method === 'upgrade' ? call.update.content : call.method))).toEqual(['create', 'three']);
  });

  it('refuses a page with no box for input', () => {
    const display = new Display(new FakeBridge());
    expect(() => display.show({ boxes: [{ kind: 'text', name: 'a', x: 0, y: 0, w: 10, h: 10, lines: [] }] })).toThrow('exactly one box');
  });
});
