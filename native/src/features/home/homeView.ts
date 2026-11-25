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

const scrolls = new Map<string, { offset: number; headerSize: number | undefined }>();

/** How far down Home's list was on a machine (or All), and its header's height, for the remount a switch brings. */
export function homeScroll(place: string) {
  const scroll = scrolls.get(place) ?? { offset: 0, headerSize: undefined };
  scrolls.set(place, scroll);
  return scroll;
}
