import type { AgentDisplayStatus } from '@shared/types/agentStatus';
import type { OrchestrationSessionRecord } from '@shared/types/orchestrationSession';

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
  /** The repository open on the desktop. */
  active?: boolean;
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

export type SidebarSection = 'pinned' | 'sessions' | 'repositories' | 'archived';
export type SectionExpansion = Record<SidebarSection, boolean>;

export const DEFAULT_EXPANSION: SectionExpansion = { pinned: true, sessions: true, repositories: true, archived: false };

export type SidebarItem =
  | { type: 'section'; key: string; section: SidebarSection; title: string; expanded: boolean; count?: number }
  | { type: 'repo'; key: string; projectId: number; title: string }
  | { type: 'pane'; key: string; pane: PaneListEntry; label: string; nested?: boolean }
  | {
    type: 'session';
    key: string;
    session: OrchestrationSessionRecord;
    label: string;
    paneCount: number;
    /** Identifies this row's nested panes; a pinned Session has a second, separate row. */
    nestedKey: string;
    nestedExpanded: boolean;
  }
  | { type: 'archived'; key: string; kind: 'session' | 'pane'; id: string; label: string; detail?: string }
  | { type: 'note'; key: string; text: string; danger?: boolean; retry?: 'sessions' | 'archived' };

interface StatusLookup {
  status: (paneId: string) => AgentDisplayStatus;
  agent: (paneId: string) => string | undefined;
}

export interface SidebarInput {
  projects: ProjectWithPanes[];
  /** `unavailable` on hosts without Sessions; undefined while they load. */
  sessions: OrchestrationSessionRecord[] | 'unavailable' | undefined;
  sessionsError?: string;
  archivedError?: string;
  /** Loaded the first time Archived opens; undefined until then. */
  archivedProjects: ProjectWithPanes[] | undefined;
  expanded: SectionExpansion;
  /** `nestedKey`s whose panes are hidden. */
  collapsedSessions: ReadonlySet<string>;
  query: string;
  lookup: StatusLookup;
}

/**
 * The PWA drawer's rows (frontend/src/remote/components/RemoteSidebar.tsx):
 * Pinned (Sessions, then panes newest pin first), Sessions with their panes
 * nested, Repositories with every pane, and Archived. A collapsed section keeps
 * its header. `query` keeps Sessions and panes whose names contain every word;
 * while searching, empty sections and repositories are left out, and nothing is
 * returned when no Session or pane matches.
 */
export function buildSidebar(input: SidebarInput): SidebarItem[] {
  const { expanded } = input;
  const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const matches = (text: string) => words.every(word => text.toLowerCase().includes(word));
  const sessionsSupported = input.sessions !== 'unavailable';
  const allSessions = Array.isArray(input.sessions) ? input.sessions : [];

  const paneById = new Map<string, PaneListEntry>();
  const repositories: Array<{ project: ProjectWithPanes; panes: PaneListEntry[] }> = [];
  const pinnedPanes: Array<{ pane: PaneListEntry; label: string; pinnedAt: string }> = [];
  for (const project of input.projects) {
    const panes: PaneListEntry[] = [];
    for (const session of project.sessions ?? []) {
      if (session.archived || session.isHidden) continue;
      const pane: PaneListEntry = {
        id: session.id,
        name: session.name,
        projectId: project.id,
        projectName: project.name,
        baseBranch: session.baseBranch,
        isFavorite: Boolean(session.isFavorite),
        status: input.lookup.status(session.id),
        agent: input.lookup.agent(session.id),
      };
      paneById.set(pane.id, pane);
      if (!matches(`${session.name} ${project.name} ${session.baseBranch ?? ''}`)) continue;
      panes.push(pane);
      if (pane.isFavorite) pinnedPanes.push({ pane, label: pinnedPaneLabel(project.name, pane.name), pinnedAt: session.favoritePinnedAt ?? '' });
    }
    if (panes.length > 0 || !searching) repositories.push({ project, panes });
  }
  pinnedPanes.sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const activeSessions = allSessions.filter(session => !session.archived && matches(session.name));
  const pinnedSessions = activeSessions.filter(session => session.isPinned);

  const sessionRows = (session: OrchestrationSessionRecord, placement: 'pinned' | 'sessions'): SidebarItem[] => {
    const panes = session.associations.flatMap(association => paneById.get(association.paneId) ?? []);
    const nestedKey = `${placement}:${session.id}`;
    const nestedExpanded = !input.collapsedSessions.has(nestedKey);
    return [
      { type: 'session', key: nestedKey, session, label: session.name || 'Untitled', paneCount: panes.length, nestedKey, nestedExpanded },
      ...(nestedExpanded ? panes.map(pane => ({ type: 'pane' as const, key: `${nestedKey}:${pane.id}`, pane, label: pane.name, nested: true })) : []),
    ];
  };
  const section = (name: SidebarSection, title: string, rows: () => SidebarItem[], count?: number): SidebarItem[] => [
    { type: 'section', key: `section-${name}`, section: name, title, expanded: expanded[name], count },
    ...(expanded[name] ? rows() : []),
  ];

  const items: SidebarItem[] = [];
  if (pinnedSessions.length + pinnedPanes.length > 0) {
    items.push(...section('pinned', 'Pinned', () => [
      ...pinnedSessions.flatMap(session => sessionRows(session, 'pinned')),
      ...pinnedPanes.map(({ pane, label }) => ({ type: 'pane' as const, key: `pinned-${pane.id}`, pane, label })),
    ]));
  }
  if (sessionsSupported && (!searching || activeSessions.length > 0)) {
    items.push(...section('sessions', 'Sessions', () => {
      if (input.sessionsError) return [{ type: 'note', key: 'sessions-error', text: input.sessionsError, danger: true, retry: 'sessions' }];
      if (Array.isArray(input.sessions) && activeSessions.length === 0) {
        return [{ type: 'note', key: 'sessions-empty', text: 'Create a Session to keep intent and discussion together.' }];
      }
      return activeSessions.flatMap(session => sessionRows(session, 'sessions'));
    }));
  }
  if (repositories.length > 0 || !searching) {
    items.push(...section('repositories', 'Repositories', () => repositories.flatMap(({ project, panes }) => [
      { type: 'repo' as const, key: `project-${project.id}`, projectId: project.id, title: project.name },
      ...panes.map(pane => ({ type: 'pane' as const, key: pane.id, pane, label: pane.name })),
    ])));
  }
  if (searching && items.length === 0) return [];

  const archivedSessions = allSessions
    .filter(session => session.archived && matches(session.name))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const archivedPanes = (input.archivedProjects ?? []).flatMap(project => (project.sessions ?? [])
    .filter(pane => matches(`${pane.name} ${project.name}`))
    .map(pane => ({ pane, project })));
  const archivedCount = input.archivedProjects ? archivedSessions.length + archivedPanes.length : undefined;
  items.push(...section('archived', 'Archived', () => {
    const errors: SidebarItem[] = input.archivedError ? [{ type: 'note', key: 'archived-error', text: input.archivedError, danger: true, retry: 'archived' }] : [];
    if (!input.archivedProjects && errors.length) return errors;
    if (!input.archivedProjects) return [{ type: 'note', key: 'archived-loading', text: 'Loading archived panes…' }];
    if (archivedCount === 0 && errors.length) return errors;
    if (archivedCount === 0) return [{ type: 'note', key: 'archived-empty', text: 'No archived panes' }];
    return [
      ...errors,
      ...archivedSessions.map(session => ({
        type: 'archived' as const, key: `archived-${session.id}`, kind: 'session' as const, id: session.id, label: session.name || 'Untitled',
      })),
      ...archivedPanes.map(({ pane, project }) => ({
        type: 'archived' as const, key: `archived-${pane.id}`, kind: 'pane' as const, id: pane.id, label: pane.name || 'Untitled', detail: project.name,
      })),
    ];
  }, archivedCount || undefined));
  return items;
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
