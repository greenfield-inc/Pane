import type { AgentDisplayStatus } from '@shared/types/agentStatus';

/** The fields of `sessions:get-all-with-projects` the app reads (main/src/types/session.ts). */
interface PaneSession {
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

export type PaneListItem =
  | { type: 'section'; key: string; title: string; projectId?: number }
  | { type: 'pane'; key: string; pane: PaneListEntry; label: string };

interface StatusLookup {
  status: (paneId: string) => AgentDisplayStatus;
  agent: (paneId: string) => string | undefined;
}

/**
 * Flattens projects into list rows the way the PWA's drawer does: a Pinned
 * section (newest pin first), then every project with all its panes, pinned
 * ones included. `query` keeps panes whose name, project or base branch
 * contain every word; while searching, projects without a match are left out.
 */
export function buildPaneList(projects: ProjectWithPanes[], query: string, lookup: StatusLookup): PaneListItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pinned: Array<{ pane: PaneListEntry; label: string; pinnedAt: string }> = [];
  const sections: PaneListItem[] = [];

  for (const project of projects) {
    const panes: PaneListItem[] = [];
    for (const session of project.sessions ?? []) {
      if (session.archived || session.isHidden) continue;
      const haystack = `${session.name} ${project.name} ${session.baseBranch ?? ''}`.toLowerCase();
      if (!words.every(word => haystack.includes(word))) continue;
      const pane: PaneListEntry = {
        id: session.id,
        name: session.name,
        projectId: project.id,
        projectName: project.name,
        baseBranch: session.baseBranch,
        isFavorite: Boolean(session.isFavorite),
        status: lookup.status(session.id),
        agent: lookup.agent(session.id),
      };
      if (pane.isFavorite) pinned.push({ pane, label: pinnedPaneLabel(project.name, pane.name), pinnedAt: session.favoritePinnedAt ?? '' });
      panes.push({ type: 'pane', key: pane.id, pane, label: pane.name });
    }
    if (panes.length > 0 || words.length === 0) {
      sections.push({ type: 'section', key: `project-${project.id}`, title: project.name, projectId: project.id }, ...panes);
    }
  }

  pinned.sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  const pinnedItems: PaneListItem[] = pinned.length > 0
    ? [{ type: 'section', key: 'pinned', title: 'Pinned' }, ...pinned.map(({ pane, label }) => ({ type: 'pane' as const, key: `pinned-${pane.id}`, pane, label }))]
    : [];
  return [...pinnedItems, ...sections];
}

/** The PWA's pinned-row label: the project cut to six characters, then the pane. */
function pinnedPaneLabel(projectName: string, paneName: string): string {
  const project = projectName.length > 6 ? `${projectName.slice(0, 6)}...` : projectName;
  return `${project}/${paneName}`;
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

export function removePane(projects: ProjectWithPanes[], paneId: string): ProjectWithPanes[] {
  return projects.map(project => ({ ...project, sessions: project.sessions?.filter(session => session.id !== paneId) }));
}
