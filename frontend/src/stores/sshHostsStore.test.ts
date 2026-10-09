import { describe, expect, it, vi } from 'vitest';
import { SSH_HOSTS_SESSION_ID } from '../../../shared/types/sshHosts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

const profile = (id: string) => ({ id, label: id, baseUrl: `https://${id}.test`, token: 'token', transport: 'http+sse' });
const driving = (hostId: string) => ({
  remoteDaemon: { client: { mode: 'remote', activeProfileId: hostId, profiles: [profile('a'), profile('b')] } },
});

type OpenReply = { success: boolean; data?: { sessionId: string; panelId: string }; error?: string };

/** The Electron calls opening a host makes: the open itself and clearing the active Pane. */
function electronApi(open: () => Promise<OpenReply>) {
  return {
    sshHosts: { open, list: () => Promise.resolve({ success: true, data: { hosts: [], openHosts: [] } }) },
    invoke: () => Promise.resolve({ success: true }),
  };
}

async function setup(open: () => Promise<OpenReply>) {
  vi.resetModules();
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { electronAPI: electronApi(open), localStorage: storage });
  const [{ useSshHostsStore }, { useConfigStore }, { useNavigationStore }, { usePanelStore }] = await Promise.all([
    import('./sshHostsStore'), import('./configStore'), import('./navigationStore'), import('./panelStore'),
  ]);
  // SAFETY: The store reads only remoteDaemon from config.
  useConfigStore.setState({ config: driving('a') as never });
  useNavigationStore.setState({ activeView: 'project', activeProjectId: 7 });
  return { useSshHostsStore, useConfigStore, useNavigationStore, usePanelStore };
}

describe('opening an SSH host', () => {
  it('shows the tab when the reply comes from the Pane the click went to', async () => {
    const stores = await setup(() => Promise.resolve({ success: true, data: { sessionId: SSH_HOSTS_SESSION_ID, panelId: 'tab-a' } }));

    await stores.useSshHostsStore.getState().open('mini');

    expect(stores.useNavigationStore.getState().activeView).toBe('ssh');
    expect(stores.usePanelStore.getState().activePanels[SSH_HOSTS_SESSION_ID]).toBe('tab-a');
  });

  const late: Array<[string, OpenReply]> = [
    ['success', { success: true, data: { sessionId: SSH_HOSTS_SESSION_ID, panelId: 'old-tab' } }],
    ['failure', { success: false, error: 'old-error' }],
  ];

  it.each(late.flatMap(([kind, reply]) => [
    [kind, 'to another Pane', ['b'], reply] as const,
    [kind, 'away and back', ['b', 'a'], reply] as const,
  ]))('ignores a %s reply that arrives after the window switched %s', async (_kind, _route, route, reply) => {
    const pending = deferred<OpenReply>();
    const stores = await setup(() => pending.promise);
    const { useSessionStore } = await import('./sessionStore');

    const opening = stores.useSshHostsStore.getState().open('mini');
    for (const hostId of route) {
      // SAFETY: The store reads only remoteDaemon from config.
      stores.useConfigStore.setState({ config: driving(hostId) as never });
    }
    // What the user did on the Pane they ended on, before the old reply arrives.
    useSessionStore.setState({ activeSessionId: 'incoming-session' });
    stores.usePanelStore.getState().setActivePanel(SSH_HOSTS_SESSION_ID, 'incoming-tab');
    stores.useSshHostsStore.setState({ error: 'current-error' });
    pending.resolve(reply);
    await opening;

    expect(stores.useNavigationStore.getState()).toMatchObject({ activeView: 'project', activeProjectId: 7 });
    expect(useSessionStore.getState().activeSessionId).toBe('incoming-session');
    expect(stores.usePanelStore.getState().activePanels[SSH_HOSTS_SESSION_ID]).toBe('incoming-tab');
    expect(stores.useSshHostsStore.getState().error).toBe('current-error');
  });
});
