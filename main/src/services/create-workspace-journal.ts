import { WorkspaceJournal } from './workspaceJournal';
import type { SessionManager } from './sessionManager';
import type { panelManager as panelManagerInstance } from './panelManager';
import type { TerminalPanelManager } from './terminalPanelManager';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

/** Build the daemon journal from the same live session and terminal sources in every host. */
export function createWorkspaceJournal(
  sessionManager: Pick<SessionManager, 'getSession' | 'getProjectForSession' | 'getAllSessions'>,
  panelManager: Pick<typeof panelManagerInstance, 'getPanel'>,
  terminalPanelManager: Pick<TerminalPanelManager, 'getTerminalSnapshot'>,
): WorkspaceJournal {
  const journal = new WorkspaceJournal({
    resolvePane: (paneId) => {
      const session = sessionManager.getSession(paneId);
      if (!session) return undefined;
      const project = sessionManager.getProjectForSession(paneId);
      return {
        paneId,
        paneName: session.name,
        repoId: project?.id,
        repoName: project?.name,
        worktreePath: session.worktreePath,
      };
    },
    resolvePanel: (panelId) => {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return undefined;
      const snapshot = terminalPanelManager.getTerminalSnapshot(panelId);
      const customState = decodeBoundary(panel.state.customState ?? {}, boundary.object({
        agentType: boundary.optional(boundary.string),
        isCliPanel: boundary.optional(boundary.boolean),
      }));
      return {
        panelId,
        paneId: panel.sessionId,
        isCliPanel: snapshot?.isCliPanel ?? customState.isCliPanel ?? false,
        agentType: snapshot?.agentType ?? customState.agentType,
        panelTitle: panel.title,
        lastActivityAt: snapshot?.lastActivityTime,
        screenText: snapshot?.screenText,
      };
    },
  });
  for (const session of sessionManager.getAllSessions()) {
    const project = sessionManager.getProjectForSession(session.id);
    journal.rememberPane({
      paneId: session.id,
      paneName: session.name,
      repoId: project?.id,
      repoName: project?.name,
      worktreePath: session.worktreePath,
    });
  }
  return journal;
}
