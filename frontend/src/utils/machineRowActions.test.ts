import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineSelectOutcome } from '../hooks/useMachines';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

async function setup(switchMachine: (machineId: string) => Promise<MachineSelectOutcome>) {
  vi.resetModules();
  vi.stubGlobal('window', { electronAPI: { uiState: { saveNavigationMemory: vi.fn(async () => ({ success: true })) } } });
  const { useAllMachinesStore } = await import('../stores/allMachinesStore');
  const { useOrchestrationSessionStore } = await import('../stores/orchestrationSessionStore');
  const { openOnMachine } = await import('./machineRowActions');
  const { useErrorStore } = await import('../stores/errorStore');
  const { machineSwitchInFlight } = await import('../services/switchCursorHold');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  useAllMachinesStore.setState({
    entries: [
      { id: 'local', name: 'studio', os: 'macOS', slot: 0, letters: 'S', active: true },
      { id: 'build', name: 'build-box', os: 'Linux', slot: 1, letters: 'B', active: false },
      { id: 'mini', name: 'mac-mini', os: 'macOS', slot: 2, letters: 'M', active: false },
    ],
    machines: [],
    switchMachine,
  });
  const landOn = vi.spyOn(useOrchestrationSessionStore.getState(), 'landOn');
  const shownError = () => useErrorStore.getState().currentError;
  return { openOnMachine, landOn, shownError, machineSwitchInFlight };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openOnMachine (T-128)', () => {
  it('asks the switch to land on the pressed Session', async () => {
    const { openOnMachine, landOn } = await setup(async () => ({ ok: true }));

    await openOnMachine('build', { kind: 'session', id: 'release', name: 'Release' });

    expect(landOn).toHaveBeenCalledWith('release', { quiet: false });
    expect(landOn).not.toHaveBeenCalledWith(undefined);
  });

  it('drops the landing and says so when the switch fails', async () => {
    const { openOnMachine, landOn, shownError } = await setup(async () => ({ ok: false, error: 'build-box did not answer.' }));

    await openOnMachine('build', { kind: 'session', id: 'release', name: 'Release' });

    expect(landOn).toHaveBeenLastCalledWith(undefined);
    expect(shownError()).toMatchObject({ title: 'Could not open Release on build-box', error: 'build-box did not answer.' });
  });

  it('keeps a newer press\'s landing, and stays quiet, when the press it replaced fails', async () => {
    const first = deferred<MachineSelectOutcome>();
    const { openOnMachine, landOn, shownError } = await setup(machineId => (machineId === 'build' ? first.promise : Promise.resolve({ ok: true })));

    const older = openOnMachine('build', { kind: 'session', id: 'release', name: 'Release' });
    await openOnMachine('mini', { kind: 'session', id: 'notes', name: 'Notes' });
    first.resolve({ ok: false, error: 'superseded mid-way' });
    await older;

    expect(landOn).toHaveBeenLastCalledWith('notes', { quiet: false });
    expect(shownError()).toBeNull();
  });

  it('marks its switch in flight from the press, before any await, until the switch ends, so Enter can keep the cursor in the list', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const { openOnMachine, machineSwitchInFlight } = await setup(() => switched.promise);

    const opening = openOnMachine('build', { kind: 'session', id: 'release', name: 'Release' });
    expect(machineSwitchInFlight()).not.toBeNull();
    switched.resolve({ ok: true });
    await opening;
    expect(machineSwitchInFlight()).toBeNull();
  });
});
