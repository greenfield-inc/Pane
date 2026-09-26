import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { registerAppHandlers } from './app';
import { parseStoredBackgroundColors, WINDOW_BACKGROUND_COLORS_KEY } from '../utils/windowBackgroundColor';

interface TestIpcEvent { senderId?: number }
type Handler = (_event: TestIpcEvent, payload: PaneCommandValue) => PaneCommandValue | Promise<PaneCommandValue>;

describe('window background color IPC', () => {
  it('parses stored maps defensively', () => {
    expect(parseStoredBackgroundColors('garbage')).toEqual({});
    expect(parseStoredBackgroundColors(JSON.stringify({ folio: '#AABBCC', invalid: '#ffffff', forge: 'nope' }))).toEqual({ folio: '#aabbcc' });
  });

  it('validates, persists, and applies a theme color', async () => {
    const handlers = new Map<string, Handler>();
    const preferences = new Map<string, string>();
    const setBackgroundColor = vi.fn();
    const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
    const serviceFixture = {
      app: { getVersion: () => 'test', isPackaged: false },
      databaseService: {
        getUserPreference: (key: string) => preferences.get(key),
        setUserPreference: (key: string, value: string) => preferences.set(key, value),
      },
      getMainWindow: () => ({ isDestroyed: () => false, setBackgroundColor }),
    };
    // SAFETY: The fixture supplies the exact AppServices members read by these two registered handlers.
    const services = serviceFixture as AppServices;
    // SAFETY: The IpcMain stub captures handle registrations and matches the exercised handler signature.
    registerAppHandlers(ipcMain as IpcMain, services);
    const handler = handlers.get('window:set-background-color');
    expect(await handler?.({}, { theme: 'folio', color: '#AABBCC' })).toEqual({ success: true });
    expect(setBackgroundColor).toHaveBeenCalledWith('#aabbcc');
    expect(JSON.parse(preferences.get(WINDOW_BACKGROUND_COLORS_KEY) ?? '{}')).toEqual({ folio: '#aabbcc' });
    expect(await handler?.({}, { theme: 'forge', color: 'red' })).toEqual({ success: false, error: 'Invalid background color' });
  });

  it('returns a structured failure when stored colors cannot be read', () => {
    const handlers = new Map<string, Handler>();
    const setBackgroundColor = vi.fn();
    const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
    const serviceFixture = {
      app: { getVersion: () => 'test', isPackaged: false },
      databaseService: {
        getUserPreference: () => { throw new Error('background read failed'); },
        setUserPreference: vi.fn(),
      },
      getMainWindow: () => ({ isDestroyed: () => false, setBackgroundColor }),
    };
    // SAFETY: The fixture supplies the exact AppServices members read by the registered handler.
    registerAppHandlers(ipcMain as IpcMain, serviceFixture as AppServices);

    expect(handlers.get('window:set-background-color')?.({}, {
      theme: 'folio', color: '#aabbcc',
    })).toEqual({ success: false, error: 'background read failed' });
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it('returns a structured failure when the window rejects the color', () => {
    const handlers = new Map<string, Handler>();
    const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
    const serviceFixture = {
      app: { getVersion: () => 'test', isPackaged: false },
      databaseService: {
        getUserPreference: () => undefined,
        setUserPreference: vi.fn(),
      },
      getMainWindow: () => ({
        isDestroyed: () => false,
        setBackgroundColor: () => { throw new Error('background apply failed'); },
      }),
    };
    // SAFETY: The fixture supplies the exact AppServices members read by the registered handler.
    registerAppHandlers(ipcMain as IpcMain, serviceFixture as AppServices);

    expect(handlers.get('window:set-background-color')?.({}, {
      theme: 'forge', color: '#112233',
    })).toEqual({ success: false, error: 'background apply failed' });
  });
});

describe('external URL IPC', () => {
  it.each([
    ['https://example.test/path?q=1', true],
    ['http://localhost:3000/', true],
    ['mailto:team@example.test', true],
    ['file:///tmp/program.app', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hello', false],
    ['vscode://file/tmp/project', false],
    ['/tmp/program.app', false],
  ])('checks %s before handing it to the OS', async (url, allowed) => {
    const handlers = new Map<string, Handler>();
    const openExternal = vi.fn(async () => {});
    // SAFETY: Registering this handler needs only IpcMain.handle and no application service calls.
    const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as IpcMain;
    // SAFETY: openExternal uses its injected OS boundary and reads no application services.
    const services = {} as AppServices;
    registerAppHandlers(ipc, services, openExternal);
    expect(await handlers.get('openExternal')?.({}, url)).toMatchObject({ success: allowed });
    expect(openExternal.mock.calls).toEqual(allowed ? [[url]] : []);
  });
});
