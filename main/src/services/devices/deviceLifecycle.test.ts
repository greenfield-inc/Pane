import { describe, expect, it } from 'vitest';
import { DeviceLifecycle, type DeviceRecord } from './deviceLifecycle';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function setup(cap = 1) {
  let now = Date.UTC(2026, 10, 15);
  const life = new DeviceLifecycle({ now: () => now, cap: () => cap });
  return { life, advance: (ms: number) => { now += ms; }, now: () => now };
}

const iphone = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({ id, platform: 'ios', name: 'Pane iPhone', paneMade: true, booted: false, ...extra });

describe('DeviceLifecycle', () => {
  it('gives a Pane a free Pane-made device, and the same device on its next open', () => {
    const { life } = setup();
    expect(life.pick('pane-a', 'ios', [iphone('D1')])).toEqual({ kind: 'device', id: 'D1' });
    life.lease('pane-a', 'D1');
    expect(life.pick('pane-a', 'ios', [iphone('D1')])).toEqual({ kind: 'device', id: 'D1' });
  });

  it('asks for a new device when the Pane has none and none exists', () => {
    const { life } = setup();
    expect(life.pick('pane-a', 'ios', [])).toEqual({ kind: 'create' });
  });

  it('tells a second Pane the device is busy and who holds it, at the default cap of one', () => {
    const { life } = setup();
    life.lease('pane-a', 'D1');
    expect(life.pick('pane-b', 'ios', [iphone('D1', { booted: true })])).toEqual({ kind: 'busy', holder: 'pane-a', id: 'D1' });
  });

  it('makes a second device for a second Pane when the cap allows two', () => {
    const { life } = setup(2);
    life.lease('pane-a', 'D1');
    expect(life.pick('pane-b', 'ios', [iphone('D1', { booted: true })])).toEqual({ kind: 'create' });
  });

  it('never picks the person\'s own devices on its own', () => {
    const { life } = setup();
    expect(life.pick('pane-a', 'ios', [iphone('MINE', { paneMade: false, booted: true })])).toEqual({ kind: 'create' });
  });

  it('counts only booted devices against the cap, so a shut-down Pane device is reused', () => {
    const { life } = setup();
    life.lease('pane-a', 'D1');
    life.release('pane-a', 'D1');
    expect(life.pick('pane-b', 'ios', [iphone('D1')])).toEqual({ kind: 'device', id: 'D1' });
  });

  it('moves the lease on take over and reports who lost it', () => {
    const { life } = setup();
    life.lease('pane-a', 'D1');
    expect(life.takeOver('pane-b', 'D1')).toBe('pane-a');
    expect(life.holderOf('D1')).toBe('pane-b');
    expect(life.leaseOf('pane-a', 'ios')).toBeUndefined();
  });

  it('ends a lease after 10 minutes with no calls and its tab off screen, and shuts the device down at once', () => {
    const { life, advance } = setup();
    life.lease('pane-a', 'D1');
    advance(9 * MINUTE);
    expect(life.sweep([iphone('D1', { booted: true })])).toEqual({ ended: [], shutdown: [] });
    advance(2 * MINUTE);
    expect(life.sweep([iphone('D1', { booted: true })])).toEqual({ ended: [{ paneId: 'pane-a', id: 'D1' }], shutdown: ['D1'] });
    expect(life.holderOf('D1')).toBeUndefined();
  });

  it('keeps a lease whose device tab is on screen, however long since the last call', () => {
    const { life, advance } = setup();
    life.lease('pane-a', 'D1');
    life.setVisible('pane-a', 'D1', 'client-1', true);
    advance(60 * MINUTE);
    expect(life.sweep([iphone('D1', { booted: true })]).ended).toEqual([]);
    life.setVisible('pane-a', 'D1', 'client-1', false);
    advance(11 * MINUTE);
    expect(life.sweep([iphone('D1', { booted: true })]).ended).toEqual([{ paneId: 'pane-a', id: 'D1' }]);
  });

  it('keeps a device warm for 10 minutes after device_close, then shuts it down', () => {
    const { life, advance } = setup();
    life.lease('pane-a', 'D1');
    life.release('pane-a', 'D1');
    advance(9 * MINUTE);
    expect(life.sweep([iphone('D1', { booted: true })]).shutdown).toEqual([]);
    advance(2 * MINUTE);
    expect(life.sweep([iphone('D1', { booted: true })]).shutdown).toEqual(['D1']);
  });

  it('shuts down a booted Pane device nobody leased, such as one left from an earlier run', () => {
    const { life, advance } = setup();
    expect(life.sweep([iphone('D1', { booted: true })]).shutdown).toEqual([]);
    advance(11 * MINUTE);
    expect(life.sweep([iphone('D1', { booted: true })]).shutdown).toEqual(['D1']);
  });

  it('leaves the person\'s own booted devices running unless Pane leased them', () => {
    const { life, advance } = setup();
    advance(60 * MINUTE);
    expect(life.sweep([iphone('MINE', { paneMade: false, booted: true })]).shutdown).toEqual([]);
  });

  it('erases a Pane-made device when the last Pane that used it is archived', () => {
    const { life } = setup();
    life.lease('pane-a', 'D1');
    life.release('pane-a', 'D1');
    life.lease('pane-b', 'D1');
    expect(life.archived('pane-a', [iphone('D1')])).toEqual({ erase: [], ended: [] });
    expect(life.archived('pane-b', [iphone('D1')])).toEqual({ erase: ['D1'], ended: [{ paneId: 'pane-b', id: 'D1' }] });
  });

  it('deletes Pane-made devices unused for 7 days, never the person\'s', () => {
    const { life, now } = setup();
    const old = now() - 8 * DAY;
    expect(life.stale([iphone('D1', { lastUsedAt: old }), iphone('MINE', { paneMade: false, lastUsedAt: old }), iphone('D2', { lastUsedAt: now() - DAY })])).toEqual(['D1']);
  });
});
