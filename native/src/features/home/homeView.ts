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

/**
 * How far down one of Home's lists was, and its header's height, for the remount a switch brings.
 * `list` names the machine (or All), the tile and the row count, so a list that changed starts at the top.
 */
export function homeScroll(list: string) {
  const scroll = scrolls.get(list) ?? { offset: 0, headerSize: undefined };
  scrolls.set(list, scroll);
  return scroll;
}
