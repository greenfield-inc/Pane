import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';

const open = vi.fn();
const navigateToHostTerminal = vi.fn();
vi.mock('./api', () => ({ API: { hostTerminal: { open } } }));
// The real store reads localStorage at import; only the navigation call matters here.
vi.mock('../stores/navigationStore', () => ({ useNavigationStore: { getState: () => ({ navigateToHostTerminal }) } }));

const { getActiveRemoteProfile, getHostTerminalPresentation, openHostTerminal } = await import('./hostTerminal');
const { useHostTerminalStore } = await import('../stores/hostTerminalStore');

const devbox: RemotePaneConnectionProfile = {
  id: 'devbox-id',
  label: 'devbox',
  baseUrl: 'http://100.64.0.1:42137',
  token: 'token',
  transport: 'http+sse',
};

describe('getHostTerminalPresentation', () => {
  it('names a self-hosted remote with a server icon', () => {
    expect(getHostTerminalPresentation(devbox)).toEqual({
      hostName: 'devbox',
      icon: 'server',
      name: 'Terminal on devbox',
      tabTitle: 'devbox · Terminal',
      openLabel: 'Open terminal on devbox',
    });
  });

  it('uses the icon from the host kind', () => {
    const presentation = getHostTerminalPresentation({ label: 'testina', hostKind: { label: 'cloud sandbox', icon: 'cloud' } });
    expect(presentation).toMatchObject({ icon: 'cloud', name: 'Terminal on testina', tabTitle: 'testina · Terminal' });
  });
});

describe('getActiveRemoteProfile', () => {
  const remote = { mode: 'remote' as const, activeProfileId: 'devbox-id', activeProfileLabel: 'devbox' };

  it('is null on this computer', () => {
    expect(getActiveRemoteProfile({ ...remote, mode: 'local' }, [devbox])).toBeNull();
  });

  it('finds the active saved host', () => {
    expect(getActiveRemoteProfile(remote, [devbox])).toBe(devbox);
  });

  it('falls back to the connection label before profiles load', () => {
    expect(getActiveRemoteProfile(remote, [])).toEqual({ label: 'devbox' });
  });
});

describe('openHostTerminal', () => {
  beforeEach(() => {
    open.mockReset();
    useHostTerminalStore.setState({ terminal: null });
    navigateToHostTerminal.mockReset();
  });

  it('passes the text to type unchanged and shows the terminal', async () => {
    const terminal = { session: { id: '__host_terminal__' }, panel: { id: '__host_terminal_panel__' }, cwd: '/home/user', started: true };
    open.mockResolvedValue({ success: true, data: terminal });

    await openHostTerminal({ input: 'gh auth login --web --git-protocol https && gh auth setup-git' });

    expect(open).toHaveBeenCalledWith({ input: 'gh auth login --web --git-protocol https && gh auth setup-git' });
    expect(useHostTerminalStore.getState().terminal).toBe(terminal);
    expect(navigateToHostTerminal).toHaveBeenCalledTimes(1);
  });

  it('opens without typing anything when there is no input', async () => {
    open.mockResolvedValue({ success: true, data: { session: {}, panel: {}, cwd: '/home/user', started: true } });

    await openHostTerminal();

    expect(open).toHaveBeenCalledWith(undefined);
  });

  it('throws the host error and stays put when opening fails', async () => {
    open.mockResolvedValue({ success: false, error: 'Remote host is not connected' });

    await expect(openHostTerminal()).rejects.toThrow('Remote host is not connected');
    expect(navigateToHostTerminal).not.toHaveBeenCalled();
  });
});
