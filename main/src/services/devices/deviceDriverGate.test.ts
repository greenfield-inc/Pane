import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import type { DeviceDriver } from '../../../../shared/types/devices';
import { DeviceDriverGate } from './deviceDriverGate';

function gate(saved: Record<string, DeviceDriver | undefined> = {}) {
  const drivers = new Map(Object.entries(saved));
  const shown: (DeviceDriver | undefined)[] = [];
  const devices = new DeviceDriverGate({
    read: tabId => drivers.get(tabId),
    write: async (tabId, driver) => { drivers.set(tabId, driver); shown.push(driver); },
    waitMs: 4 * 60_000,
    pollMs: 500,
    lingerMs: 2_000,
  });
  return { devices, drivers, shown };
}

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ran';
  } catch (cause) {
    return cause instanceof PaneError ? cause.code : String(cause);
  }
}

describe('DeviceDriverGate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the agent driving while its call runs, and clears the chip shortly after', async () => {
    const { devices, drivers } = gate();
    await devices.run('tab', 'Claude', undefined, async () => {
      expect(drivers.get('tab')).toEqual({ by: 'agent', agent: 'Claude' });
    });
    expect(drivers.get('tab')).toEqual({ by: 'agent', agent: 'Claude' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drivers.get('tab')).toBeUndefined();
  });

  it('holds an agent call while the person drives, names the agent waiting, and runs it once handed back', async () => {
    const { devices, drivers } = gate();
    await devices.set('tab', { by: 'person' });
    const work = vi.fn(async () => 'done');
    const call = devices.run('tab', 'Claude', undefined, work);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(work).not.toHaveBeenCalled();
    expect(drivers.get('tab')).toEqual({ by: 'person', agentWaiting: 'Claude' });
    await devices.set('tab', undefined);
    await vi.advanceTimersByTimeAsync(500);
    expect(await call).toBe('done');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('never runs a held call whose caller went away, and stops naming that agent as waiting', async () => {
    const { devices, drivers } = gate();
    await devices.set('tab', { by: 'person' });
    const work = vi.fn(async () => 'done');
    const caller = new AbortController();
    const call = code(devices.run('tab', 'Claude', caller.signal, work));
    await vi.advanceTimersByTimeAsync(1_000);
    caller.abort();
    expect(await call).toBe('ERR_DEVICE_CALL_CANCELLED');
    await devices.set('tab', undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(work).not.toHaveBeenCalled();
    expect(drivers.get('tab')).toBeUndefined();
  });

  it('gives up after its wait, before the CLI would, and says the person is driving', async () => {
    const { devices, drivers } = gate();
    await devices.set('tab', { by: 'person' });
    const work = vi.fn(async () => 'done');
    const call = code(devices.run('tab', 'Claude', undefined, work));
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1_000);
    expect(await call).toBe('ERR_DEVICE_PERSON_DRIVING');
    expect(work).not.toHaveBeenCalled();
    expect(drivers.get('tab')).toEqual({ by: 'person' });
  });

  it('drops a driver saved before Pane started, so it neither shows nor holds calls', async () => {
    const { devices, drivers } = gate({ tab: { by: 'person', agentWaiting: 'Claude' } });
    expect(await devices.driver('tab')).toBeUndefined();
    expect(await devices.run('tab', 'Claude', undefined, async () => 'done')).toBe('done');
    expect(drivers.get('tab')).toEqual({ by: 'agent', agent: 'Claude' });
  });

  it('keeps the chip while overlapping calls run, until the last one ends', async () => {
    const { devices, drivers } = gate();
    let finishFirst = () => {};
    const first = devices.run('tab', 'Claude', undefined, () => new Promise<void>(resolve => { finishFirst = resolve; }));
    await vi.advanceTimersByTimeAsync(0);
    const second = devices.run('tab', 'Claude', undefined, async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await second;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(drivers.get('tab')).toEqual({ by: 'agent', agent: 'Claude' });
    finishFirst();
    await first;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drivers.get('tab')).toBeUndefined();
  });
});
