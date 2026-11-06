import type { Project } from '../types/project';
import type { Session } from '../types/session';

export interface PaneTitle {
  /** Repository name, always present. */
  project: string;
  /** Pane name, or the worktree folder when the pane has no name. */
  pane: string;
}

/**
 * Builds the `<project> · <pane name>` title shown in the window title bar.
 * Returns null when there is nothing worth naming (no pane, or no project for it).
 */
export function resolvePaneTitle(
  session: Session | undefined,
  projects: Project[],
): PaneTitle | null {
  if (!session) return null;
  const project = projects.find(candidate => candidate.id === session.projectId);
  if (!project?.name) return null;

  // Pane names are set at creation, but fall back to the worktree folder (which
  // is also the branch name) so a nameless pane still says where it is.
  const worktreeFolder = session.worktreePath?.replace(/\\/g, '/').split('/').pop() || '';
  const pane = session.name?.trim() || worktreeFolder;
  return { project: project.name, pane };
}

/** Window title when no pane is open — matches the <title> in index.html. */
export const APP_WINDOW_TITLE = 'Pane';

/**
 * Joins a resolved title into the one-line form used by the title bar strip, its
 * hover text, and `document.title` — which is what names the window in the
 * Windows/Linux native title bar and in every platform's task switcher.
 */
export function formatPaneTitle(title: PaneTitle | null): string {
  if (!title) return APP_WINDOW_TITLE;
  return title.pane ? `${title.project} · ${title.pane}` : title.project;
}

export interface PaneStatusPill {
  key: 'pr' | 'branch';
  label: string;
  /** Badge variant — success reads as healthy, primary as merged, error as needs attention. */
  variant: 'success' | 'error' | 'primary';
  /** Full sentence for the hover tooltip — the pill itself stays terse. */
  tooltip: string;
}

function prStateLabel(prState: string | undefined): string {
  if (prState === 'MERGED') return 'merged';
  if (prState === 'CLOSED') return 'closed';
  return 'open';
}

/**
 * The handful of pane facts worth permanent space beside the title: whether a PR
 * exists and where it stands, and whether the branch needs attention right now.
 *
 * Deliberately excludes anything that churns while you work (diff counts, agent
 * activity) — the title is centered, so a pill that flickers drags the name with it.
 */
export function resolvePaneStatusPills(session: Session | undefined): PaneStatusPill[] {
  const gitStatus = session?.gitStatus;
  if (!gitStatus) return [];

  const pills: PaneStatusPill[] = [];
  const prState = gitStatus.prState?.toUpperCase();

  if (gitStatus.prNumber) {
    const stateLabel = prStateLabel(prState);
    pills.push({
      key: 'pr',
      label: `#${gitStatus.prNumber}`,
      variant: prState === 'MERGED' ? 'primary' : prState === 'CLOSED' ? 'error' : 'success',
      tooltip: gitStatus.prTitle
        ? `Pull request #${gitStatus.prNumber} (${stateLabel}) — ${gitStatus.prTitle}`
        : `Pull request #${gitStatus.prNumber} (${stateLabel})`,
    });
  }

  if (gitStatus.state === 'conflict') {
    pills.push({
      key: 'branch',
      label: 'Conflicts',
      variant: 'error',
      tooltip: 'This worktree has merge conflicts to resolve',
    });
  } else if (gitStatus.isReadyToMerge && prState !== 'MERGED' && prState !== 'CLOSED') {
    pills.push({
      key: 'branch',
      label: 'Ready to merge',
      variant: 'success',
      tooltip: 'Ahead of the base branch with nothing uncommitted',
    });
  }

  return pills;
}
