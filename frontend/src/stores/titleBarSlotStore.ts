import { create } from 'zustand';

/**
 * The mount point for global controls (Run, inspector, Session settings) at
 * the right end of the window title bar. WindowTitleBar registers it; views
 * portal their controls into it. Null when the platform keeps its native
 * title bar, in which case views render those controls in their own toolbar.
 */
interface TitleBarSlotState {
  trailingSlot: HTMLDivElement | null;
  setTrailingSlot: (element: HTMLDivElement | null) => void;
}

export const useTitleBarSlotStore = create<TitleBarSlotState>((set) => ({
  trailingSlot: null,
  setTrailingSlot: (element) => set({ trailingSlot: element }),
}));
