import { describe, expect, it, vi } from 'vitest';
import type { ComputerUseEngine, EngineResult, EngineStatus } from './engine';
import { ComputerUseReadinessService, type ComputerUseReadinessDeps } from './readiness';
import type { AppConfig } from '../../types/config';

const NOW = 1_760_000_000_000;

function fakeEngine(initial: Partial<EngineStatus>, selfTestResult: EngineResult = { ok: true }) {
  let status: EngineStatus = { installed: true, permissions: { accessibility: true, screenRecording: true }, desktopSession: true, ...initial };
  const engine: ComputerUseEngine = {
    id: 'cua-driver',
    status: async () => status,
    call: async () => selfTestResult,
    stop: vi.fn(async () => {}),
  };
  return { engine, setStatus: (next: Partial<EngineStatus>) => { status = { ...status, ...next }; } };
}

function createService(engine: ComputerUseEngine, overrides: Partial<ComputerUseReadinessDeps> = {}) {
  let config: AppConfig['computerUse'] = {};
  const states: string[] = [];
  const deps: ComputerUseReadinessDeps = {
    getSetting: () => config,
    saveSetting: async (next) => { config = { ...config, ...next }; },
    engine: () => engine,
    install: vi.fn(async () => {}),
    selfTest: (target) => target.call('list_apps', {}),
    syncAgentSetup: vi.fn(),
    stopEngine: vi.fn(async () => {}),
    onChange: () => states.push(service.get().state),
    now: () => NOW,
    ...overrides,
  };
  const service = new ComputerUseReadinessService(deps);
  return { service, deps, states, config: () => config };
}

describe('ComputerUseReadinessService', () => {
  it('is off until turned on', () => {
    const { service } = createService(fakeEngine({}).engine);
    expect(service.get()).toEqual({ state: 'off', engineChoice: 'auto' });
  });

  it('installs a missing engine, then reports a missing permission naming the app to grant', async () => {
    const { engine, setStatus } = fakeEngine({ installed: false, permissions: {} });
    const install = vi.fn(async () => setStatus({ installed: true, permissions: { accessibility: true, screenRecording: false } }));
    const { service, states, deps } = createService(engine, { install });

    const result = await service.set({ enabled: true });

    expect(install).toHaveBeenCalledOnce();
    expect(states).toEqual(['installing', 'needs-permission']);
    expect(result).toEqual({ state: 'needs-permission', engineChoice: 'auto', permission: 'Screen Recording', appName: 'Cua Driver' });
    expect(deps.syncAgentSetup).toHaveBeenCalled();
    service.dispose();
  });

  it('becomes ready after the permission is granted and checked again', async () => {
    const { engine, setStatus } = fakeEngine({ permissions: { screenRecording: false, accessibility: true } });
    const { service } = createService(engine);
    await service.set({ enabled: true, engine: 'cua-driver' });

    setStatus({ permissions: { screenRecording: true, accessibility: true } });
    const result = await service.check();

    expect(result).toEqual({ state: 'ready', engineChoice: 'cua-driver', engine: 'cua-driver', checkedAt: NOW });
  });

  it('skips the install when the engine is already installed', async () => {
    const { service, deps, states } = createService(fakeEngine({}).engine);
    await service.set({ enabled: true });
    expect(deps.install).not.toHaveBeenCalled();
    expect(states).toEqual(['ready']);
  });

  it('reports no desktop session before checking permissions', async () => {
    const { service } = createService(fakeEngine({ desktopSession: false, permissions: { screenRecording: false } }).engine);
    expect((await service.set({ enabled: true })).state).toBe('no-desktop');
  });

  it('reports a failed install with its message', async () => {
    const { service } = createService(fakeEngine({ installed: false }).engine, {
      install: async () => { throw new Error('Checksum mismatch for cua-driver 0.4.2'); },
    });
    expect(await service.set({ enabled: true })).toEqual({
      state: 'failed', engineChoice: 'auto', step: 'install', detail: 'Checksum mismatch for cua-driver 0.4.2',
    });
  });

  it('reports a failed self-test with the engine error', async () => {
    const engine = fakeEngine({}, { ok: false, error: { code: 'timeout', message: 'list_apps timed out after 10 s' } }).engine;
    const { service } = createService(engine);
    expect(await service.set({ enabled: true })).toEqual({
      state: 'failed', engineChoice: 'auto', step: 'self-test', detail: 'list_apps timed out after 10 s',
    });
  });

  it('turning off saves the setting, stops the engine and removes the agent setup', async () => {
    const { service, deps, config } = createService(fakeEngine({}).engine);
    await service.set({ enabled: true });

    const result = await service.set({ enabled: false });

    expect(result).toEqual({ state: 'off', engineChoice: 'auto' });
    expect(config()).toEqual({ enabled: false });
    expect(deps.stopEngine).toHaveBeenCalledOnce();
    expect(deps.syncAgentSetup).toHaveBeenCalledTimes(2);
  });

  it('a check still running when computer use is turned off does not overwrite Off', async () => {
    const { engine, setStatus } = fakeEngine({ installed: false });
    let finishInstall = () => {};
    const install = () => new Promise<void>((resolve) => { finishInstall = () => { setStatus({ installed: true }); resolve(); }; });
    const { service } = createService(engine, { install });

    const enabling = service.set({ enabled: true });
    await vi.waitFor(() => expect(service.get().state).toBe('installing'));
    await service.set({ enabled: false });
    finishInstall();
    await enabling;

    expect(service.get().state).toBe('off');
  });

  it('turning on again during an install waits for the same install', async () => {
    const { engine, setStatus } = fakeEngine({ installed: false });
    let finishInstall = () => {};
    const install = vi.fn(() => new Promise<void>((resolve) => { finishInstall = () => { setStatus({ installed: true }); resolve(); }; }));
    const { service } = createService(engine, { install });

    const first = service.set({ enabled: true });
    await vi.waitFor(() => expect(service.get().state).toBe('installing'));
    await service.set({ enabled: false });
    const second = service.set({ enabled: true });
    await vi.waitFor(() => expect(service.get().state).toBe('installing'));
    finishInstall();
    await Promise.all([first, second]);

    expect(install).toHaveBeenCalledOnce();
    expect(service.get().state).toBe('ready');
  });

  it('a check overtaken by turning off runs no self-test', async () => {
    let releaseStatus = () => {};
    const selfTest = vi.fn(async () => ({ ok: true }));
    const engine: ComputerUseEngine = {
      id: 'cua-driver',
      status: () => new Promise<EngineStatus>((resolve) => {
        releaseStatus = () => resolve({ installed: true, permissions: {}, desktopSession: true });
      }),
      call: async () => ({ ok: true }),
      stop: async () => {},
    };
    const { service } = createService(engine, { selfTest });

    const enabling = service.set({ enabled: true });
    await vi.waitFor(() => expect(releaseStatus).not.toBe(undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.set({ enabled: false });
    releaseStatus();
    await enabling;

    expect(selfTest).not.toHaveBeenCalled();
    expect(service.get().state).toBe('off');
  });

  it('checks on daemon start only when the saved setting is on', async () => {
    const { service, deps } = createService(fakeEngine({}).engine, { getSetting: () => ({ enabled: true }) });
    await service.start();
    expect(service.get().state).toBe('ready');

    const off = createService(fakeEngine({}).engine);
    await off.service.start();
    expect(off.deps.syncAgentSetup).not.toHaveBeenCalled();
    expect(deps.syncAgentSetup).toHaveBeenCalledOnce();
  });

  it('rechecks on its own while waiting for a permission', async () => {
    vi.useFakeTimers();
    try {
      const { engine, setStatus } = fakeEngine({ permissions: { accessibility: false, screenRecording: true } });
      const { service } = createService(engine);
      expect(await service.set({ enabled: true })).toMatchObject({ state: 'needs-permission', permission: 'Accessibility' });

      setStatus({ permissions: { accessibility: true, screenRecording: true } });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(service.get().state).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });
});
