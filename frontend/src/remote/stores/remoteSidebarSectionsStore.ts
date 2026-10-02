import { create } from 'zustand';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

export type RemoteSidebarSection = keyof SectionExpansion;

interface SectionExpansion {
  pinned: boolean;
  sessions: boolean;
  repositories: boolean;
  archived: boolean;
}

/** Per device, not per host: the sections stay as the person left them across hosts. */
const STORAGE_KEY = 'pane.remotePwa.sidebarSections';
const DEFAULT_EXPANSION: SectionExpansion = {
  pinned: true,
  sessions: true,
  repositories: true,
  archived: false,
};
const savedExpansionSchema = boundary.object({
  pinned: boundary.optional(boundary.boolean),
  sessions: boundary.optional(boundary.boolean),
  repositories: boundary.optional(boundary.boolean),
  archived: boundary.optional(boundary.boolean),
});

interface RemoteSidebarSectionsState {
  expanded: SectionExpansion;
  toggle: (section: RemoteSidebarSection) => void;
}

export const useRemoteSidebarSectionsStore = create<RemoteSidebarSectionsState>((set) => ({
  expanded: loadExpansion(),
  toggle: (section) => set((state) => {
    const expanded = { ...state.expanded, [section]: !state.expanded[section] };
    saveExpansion(expanded);
    return { expanded };
  }),
}));

function loadExpansion(): SectionExpansion {
  try {
    const saved = decodeOptionalBoundary(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}'), savedExpansionSchema);
    return {
      pinned: saved?.pinned ?? DEFAULT_EXPANSION.pinned,
      sessions: saved?.sessions ?? DEFAULT_EXPANSION.sessions,
      repositories: saved?.repositories ?? DEFAULT_EXPANSION.repositories,
      archived: saved?.archived ?? DEFAULT_EXPANSION.archived,
    };
  } catch {
    return DEFAULT_EXPANSION;
  }
}

function saveExpansion(expansion: SectionExpansion): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(expansion));
  } catch {
    // Storage can be unavailable (private mode); the sections still toggle for this visit.
  }
}
