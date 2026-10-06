import { afterEach, expect, it, vi } from 'vitest';
import type { AppConfig, UpdateConfigRequest } from '../types/config';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function logger(environment: 'production' | 'development') {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', environment);
  let persisted: AppConfig = { verbose: false };
  vi.stubGlobal('window', { electronAPI: { config: {
    get: async () => ({ success: true, data: persisted }),
    update: async (updates: UpdateConfigRequest) => {
      persisted = { ...persisted, ...updates };
      return { success: true, data: persisted };
    },
  } } });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const { useConfigStore } = await import('../stores/configStore');
  const { devLog, renderLog } = await import('./console');
  await useConfigStore.getState().fetchConfig();
  const write = () => {
    devLog.log('normal', { paneId: 'pane-1' });
    devLog.warn('warning');
    devLog.error('failure');
    devLog.debug('debug');
    devLog.info('information');
    renderLog('render');
  };
  return { log, warn, error, debug, info, write, update: useConfigStore.getState().updateConfig };
}

it('uses persisted verbose changes immediately for every optional production logging level', async () => {
  const sink = await logger('production');
  sink.write();
  expect(sink.log).not.toHaveBeenCalled();
  expect(sink.warn).not.toHaveBeenCalled();
  expect(sink.debug).not.toHaveBeenCalled();
  expect(sink.info).not.toHaveBeenCalled();
  expect(sink.error).toHaveBeenCalledWith('failure');

  await sink.update({ verbose: true });
  sink.write();
  expect(sink.log.mock.calls).toEqual([['normal', { paneId: 'pane-1' }], ['render']]);
  expect(sink.warn).toHaveBeenCalledWith('warning');
  expect(sink.debug).toHaveBeenCalledWith('debug');
  expect(sink.info).toHaveBeenCalledWith('information');

  await sink.update({ verbose: false });
  sink.write();
  expect(sink.log).toHaveBeenCalledTimes(2);
  expect(sink.warn).toHaveBeenCalledTimes(1);
  expect(sink.debug).toHaveBeenCalledTimes(1);
  expect(sink.info).toHaveBeenCalledTimes(1);
  expect(sink.error).toHaveBeenCalledTimes(3);
});

it('keeps development logging enabled when verbose is off', async () => {
  const sink = await logger('development');
  sink.write();
  expect(sink.log.mock.calls).toEqual([['normal', { paneId: 'pane-1' }], ['render']]);
  expect(sink.warn).toHaveBeenCalledWith('warning');
  expect(sink.debug).toHaveBeenCalledWith('debug');
  expect(sink.info).toHaveBeenCalledWith('information');
  expect(sink.error).toHaveBeenCalledWith('failure');
});
