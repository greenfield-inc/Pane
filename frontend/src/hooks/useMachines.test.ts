import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineSelectOutcome } from './useMachines';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a press of the machine the window is on (T-132, review 1781 R2-SF-1)', () => {
  it('stops a switch to another machine still running, so the older one never lands (latest wins, D-6)', async () => {
    vi.resetModules();
    const cancelSwitch = vi.fn(async () => ({ success: true, data: { cancelled: true } }));
    vi.stubGlobal('window', { electronAPI: { remoteDaemon: { cancelSwitch } } });
    const { requestMachinePress } = await import('./useMachines');
    let finish: (outcome: MachineSelectOutcome) => void = () => undefined;
    const toBuild = requestMachinePress({ id: 'build', kind: 'computer', action: 'switch', computerId: 'build-box' }, () => new Promise(resolve => { finish = resolve; }));
    const here = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const back = requestMachinePress({ id: 'studio', kind: 'computer', action: 'none', computerId: 'studio-mac' }, here);
    expect(cancelSwitch).toHaveBeenCalledWith('build-box');
    finish({ ok: false, error: 'The switch to Build Box was cancelled.' });
    expect(await toBuild).toMatchObject({ superseded: true });
    expect(await back).toMatchObject({ superseded: false, value: { ok: true } });
    // Nothing to switch to: the window is already there.
    expect(here).not.toHaveBeenCalled();
  });
});
