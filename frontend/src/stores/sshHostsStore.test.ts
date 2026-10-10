import { describe, expect, it, vi } from 'vitest';
import { SSH_HOSTS_SESSION_ID } from '../../../shared/types/sshHosts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

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
  const [{ useSshHostsStore }, { useNavigationStore }, { usePanelStore }] = await Promise.all([
    import('./sshHostsStore'), import('./navigationStore'), import('./panelStore'),
  ]);
  useNavigationStore.setState({ activeView: 'project', activeProjectId: 7 });
  return { useSshHostsStore, useNavigationStore, usePanelStore };
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

  // The resync for a host change calls invalidateHostLoads() before any read, once per switch.
  it.each(late.flatMap(([kind, reply]) => [
    [kind, 'to another Pane', 1, reply] as const,
    [kind, 'away and back', 2, reply] as const,
  ]))('ignores a %s reply that arrives after the window switched %s', async (_kind, _route, switches, reply) => {
    const pending = deferred<OpenReply>();
    const stores = await setup(() => pending.promise);
    const { useSessionStore } = await import('./sessionStore');

    const opening = stores.useSshHostsStore.getState().open('mini');
    const { panelApi } = await import('../services/panelApi');
    for (let i = 0; i < switches; i += 1) panelApi.invalidateHostLoads();
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
