import { create } from 'zustand';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { addHost, EMPTY_HOSTS, loadHosts, removeHost, saveHosts, type SavedHosts } from './hosts';
import { secureStore } from './secureStore';

interface HostsState extends SavedHosts {
  hydrated: boolean;
  hydrate(): Promise<void>;
  /** Saves a verified pairing and makes it the active host. */
  add(profile: RemotePaneConnectionProfile): Promise<void>;
  /** Signs out of one host: its token is deleted from this device. */
  remove(id: string): Promise<void>;
  setActive(id: string): Promise<void>;
}

export const useHostsStore = create<HostsState>((set, get) => {
  const commit = async (next: SavedHosts) => {
    const { profiles, activeId } = get();
    set(next);
    await saveHosts(secureStore, next, { profiles, activeId });
  };

  return {
    ...EMPTY_HOSTS,
    hydrated: false,
    async hydrate() {
      const hosts = await loadHosts(secureStore).catch(() => EMPTY_HOSTS);
      set({ ...hosts, hydrated: true });
    },
    add: profile => commit(addHost(get(), profile)),
    remove: id => commit(removeHost(get(), id)),
    setActive: id => commit({ profiles: get().profiles, activeId: id }),
  };
});

export function useActiveHost(): RemotePaneConnectionProfile | null {
  return useHostsStore(state => state.profiles.find(p => p.id === state.activeId) ?? null);
}
