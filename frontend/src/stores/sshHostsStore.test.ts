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

  it.each<[string, OpenReply]>([
    ['success', { success: true, data: { sessionId: SSH_HOSTS_SESSION_ID, panelId: 'tab-a' } }],
    ['failure', { success: false, error: 'That host is no longer in your SSH config' }],
  ])('ignores a %s reply that arrives after the window switched to another Pane', async (_kind, reply) => {
    const pending = deferred<OpenReply>();
    const stores = await setup(() => pending.promise);

    const opening = stores.useSshHostsStore.getState().open('mini');
    // SAFETY: The store reads only remoteDaemon from config.
    stores.useConfigStore.setState({ config: driving('b') as never });
    pending.resolve(reply);
    await opening;

    expect(stores.useNavigationStore.getState()).toMatchObject({ activeView: 'project', activeProjectId: 7 });
    expect(stores.usePanelStore.getState().activePanels[SSH_HOSTS_SESSION_ID]).toBeUndefined();
    expect(stores.useSshHostsStore.getState().error).toBeNull();
  });
});
