import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let events: EventTarget;
let classes: Set<string>;

async function start(): Promise<void> {
  const { startCaretRest } = await import('./caretRest');
  startCaretRest();
}

const resting = () => classes.has('caret-resting');

describe('startCaretRest', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    events = new EventTarget();
    classes = new Set();
    vi.stubGlobal('window', events);
    vi.stubGlobal('document', {
      documentElement: {
        classList: { toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)) },
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('holds the caret steady after 10 s without input and blinks again on a keypress', async () => {
    await start();

    vi.advanceTimersByTime(9_999);
    expect(resting()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(resting()).toBe(true);

    events.dispatchEvent(new Event('keydown'));
    expect(resting()).toBe(false);
  });

  it('restarts the 10 s wait on every keypress', async () => {
    await start();

    vi.advanceTimersByTime(8_000);
    events.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(8_000);
    expect(resting()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(resting()).toBe(true);
  });

  it.each(['pointerdown', 'focusin', 'input'])('wakes the caret on %s', async (type) => {
    await start();
    vi.advanceTimersByTime(10_000);

    events.dispatchEvent(new Event(type));
    expect(resting()).toBe(false);
  });
});
