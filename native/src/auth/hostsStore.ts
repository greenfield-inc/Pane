import { AppState } from 'react-native';
import { create } from 'zustand';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { queryClient } from '@/daemon/queryClient';
import { createSavedState } from '@/daemon/savedState';
import { savedStateFiles } from '@/daemon/savedStateFiles';
import { DEMO_PROFILE, resetDemoHost } from '@/features/demo/demoHost';
import { useOpenedOnPhone } from '@/features/home/useOpenedOnPhone';
import { useOpenSessions } from '@/features/panes/useOpenSessions';
import { forgetKeptScreens } from '@/features/terminal/keptScreens';

import { addHost, addHosts, EMPTY_HOSTS, loadHosts, removeHost, saveHosts, type SavedHosts } from './hosts';
import { secureStore } from './secureStore';

interface HostsState extends SavedHosts {
  hydrated: boolean;
  /** "Try a demo" is on: the sample host is active. It lives in memory only, never in the Keychain. */
  demo: boolean;
  hydrate(): Promise<void>;
  /** Saves a verified pairing and makes it the active host. */
  add(profile: RemotePaneConnectionProfile): Promise<void>;
  /** Adds the computers the phone has not saved; `paired` (a scanned computer) replaces its entry and becomes active. */
  addMany(added: RemotePaneConnectionProfile[], paired?: RemotePaneConnectionProfile): Promise<void>;
  /** Signs out of one host: its token is deleted from this device. */
  remove(id: string): Promise<void>;
  setActive(id: string): Promise<void>;
  startDemo(): void;
  exitDemo(): void;
}

export const useHostsStore = create<HostsState>((set, get) => {
  // Saved computers keep their last-known lists on the phone; the demo never does.
  const savedState = createSavedState(queryClient, savedStateFiles, { saves: id => get().profiles.some(profile => profile.id === id) });
  // A change still waiting to be written goes to disk before the app can be killed in the background.
  AppState.addEventListener('change', status => {
    if (status === 'background') savedState.flush();
  });
  const commit = async (next: SavedHosts) => {
    const { profiles, activeId } = get();
    // A computer removed, signed out or paired again under a new id leaves no saved lists, open Sessions, opened Panes or terminal screens behind.
    for (const profile of profiles) {
      if (next.profiles.some(kept => kept.id === profile.id)) continue;
      savedState.forget(profile.id);
      useOpenSessions.getState().forget(profile.id);
      useOpenedOnPhone.getState().forget(profile.id);
      forgetKeptScreens(profile.id);
    }
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
      // Every saved computer's lists paint from the first frame, the current one's and All's.
      // Files of computers no longer saved (a backup restored, an older sign-out) are deleted.
      savedState.keepOnly(hosts.profiles.map(profile => profile.id));
      for (const profile of hosts.profiles) savedState.restore(profile.id);
      useOpenSessions.getState().restore(hosts.profiles.map(profile => profile.id));
      useOpenedOnPhone.getState().restore(hosts.profiles.map(profile => profile.id));
      set({ ...hosts, hydrated: true });
    },
    add: profile => commit(addHost(get(), profile)),
    addMany: (added, paired) => commit(addHosts(get(), added, paired)),
    remove: id => commit(removeHost(get(), id)),
    setActive: id => {
      // Lists dropped from memory since launch paint again from the file.
      savedState.restore(id);
      return commit({ profiles: get().profiles, activeId: id });
    },
    startDemo: () => {
      // Every demo starts from the same sample data, with nothing cached from the last one.
      resetDemoHost();
      useOpenSessions.getState().forget(DEMO_PROFILE.id);
      useOpenedOnPhone.getState().forget(DEMO_PROFILE.id);
      queryClient.removeQueries({ queryKey: [DEMO_PROFILE.id] });
      set({ demo: true });
    },
    exitDemo: () => set({ demo: false }),
  };
});

export function useActiveHost(): RemotePaneConnectionProfile | null {
  return useHostsStore(state => (state.demo ? DEMO_PROFILE : state.profiles.find(p => p.id === state.activeId) ?? null));
}
