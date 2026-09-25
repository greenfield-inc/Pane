import type { AgentDisplayStatus } from '@shared/types/agentStatus';

/** The fields of `sessions:get-all-with-projects` the app reads (main/src/types/session.ts). */
export interface PaneSession {
  id: string;
  name: string;
  baseBranch?: string;
  isFavorite?: boolean;
  favoritePinnedAt?: string;
  archived?: boolean;
  isHidden?: boolean;
}

export interface ProjectWithPanes {
  id: number;
  name: string;
  sessions?: PaneSession[];
}

export interface PaneListEntry {
  id: string;
  name: string;
  projectId: number;
  projectName: string;
  baseBranch?: string;
  isFavorite: boolean;
  status: AgentDisplayStatus;
  agent?: string;
}

/** Where a row sits in its section, so it can round the right corners. */
export type RowPosition = 'only' | 'first' | 'middle' | 'last';

export type PaneListItem =
  | { type: 'section'; key: string; title: string }
  | { type: 'pane'; key: string; pane: PaneListEntry; position: RowPosition; inFavorites: boolean };

interface StatusLookup {
  status: (paneId: string) => AgentDisplayStatus;
  agent: (paneId: string) => string | undefined;
}

/**
 * Flattens projects into list rows: a Favorites section (pin order), then one
 * section per project with its remaining panes. `query` keeps panes whose
 * name, project or base branch contain every word.
 */
export function buildPaneList(projects: ProjectWithPanes[], query: string, lookup: StatusLookup): PaneListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const favorites: Array<PaneListEntry & { pinnedAt: string }> = [];
  const sections: Array<{ project: ProjectWithPanes; panes: PaneListEntry[] }> = [];

  for (const project of projects) {
    const panes: PaneListEntry[] = [];
    for (const session of project.sessions ?? []) {
      if (session.archived || session.isHidden) continue;
      const haystack = `${session.name} ${project.name} ${session.baseBranch ?? ''}`.toLowerCase();
      if (!words.every(word => haystack.includes(word))) continue;
      const entry: PaneListEntry = {
        id: session.id,
        name: session.name,
        projectId: project.id,
        projectName: project.name,
        baseBranch: session.baseBranch,
        isFavorite: Boolean(session.isFavorite),
        status: lookup.status(session.id),
        agent: lookup.agent(session.id),
      };
      if (entry.isFavorite) favorites.push({ ...entry, pinnedAt: session.favoritePinnedAt ?? '' });
      else panes.push(entry);
    }
    if (panes.length > 0) sections.push({ project, panes });
  }

  favorites.sort((a, b) => a.pinnedAt.localeCompare(b.pinnedAt));
  const items: PaneListItem[] = [];
  const pushSection = (key: string, title: string, panes: PaneListEntry[]) => {
    items.push({ type: 'section', key, title });
    panes.forEach((pane, index) => items.push({ type: 'pane', key: pane.id, pane, position: positionOf(index, panes.length), inFavorites: key === 'favorites' }));
  };
  if (favorites.length > 0) pushSection('favorites', 'Favorites', favorites.map(({ pinnedAt: _, ...pane }) => pane));
  for (const { project, panes } of sections) pushSection(`project-${project.id}`, project.name, panes);
  return items;
}

/** Optimistic copy of what `sessions:toggle-favorite` does on the host. */
export function toggleFavorite(projects: ProjectWithPanes[], paneId: string, now: string): ProjectWithPanes[] {
  return projects.map(project => ({
    ...project,
    sessions: project.sessions?.map(session => session.id !== paneId ? session : {
      ...session,
      isFavorite: !session.isFavorite,
      favoritePinnedAt: session.isFavorite ? undefined : now,
    }),
  }));
}

function positionOf(index: number, count: number): RowPosition {
  if (count === 1) return 'only';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'middle';
}
