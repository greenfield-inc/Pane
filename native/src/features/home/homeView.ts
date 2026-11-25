import { create } from 'zustand';

interface HomeViewState {
  query: string;
  setQuery(query: string): void;
}

/** Home's search. Switching machines remounts Home; the search stays, and a relaunch starts without one. */
export const useHomeView = create<HomeViewState>(set => ({
  query: '',
  setQuery: query => set({ query }),
}));

/** How far down Home's list was, per machine (or All), for the remount a switch brings. */
export const homeScroll = new Map<string, number>();
