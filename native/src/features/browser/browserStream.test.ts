import { describe, expect, it } from 'vitest';

import { KEYBOARD_EMPTY, keyboardEdit, PhoneControl } from './browserStream';

const backspace = { kind: 'key', key: 'Backspace', modifiers: 0 };

describe('keyboardEdit', () => {
  it('sends a typed letter as text', () => {
    expect(keyboardEdit('​', '​h')).toEqual({ input: [{ kind: 'text', text: 'h' }], next: '​h' });
  });

  it('hears Backspace in an empty field through the marker', () => {
    expect(keyboardEdit('​', '')).toEqual({ input: [backspace], next: '​' });
  });

  it('deletes the last character of typed text', () => {
    expect(keyboardEdit('​hi', '​h')).toEqual({ input: [backspace], next: '​h' });
  });

  it('turns an autocorrect replacement into Backspaces and the new word', () => {
    expect(keyboardEdit('​teh ', '​the ').input).toEqual([backspace, backspace, backspace, { kind: 'text', text: 'he ' }]);
  });

  it('counts an emoji as one character', () => {
    expect(keyboardEdit('​ok👍', '​ok').input).toEqual([backspace]);
  });

  it('sends nothing when only the marker comes back', () => {
    expect(keyboardEdit('', KEYBOARD_EMPTY).input).toEqual([]);
  });
});

describe('PhoneControl', () => {
  const phone = { size: { width: 390, height: 700, mobile: true } };
  const desktop = { size: undefined };

  it('takes control on the first touch and acts on the next', () => {
    const control = new PhoneControl();
    expect(control.touch()).toBe(true);
    expect(control.touch()).toBe(false);
  });

  it('keeps control while the host has not resized the page yet', () => {
    const control = new PhoneControl();
    control.touch();
    control.view(desktop);
    expect(control.touch()).toBe(false);
  });

  it('loses control when the page leaves the phone size', () => {
    const control = new PhoneControl();
    control.touch();
    control.view(phone);
    control.view(desktop);
    expect(control.touch()).toBe(true);
  });

  it('loses control when an agent starts driving', () => {
    const control = new PhoneControl();
    control.touch();
    control.view({ ...phone, driver: { by: 'person' } });
    control.view({ ...phone, driver: { by: 'agent', agent: 'Claude Code' } });
    expect(control.touch()).toBe(true);
  });
});
