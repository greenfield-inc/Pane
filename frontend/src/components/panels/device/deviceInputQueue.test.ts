import { describe, expect, it } from 'vitest';
import type { DeviceInput } from '../../../../../shared/types/devices';
import { deviceInputQueue } from './deviceInputQueue';

/** A link whose sends finish only when the test says, recording what arrived. */
function slowLink(failing: (input: DeviceInput) => boolean = () => false) {
  const arrived: DeviceInput[] = [];
  const finish: Array<() => void> = [];
  const send = (input: DeviceInput) => new Promise<void>((resolve, reject) => {
    arrived.push(input);
    finish.push(() => (failing(input) ? reject(new Error('lost')) : resolve()));
  });
  /** Lets every send on its way finish, one by one, until none is left. */
  const drain = async () => {
    for (let index = 0; index < 50; index++) {
      const next = finish.shift();
      if (!next) {
        await Promise.resolve();
        if (finish.length === 0) return;
        continue;
      }
      next();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  };
  return { arrived, send, drain };
}

const touch = (phase: 'begin' | 'move' | 'end', x: number): DeviceInput => ({ kind: 'touch', phase, x, y: 0.5 });

describe('deviceInputQueue', () => {
  it('sends a tap\'s start before its end, one at a time', async () => {
    const link = slowLink();
    const input = deviceInputQueue(link.send);
    input(touch('begin', 0.1));
    input(touch('end', 0.1));
    expect(link.arrived).toEqual([touch('begin', 0.1)]);
    await link.drain();
    expect(link.arrived).toEqual([touch('begin', 0.1), touch('end', 0.1)]);
  });

  it('merges a drag\'s waiting moves into the latest, and keeps every tap and key', async () => {
    const link = slowLink();
    const input = deviceInputQueue(link.send);
    input(touch('begin', 0.1));
    input(touch('move', 0.2));
    input(touch('move', 0.3));
    input(touch('move', 0.4));
    input(touch('end', 0.4));
    input({ kind: 'key', key: 'a' });
    await link.drain();
    expect(link.arrived).toEqual([touch('begin', 0.1), touch('move', 0.4), touch('end', 0.4), { kind: 'key', key: 'a' }]);
  });

  it('adds up scrolls that wait behind a send', async () => {
    const link = slowLink();
    const input = deviceInputQueue(link.send);
    input({ kind: 'button', button: 'home' });
    input({ kind: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 });
    input({ kind: 'scroll', x: 0.5, y: 0.6, dx: 0.05, dy: 0.2 });
    await link.drain();
    expect(link.arrived).toEqual([{ kind: 'button', button: 'home' }, { kind: 'scroll', x: 0.5, y: 0.6, dx: 0.05, dy: expect.closeTo(0.3) }]);
  });

  it('still sends what follows an input that failed, and reports each one sent', async () => {
    const link = slowLink(input => input.kind === 'touch' && input.phase === 'begin');
    const sent: DeviceInput[] = [];
    const input = deviceInputQueue(link.send, next => sent.push(next));
    input(touch('begin', 0.1));
    input(touch('end', 0.1));
    input({ kind: 'button', button: 'home' });
    await link.drain();
    expect(link.arrived).toHaveLength(3);
    expect(sent).toEqual(link.arrived);
  });
});
