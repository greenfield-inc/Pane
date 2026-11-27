import { describe, expect, it } from 'vitest';
import { enterHeld, holdEnterUntilReleased } from './heldEnter';

// Node has no KeyboardEvent: an Event with the fields the guard reads.
const key = (type: 'keydown' | 'keyup', name: string, repeat = false) => Object.assign(new Event(type, { cancelable: true }), { key: name, shiftKey: true, repeat });

describe('holdEnterUntilReleased (T-88)', () => {
  it('swallows the held Enter\'s repeats until it comes up, then lets a fresh press through', () => {
    const target = new EventTarget();
    holdEnterUntilReleased(target);
    expect(enterHeld()).toBe(true);
    const repeat = key('keydown', 'Enter', true);
    target.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    // Other keys pass while Enter is held.
    target.dispatchEvent(key('keydown', 'a'));
    target.dispatchEvent(key('keyup', 'a'));
    expect(enterHeld()).toBe(true);
    target.dispatchEvent(key('keyup', 'Enter'));
    expect(enterHeld()).toBe(false);
    const fresh = key('keydown', 'Enter');
    target.dispatchEvent(fresh);
    expect(fresh.defaultPrevented).toBe(false);
  });

  it('a lost window focus ends the hold', () => {
    const target = new EventTarget();
    holdEnterUntilReleased(target);
    target.dispatchEvent(new Event('blur'));
    expect(enterHeld()).toBe(false);
  });
});
