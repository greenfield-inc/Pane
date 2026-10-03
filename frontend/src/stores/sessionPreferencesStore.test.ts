import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCResponse } from '../utils/api';
import type { SessionCreationPreferences } from './sessionPreferencesStore';

const api = {
  getSessionPreferences: vi.fn(),
  updateSessionPreferences: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('session preferences saves', () => {
  let store: typeof import('./sessionPreferencesStore').useSessionPreferencesStore;
  let initial: SessionCreationPreferences;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubGlobal('window', { electronAPI: { config: api } });
    store = (await import('./sessionPreferencesStore')).useSessionPreferencesStore;
    initial = store.getState().preferences;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps a newer edit visible when an older request fails, and saves in edit order', async () => {
    const first = deferred<IPCResponse<undefined>>();
    const second = deferred<IPCResponse<undefined>>();
    api.updateSessionPreferences.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstSave = store.getState().updatePreferences({ showAdvanced: true });
    const secondSave = store.getState().updatePreferences({ startPinned: true });
    await Promise.resolve();
    expect(api.updateSessionPreferences).toHaveBeenCalledTimes(1);
    expect(store.getState().preferences).toMatchObject({ showAdvanced: true, startPinned: true });

    first.resolve({ success: false, error: 'First write failed' });
    await firstSave;
    expect(api.updateSessionPreferences).toHaveBeenCalledTimes(2);
    expect(api.updateSessionPreferences.mock.calls[1][0]).toMatchObject({ showAdvanced: true, startPinned: true });
    expect(store.getState().preferences).toMatchObject({ showAdvanced: true, startPinned: true });
    expect(store.getState().error).toBeNull();

    second.resolve({ success: true });
    await secondSave;
    expect(store.getState().preferences).toMatchObject({ showAdvanced: true, startPinned: true });
  });

  it('rolls back to the last saved snapshot when the latest request fails', async () => {
    api.updateSessionPreferences.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('Offline'));
    const firstSave = store.getState().updatePreferences({ showAdvanced: true });
    const secondSave = store.getState().updatePreferences({ startPinned: true });
    await Promise.all([firstSave, secondSave]);
    expect(store.getState().preferences).toEqual({ ...initial, showAdvanced: true });
    expect(store.getState().error).toBe('Offline');
  });

  it('does not restore another failed optimistic edit when both requests fail', async () => {
    api.updateSessionPreferences.mockResolvedValue({ success: false, error: 'Offline' });
    await Promise.all([
      store.getState().updatePreferences({ showAdvanced: true }),
      store.getState().updatePreferences({ startPinned: true }),
    ]);
    expect(store.getState().preferences).toEqual(initial);
    expect(store.getState().error).toBe('Offline');
  });

  it('does not let an in-flight load overwrite a newer edit', async () => {
    const load = deferred<IPCResponse<SessionCreationPreferences>>();
    api.getSessionPreferences.mockReturnValue(load.promise);
    api.updateSessionPreferences.mockResolvedValue({ success: true });
    const loading = store.getState().loadPreferences();
    await Promise.resolve();
    await store.getState().updatePreferences({ startPinned: true, sessionCount: 4 });
    load.resolve({ success: true, data: initial });
    await loading;
    expect(store.getState().preferences).toEqual({ ...initial, startPinned: true });
    expect(api.updateSessionPreferences).toHaveBeenCalledWith({ ...initial, startPinned: true });
  });

  it('waits for pending saves before reloading preferences when a dialog reopens', async () => {
    const save = deferred<IPCResponse<undefined>>();
    api.updateSessionPreferences.mockReturnValue(save.promise);
    api.getSessionPreferences.mockResolvedValue({ success: true, data: { ...initial, startPinned: true } });
    const saving = store.getState().updatePreferences({ startPinned: true });
    const loading = store.getState().loadPreferences();
    await Promise.resolve();
    expect(api.getSessionPreferences).not.toHaveBeenCalled();
    save.resolve({ success: true });
    await Promise.all([saving, loading]);
    expect(store.getState().preferences.startPinned).toBe(true);
    expect(store.getState().isLoading).toBe(false);
  });

  it('keeps loading ownership with the newest read when an earlier read fails and an edit is saved', async () => {
    const first = deferred<IPCResponse<SessionCreationPreferences>>();
    const second = deferred<IPCResponse<SessionCreationPreferences>>();
    api.getSessionPreferences.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    api.updateSessionPreferences.mockResolvedValue({ success: true });
    const firstLoad = store.getState().loadPreferences();
    await Promise.resolve();
    const secondLoad = store.getState().loadPreferences();
    await Promise.resolve();
    await store.getState().updatePreferences({ startPinned: true });

    first.reject(new Error('Old read failed'));
    await firstLoad;
    expect(store.getState().isLoading).toBe(true);
    expect(store.getState().error).toBeNull();

    second.resolve({ success: true, data: initial });
    await secondLoad;
    expect(store.getState().isLoading).toBe(false);
    expect(store.getState().preferences.startPinned).toBe(true);
  });
});
