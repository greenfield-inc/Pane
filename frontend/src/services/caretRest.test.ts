import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCaretRest } from './caretRest';

function fakeRoot() {
  const classes = new Set<string>();
  return {
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
    resting: () => classes.has('caret-resting'),
  };
}

describe('startCaretRest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds the caret steady after 10 s without input and blinks again on a keypress', () => {
    const events = new EventTarget();
    const root = fakeRoot();
    startCaretRest(events, root);

    vi.advanceTimersByTime(9_999);
    expect(root.resting()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(root.resting()).toBe(true);

    events.dispatchEvent(new Event('keydown'));
    expect(root.resting()).toBe(false);
  });

  it('restarts the 10 s wait on every keypress', () => {
    const events = new EventTarget();
    const root = fakeRoot();
    startCaretRest(events, root);

    vi.advanceTimersByTime(8_000);
    events.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(8_000);
    expect(root.resting()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(root.resting()).toBe(true);
  });

  it('wakes the caret when a field is clicked or focused', () => {
    for (const type of ['pointerdown', 'focusin', 'input']) {
      const events = new EventTarget();
      const root = fakeRoot();
      startCaretRest(events, root);
      vi.advanceTimersByTime(10_000);
      events.dispatchEvent(new Event(type));
      expect(root.resting(), type).toBe(false);
    }
  });
});
