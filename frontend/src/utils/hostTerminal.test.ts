import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRemotePaneConnectionState, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

// The navigation store reads localStorage when it loads.
async function load() {
  vi.resetModules();
  vi.stubGlobal('localStorage', new MemoryStorage());
  const hostTerminal = await import('./hostTerminal');
  const { useHostTerminalStore } = await import('../stores/hostTerminalStore');
  const { useNavigationStore } = await import('../stores/navigationStore');
  return { ...hostTerminal, useHostTerminalStore, useNavigationStore };
}

const devbox: RemotePaneConnectionProfile = {
  id: 'devbox-id',
  label: 'devbox',
  baseUrl: 'http://100.64.0.1:42137',
  token: 'token',
  transport: 'http+sse',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getHostTerminalPresentation', () => {
  it('names a self-hosted remote with a server icon', async () => {
    const { getHostTerminalPresentation } = await load();
    expect(getHostTerminalPresentation(devbox)).toEqual({
      hostName: 'devbox',
      icon: 'server',
      name: 'Terminal on devbox',
      tabTitle: 'devbox · Terminal',
      openLabel: 'Open terminal on devbox',
    });
  });

  it('uses the icon from the host kind', async () => {
    const { getHostTerminalPresentation } = await load();
    const presentation = getHostTerminalPresentation({ label: 'testina', hostKind: { label: 'cloud sandbox', icon: 'cloud' } });
    expect(presentation).toMatchObject({ icon: 'cloud', name: 'Terminal on testina', tabTitle: 'testina · Terminal' });
  });
});

describe('getActiveRemoteProfile', () => {
  const remote = { mode: 'remote' as const, activeProfileId: 'devbox-id', activeProfileLabel: 'devbox' };

  it('is null on this computer', async () => {
    const { getActiveRemoteProfile } = await load();
    expect(getActiveRemoteProfile({ ...remote, mode: 'local' }, [devbox])).toBeNull();
  });

  it('finds the active saved host', async () => {
    const { getActiveRemoteProfile } = await load();
    expect(getActiveRemoteProfile(remote, [devbox])).toBe(devbox);
  });

  it('falls back to the connection label before profiles load', async () => {
    const { getActiveRemoteProfile } = await load();
    expect(getActiveRemoteProfile(remote, [])).toEqual({ label: 'devbox' });
  });
});

describe('openHostTerminal', () => {
  const open = vi.fn();
  const api = {
    hostTerminal: { open },
    remoteDaemon: {
      getConnectionState: vi.fn(async () => ({
        success: true,
        data: { ...createDefaultRemotePaneConnectionState(), mode: 'remote' as const, activeProfileId: 'devbox-id' },
      })),
    },
  };

  beforeEach(() => {
    open.mockReset();
  });

  it('passes the text to type unchanged and shows the terminal', async () => {
    const { openHostTerminal, useHostTerminalStore, useNavigationStore } = await load();
    const terminal = { session: { id: '__host_terminal__' }, panel: { id: '__host_terminal_panel__' }, cwd: '/home/user', started: true };
    open.mockResolvedValue({ success: true, data: terminal });

    await openHostTerminal({ input: 'gh auth login --web --git-protocol https && gh auth setup-git' }, api);

    expect(open).toHaveBeenCalledWith({ input: 'gh auth login --web --git-protocol https && gh auth setup-git' });
    expect(useHostTerminalStore.getState()).toMatchObject({ terminal, hostId: 'devbox-id' });
    expect(useNavigationStore.getState().activeView).toBe('host-terminal');
  });

  it('opens without typing anything when there is no input', async () => {
    const { openHostTerminal } = await load();
    open.mockResolvedValue({ success: true, data: { session: {}, panel: {}, cwd: '/home/user', started: true } });

    await openHostTerminal({}, api);

    expect(open).toHaveBeenCalledWith(undefined);
  });

  it('throws the host error and stays put when opening fails', async () => {
    const { openHostTerminal, useNavigationStore } = await load();
    open.mockResolvedValue({ success: false, error: 'Remote host is not connected' });

    await expect(openHostTerminal({}, api)).rejects.toThrow('Remote host is not connected');
    expect(useNavigationStore.getState().activeView).toBe('sessions');
  });
});
