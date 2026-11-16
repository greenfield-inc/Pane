import os from 'os';
import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import type { DeviceMac } from '../../../../shared/types/devices';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { RemoteDevices, type MacDeviceRequest, type MacRoutes } from './remoteDevices';

/** Macs as the saved-computers list gives them; `answers` says how each Mac's Pane replies. */
function routes(macs: DeviceMac[], answers: Record<string, 'devices' | 'old' | 'no-xcode'>, pinned?: string) {
  const calls: { machineId: string; request: MacDeviceRequest }[] = [];
  const fake: MacRoutes = {
    macs: () => macs,
    pinned: () => pinned,
    self: () => ({ id: 'pc', name: 'DEVBOX' }),
    openPortStream: () => { throw new Error('not used'); },
    invoke: async (machineId, _channel, [request]): Promise<JsonValue> => {
      calls.push({ machineId, request });
      if (answers[machineId] === 'old') throw new Error('No handler registered for runpane:machine:devices');
      if (request.op === 'probe') return { ios: answers[machineId] === 'devices', android: false };
      return { device: { id: 'SIM', platform: 'ios', name: 'iPhone 17 Pro', os: 'iOS 27.0', machine: 'This Mac', state: 'booted', paneMade: true } };
    },
  };
  return { remote: new RemoteDevices(fake, os.tmpdir()), calls };
}

const mac = (id: string, name: string, online = true): DeviceMac => ({ id, name, online });

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (cause) {
    return cause instanceof PaneError ? cause.code : String(cause);
  }
}

describe('iOS on a linked Mac', () => {
  it('says how to link a Mac when none is saved', async () => {
    const { remote } = routes([], {});
    expect(await code(remote.open('pane', 'qa', 'ios', undefined))).toBe('ERR_DEVICE_NO_MAC');
  });

  it('picks the first online Mac with device support and says why', async () => {
    const { remote, calls } = routes([mac('old', 'Old Mac'), mac('off', 'Asleep', false), mac('mbp', 'MacBook Pro')], { old: 'old', mbp: 'devices' });
    const { lease } = await remote.open('pane', 'qa', 'ios', undefined);
    expect(lease).toMatchObject({ macId: 'mbp', macName: 'MacBook Pro', reason: 'automatic' });
    expect(calls.some(call => call.machineId === 'off')).toBe(false);
  });

  it('uses a pinned Mac, and fails rather than falling back when it is offline', async () => {
    const pinnedOnline = routes([mac('mbp', 'MacBook Pro'), mac('mini', 'Mac mini')], { mbp: 'devices', mini: 'devices' }, 'mini');
    expect((await pinnedOnline.remote.open('pane', 'qa', 'ios', undefined)).lease).toMatchObject({ macId: 'mini', reason: 'pinned' });
    const pinnedOffline = routes([mac('mbp', 'MacBook Pro'), mac('mini', 'Mac mini', false)], { mbp: 'devices', mini: 'devices' }, 'mini');
    expect(await code(pinnedOffline.remote.open('pane', 'qa', 'ios', undefined))).toBe('ERR_DEVICE_MAC_OFFLINE');
    expect(pinnedOffline.calls).toEqual([]);
  });

  it('names a Mac whose Pane has no device support', async () => {
    const { remote } = routes([mac('old', 'Old Mac')], { old: 'old' });
    expect(await code(remote.open('pane', 'qa', 'ios', undefined))).toBe('ERR_DEVICE_MAC_OUTDATED');
  });

  it('says the Macs are offline when none answers', async () => {
    const { remote } = routes([mac('mbp', 'MacBook Pro', false)], {});
    expect(await code(remote.open('pane', 'qa', 'ios', undefined))).toBe('ERR_DEVICE_MAC_OFFLINE');
  });
});
