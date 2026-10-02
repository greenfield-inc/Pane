import { create } from 'zustand';

import { secureStore } from '@/auth/secureStore';

import { DEFAULT_EXPANSION, type SectionExpansion, type SidebarSection } from './paneList';

/** Per device, not per host: the sections stay as the person left them across hosts. */
const STORAGE_KEY = 'pane.native.sidebarSections';

interface SidebarSectionsState {
  expanded: SectionExpansion;
  toggle(section: SidebarSection): void;
}

export const useSidebarSections = create<SidebarSectionsState>(set => ({
  expanded: DEFAULT_EXPANSION,
  toggle: section => set(state => {
    const expanded = { ...state.expanded, [section]: !state.expanded[section] };
    void secureStore.setItem(STORAGE_KEY, JSON.stringify(expanded)).catch(() => undefined);
    return { expanded };
  }),
}));

void secureStore.getItem(STORAGE_KEY).then(saved => {
  const parsed: unknown = saved ? JSON.parse(saved) : null;
  if (!parsed || typeof parsed !== 'object') return;
  const expanded = { ...DEFAULT_EXPANSION };
  for (const section of Object.keys(expanded) as SidebarSection[]) {
    const value = (parsed as Record<string, unknown>)[section];
    if (typeof value === 'boolean') expanded[section] = value;
  }
  useSidebarSections.setState({ expanded });
}).catch(() => undefined);
