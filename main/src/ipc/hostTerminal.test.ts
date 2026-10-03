import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type { HostTerminalManager } from '../services/hostTerminalManager';
import { decodeHostTerminalOpenRequest, registerHostTerminalHandlers } from './hostTerminal';

function stub<Value>(value: Partial<Value>): Value {
  // SAFETY: Registration only reaches ipcMain.handle; the injected manager
  // means the handlers never touch the app services.
  return value as Value;
}

function register() {
  const registry = new PaneCommandRegistry();
  const open = vi.fn<HostTerminalManager['open']>(async () => stub<Awaited<ReturnType<HostTerminalManager['open']>>>({ cwd: '/home/user', started: true }));
  const get = vi.fn<HostTerminalManager['get']>(() => null);
  registerHostTerminalHandlers(stub<IpcMain>({ handle: vi.fn() }), stub<AppServices>({}), registry, { open, get });
  return { registry, open };
}

/** What a remote client's POST /invoke delivers: the args after a JSON round trip. */
function overInvoke(args: PaneCommandValue[]): PaneCommandValue[] {
  return JSON.parse(JSON.stringify(args));
}

describe('host-terminal:open', () => {
  it('opens with no argument, locally and through a remote /invoke', async () => {
    const { registry, open } = register();

    await expect(registry.invoke('host-terminal:open', [])).resolves.toMatchObject({ success: true });
    await expect(registry.invoke('host-terminal:open', overInvoke([undefined]))).resolves.toMatchObject({ success: true });

    expect(overInvoke([undefined])).toEqual([null]);
    expect(open.mock.calls).toEqual([[{}], [{}]]);
  });

  it('passes the saved host\'s environment through', async () => {
    const { registry, open } = register();

    await registry.invoke('host-terminal:open', overInvoke([{ env: [{ name: 'BROWSER', value: 'false' }] }]));

    expect(open).toHaveBeenCalledWith({ env: [{ name: 'BROWSER', value: 'false' }] });
  });

  it('passes the text to type through', async () => {
    const { registry, open } = register();

    await registry.invoke('host-terminal:open', overInvoke([{ input: 'gh auth login' }]));

    expect(open).toHaveBeenCalledWith({ input: 'gh auth login' });
  });

  it('answers a malformed request with an error', async () => {
    const { registry, open } = register();

    await expect(registry.invoke('host-terminal:open', [{ input: 42 }])).resolves.toMatchObject({ success: false });
    expect(open).not.toHaveBeenCalled();
  });
});

describe('decodeHostTerminalOpenRequest', () => {
  it('reads omitted, null and empty requests as "just open"', () => {
    expect(decodeHostTerminalOpenRequest(undefined)).toEqual({});
    expect(decodeHostTerminalOpenRequest(null)).toEqual({});
    expect(decodeHostTerminalOpenRequest({})).toEqual({});
  });

  it('rejects anything but an object with optional text', () => {
    expect(() => decodeHostTerminalOpenRequest({ input: 42 })).toThrow();
    expect(() => decodeHostTerminalOpenRequest('gh auth login')).toThrow();
  });
});
