import type { Project } from '../types/project';
import type { Session } from '../types/session';
import type { SidebarNavigationScope } from '../stores/navigationStore';
import { comparePaneOrder } from '../../../shared/utils/paneOrder';

export interface PinnedSession {
  session: Session;
  /** Pane name. */
  label: string;
  repositoryName: string;
}

function getRepositoryName(projectName: string | undefined): string {
  return projectName?.split(/[\\/]/).filter(Boolean).pop() || 'Unknown';
}

function pinnedAtTime(session: Session): number {
  const pinnedAt = session.favoritePinnedAt
    ? new Date(session.favoritePinnedAt).getTime()
    : Number.NaN;
  if (!Number.isNaN(pinnedAt)) {
    return pinnedAt;
  }

  const createdAt = new Date(session.createdAt).getTime();
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

/** Each project's listed Panes, in the order their host saved (newest first until arranged). */
export function groupSessionsByProject(sessions: Session[]): Map<number, Session[]> {
  const map = new Map<number, Session[]>();

  sessions
    .filter(session => !session.archived && !session.isHidden)
    .forEach(session => {
      if (session.projectId == null) return;
      const list = map.get(session.projectId) || [];
      list.push(session);
      map.set(session.projectId, list);
    });

  map.forEach((list, key) => {
    map.set(key, list.slice().sort(comparePaneOrder));
  });

  return map;
}

export function createProjectById(projects: Project[]): Map<number, Project> {
  const map = new Map<number, Project>();
  projects.forEach(project => map.set(project.id, project));
  return map;
}

export function flattenSessionsByProjects(
  projects: Project[],
  sessionsByProject: Map<number, Session[]>,
  expandedProjects?: Set<number>
): Session[] {
  const result: Session[] = [];

  projects.forEach(project => {
    if (expandedProjects && !expandedProjects.has(project.id)) return;
    result.push(...(sessionsByProject.get(project.id) || []));
  });

  return result;
}

export function getPinnedSessions(
  sessions: Session[],
  projectById: Map<number, Project>,
  getProjectName?: (session: Session) => string | undefined
): PinnedSession[] {
  return sessions
    .filter(session => !session.archived && !session.isHidden && session.isFavorite)
    .map(session => {
      const projectName = getProjectName
        ? getProjectName(session)
        : session.projectId != null ? projectById.get(session.projectId)?.name : undefined;
      return {
        session,
        label: session.name || 'Untitled',
        repositoryName: getRepositoryName(projectName),
      };
    })
    .sort((a, b) => {
      const pinnedDiff = pinnedAtTime(b.session) - pinnedAtTime(a.session);
      if (pinnedDiff !== 0) return pinnedDiff;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
        || a.repositoryName.localeCompare(b.repositoryName, undefined, { sensitivity: 'base' });
    });
}

export function chooseSidebarCycleSessions(
  scope: SidebarNavigationScope,
  activeSessionId: string | null,
  pinnedSessions: Session[],
  visibleSessions: Session[],
  allActiveSessions: Session[]
): Session[] {
  if (
    scope === 'pinned' &&
    activeSessionId &&
    pinnedSessions.some(session => session.id === activeSessionId)
  ) {
    return pinnedSessions;
  }

  return visibleSessions.length > 0 ? visibleSessions : allActiveSessions;
}
