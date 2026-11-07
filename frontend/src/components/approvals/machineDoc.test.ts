import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { machineDocFailure, machineFileLinks, readMachineDoc } from './machineDoc';

const stubRead = (read: () => Promise<{ machineId: string; data: unknown }>) => {
  const spy = vi.fn(read);
  vi.stubGlobal('window', { electronAPI: { machines: { read: spy } } });
  return spy;
};
const item: NotifyItem = {
  id: 'mini:q7', machineId: 'mini', machine: 'Mac mini', ui: 'approve', title: 't', state: 'waiting', createdAt: 1,
  source: { name: 'x', agent: 'Claude' },
  links: [{ label: 'PR', url: 'https://x' }, { label: 'plan.html', path: '/a/plan.html' }],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('reading a linked document from its machine', () => {
  it('lists only the files', () => {
    expect(machineFileLinks(item)).toEqual([{ path: '/a/plan.html', label: 'plan.html' }]);
  });

  it('asks the machine for the file, with an html page inline', async () => {
    const read = stubRead(async () => ({ machineId: 'mini', data: { kind: 'text', text: 'hello', path: '/a' } }));
    expect(await readMachineDoc(item, '/a/plan.html')).toEqual({ kind: 'text', text: 'hello' });
    expect(read).toHaveBeenCalledWith('mini', 'autopilot:read-doc', ['/a/plan.html', { inline: true }]);
  });

  it('reads an html document only when its page came inline', async () => {
    stubRead(async () => ({ machineId: 'mini', data: { kind: 'html', url: 'file:///a', path: '/a', html: '<p>x</p>' } }));
    expect(await readMachineDoc(item, '/a/plan.html')).toEqual({ kind: 'html', html: '<p>x</p>' });
    stubRead(async () => ({ machineId: 'mini', data: { kind: 'html', url: 'file:///a', path: '/a' } }));
    expect(await readMachineDoc(item, '/a/plan.html')).toEqual({ kind: 'unreachable' });
  });

  it('tells a missing document from a machine it could not reach', async () => {
    stubRead(async () => ({ machineId: 'mini', data: { kind: 'missing', path: '/a', message: 'gone' } }));
    expect(await readMachineDoc(item, '/a/plan.html')).toEqual({ kind: 'missing' });
    stubRead(async () => { throw new Error('offline'); });
    expect(await readMachineDoc(item, '/a/plan.html')).toEqual({ kind: 'unreachable' });
    stubRead(async () => ({ machineId: 'mini', data: null }));
    expect(await readMachineDoc(item, '/a/plan.html')).toEqual({ kind: 'unreachable' });
  });

  it('stops waiting on a machine that never answers', async () => {
    vi.useFakeTimers();
    stubRead(() => new Promise(() => undefined));
    const reading = readMachineDoc(item, '/a/plan.html');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await reading).toEqual({ kind: 'unreachable' });
    vi.useRealTimers();
  });

  it('says a failure in one line', () => {
    expect(machineDocFailure({ kind: 'missing' }, 'plan.html', 'Mac mini')).toBe("plan.html isn't on Mac mini anymore");
    expect(machineDocFailure({ kind: 'unreachable' }, 'plan.html', 'Mac mini')).toBe("Couldn't reach Mac mini");
    expect(machineDocFailure({ kind: 'text', text: 'x' }, 'plan.html', 'Mac mini')).toBeUndefined();
  });
});
