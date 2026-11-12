import { Menu, type IpcMain } from 'electron';
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

describe('context menu IPC', () => {
  function registerContextMenuHandler() {
    const handlers = new Map<string, (event: { sender: object }, entries: PaneCommandValue) => Promise<string | null>>();
    const ipcMain = { handle: (channel: string, handler: (event: { sender: object }, entries: PaneCommandValue) => Promise<string | null>) => handlers.set(channel, handler) };
    // SAFETY: The context menu handler reads no AppServices member.
    registerAppHandlers(ipcMain as IpcMain, { app: {} } as AppServices);
    return handlers.get('app:show-context-menu');
  }

  it('refuses a malformed menu before showing anything', () => {
    const buildFromTemplate = vi.mocked(Menu.buildFromTemplate);
    buildFromTemplate.mockClear();

    expect(() => registerContextMenuHandler()?.({ sender: {} }, [{ type: 'item', id: 'copy' }])).toThrow();
    expect(buildFromTemplate).not.toHaveBeenCalled();
  });

  it('shows a valid menu for the sending window', () => {
    const popup = vi.fn();
    // SAFETY: The handler reads only popup from the built menu.
    vi.mocked(Menu.buildFromTemplate).mockReturnValueOnce({ popup } as Electron.Menu);

    void registerContextMenuHandler()?.({ sender: {} }, [{ type: 'item', id: 'copy', label: 'Copy', enabled: true }]);

    expect(popup).toHaveBeenCalledOnce();
  });
});
