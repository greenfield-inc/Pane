import { create } from 'zustand';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { queryClient } from '@/daemon/queryClient';
import { DEMO_PROFILE, resetDemoHost } from '@/features/demo/demoHost';

import { addHost, EMPTY_HOSTS, loadHosts, removeHost, saveHosts, type SavedHosts } from './hosts';
import { secureStore } from './secureStore';

interface HostsState extends SavedHosts {
  hydrated: boolean;
  /** "Try a demo" is on: the sample host is active. It lives in memory only, never in the Keychain. */
  demo: boolean;
  hydrate(): Promise<void>;
  /** Saves a verified pairing and makes it the active host. */
  add(profile: RemotePaneConnectionProfile): Promise<void>;
  /** Signs out of one host: its token is deleted from this device. */
  remove(id: string): Promise<void>;
  setActive(id: string): Promise<void>;
  startDemo(): void;
  exitDemo(): void;
}

export const useHostsStore = create<HostsState>((set, get) => {
  const commit = async (next: SavedHosts) => {
    const { profiles, activeId } = get();
    // Pairing or picking a real computer ends the demo.
    set({ ...next, demo: false });
    await saveHosts(secureStore, next, { profiles, activeId });
  };

  return {
    ...EMPTY_HOSTS,
    hydrated: false,
    demo: false,
    async hydrate() {
      const hosts = await loadHosts(secureStore).catch(() => EMPTY_HOSTS);
      set({ ...hosts, hydrated: true });
    },
    add: profile => commit(addHost(get(), profile)),
    remove: id => commit(removeHost(get(), id)),
    setActive: id => commit({ profiles: get().profiles, activeId: id }),
    startDemo: () => {
      // Every demo starts from the same sample data, with nothing cached from the last one.
      resetDemoHost();
      queryClient.removeQueries({ queryKey: [DEMO_PROFILE.id] });
      set({ demo: true });
    },
    exitDemo: () => set({ demo: false }),
  };
});

export function useActiveHost(): RemotePaneConnectionProfile | null {
  return useHostsStore(state => (state.demo ? DEMO_PROFILE : state.profiles.find(p => p.id === state.activeId) ?? null));
}
