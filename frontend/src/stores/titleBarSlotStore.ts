import { create } from 'zustand';

/**
 * Mount points inside the window title strip. WindowTitleBar registers them;
 * chrome that belongs on the title plane (the sidebar toggle, Session tabs,
 * and inspector controls) portals into them. Null when the platform keeps its
 * native title bar.
 *
 * `titleSlot` runs the other way: the pane tab bar shares the title strip's
 * row, so it offers its free space and WindowTitleBar portals the pane name
 * into it.
 */
interface TitleBarSlotState {
  trailingSlot: HTMLDivElement | null;
  setTrailingSlot: (element: HTMLDivElement | null) => void;
  sessionTabsSlot: HTMLDivElement | null;
  setSessionTabsSlot: (element: HTMLDivElement | null) => void;
  titleSlot: HTMLDivElement | null;
  /** Registers `element`, or with null releases `previous` if it is still the registered slot. */
  setTitleSlot: (element: HTMLDivElement | null, previous?: HTMLDivElement | null) => void;
}

export const useTitleBarSlotStore = create<TitleBarSlotState>((set) => ({
  trailingSlot: null,
  setTrailingSlot: (element) => set({ trailingSlot: element }),
  sessionTabsSlot: null,
  setSessionTabsSlot: (element) => set({ sessionTabsSlot: element }),
  titleSlot: null,
  setTitleSlot: (element, previous) => set((state) => {
    if (element) return { titleSlot: element };
    return state.titleSlot === previous ? { titleSlot: null } : state;
  }),
}));
