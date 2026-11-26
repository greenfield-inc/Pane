import { create } from 'zustand';

import { secureStore } from '@/auth/secureStore';

import { DEFAULT_EXPANSION, type SectionExpansion, type SidebarSection } from './paneList';

/** Per device, not per host: the sections stay as the person left them across hosts. */
const STORAGE_KEY = 'pane.native.sidebarSections';

interface SidebarSectionsState {
  expanded: SectionExpansion;
  /** Pinned shows every row, past its preview. */
  allPinned: boolean;
  toggle(section: SidebarSection): void;
  toggleAllPinned(): void;
}

export const useSidebarSections = create<SidebarSectionsState>(set => ({
  expanded: DEFAULT_EXPANSION,
  allPinned: false,
  toggle: section => set(state => {
    const expanded = { ...state.expanded, [section]: !state.expanded[section] };
    save({ ...expanded, allPinned: state.allPinned });
    return { expanded };
  }),
  toggleAllPinned: () => set(state => {
    const allPinned = !state.allPinned;
    save({ ...state.expanded, allPinned });
    return { allPinned };
  }),
}));

function save(choices: SectionExpansion & { allPinned: boolean }) {
  void secureStore.setItem(STORAGE_KEY, JSON.stringify(choices)).catch(() => undefined);
}

void secureStore.getItem(STORAGE_KEY).then(saved => {
  const parsed: unknown = saved ? JSON.parse(saved) : null;
  if (!parsed || typeof parsed !== 'object') return;
  const expanded = { ...DEFAULT_EXPANSION };
  for (const section of Object.keys(expanded) as SidebarSection[]) {
    const value = (parsed as Record<string, unknown>)[section];
    if (typeof value === 'boolean') expanded[section] = value;
  }
  useSidebarSections.setState({ expanded, allPinned: (parsed as Record<string, unknown>).allPinned === true });
}).catch(() => undefined);
