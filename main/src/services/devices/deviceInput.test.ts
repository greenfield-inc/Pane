import { describe, expect, it } from 'vitest';
import { inputMessages } from './deviceInput';

/** Each message as the hub reads it: its leading byte, then its JSON body. */
function decoded(messages: Buffer[]): { byte: number; body?: unknown }[] {
  return messages.map(message => (message.length === 1 ? { byte: message[0] } : { byte: message[0], body: JSON.parse(message.subarray(1).toString()) }));
}

// Bytes and bodies from serve-sim's input socket (vendor/serve-sim handleHidMessage): 6 key, 7 rotate, 11 scroll, 16 posture.
describe('inputMessages for a simulator', () => {
  it('turns the device with byte 7 and the hub orientation name', () => {
    expect(decoded(inputMessages({ kind: 'rotate', orientation: 'landscape_left' }, 'ios'))).toEqual([{ byte: 7, body: { orientation: 'landscape_left' } }]);
  });

  it('folds half open as the laptop pose, with a request id', () => {
    const [message] = decoded(inputMessages({ kind: 'fold', posture: 'half' }, 'ios'));
    expect(message).toMatchObject({ byte: 16, body: { command: { control: 'pose', value: 'laptop' } } });
  });

  it('types a capital letter as its HID key pressed and released with Shift', () => {
    expect(decoded(inputMessages({ kind: 'key', key: 'A' }, 'ios'))).toEqual([
      { byte: 6, body: { type: 'down', usage: 4, shifted: true } },
      { byte: 6, body: { type: 'up', usage: 4, shifted: true } },
    ]);
  });

  it('types Enter and a shifted symbol by their US keyboard usages, and ignores keys a phone has no use for', () => {
    expect(decoded(inputMessages({ kind: 'key', key: 'Enter' }, 'ios'))[0]).toEqual({ byte: 6, body: { type: 'down', usage: 40, shifted: false } });
    expect(decoded(inputMessages({ kind: 'key', key: '?' }, 'ios'))[0]).toEqual({ byte: 6, body: { type: 'down', usage: 56, shifted: true } });
    expect(inputMessages({ kind: 'key', key: 'F5' }, 'ios')).toEqual([]);
  });

  it('scrolls at a point by fractions of the screen', () => {
    expect(decoded(inputMessages({ kind: 'scroll', x: 0.5, y: 0.4, dx: 0, dy: 0.1 }, 'ios'))).toEqual([{ byte: 11, body: { x: 0.5, y: 0.4, dx: 0, dy: 0.1 } }]);
  });
});
