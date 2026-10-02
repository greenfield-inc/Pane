import type { SessionManager } from './sessionManager';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { AgentState } from '../../../shared/types/agentStatus';
import { extractWorkspaceHeldInput } from './workspaceHeldInput';
import type {
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
  RunpaneWorkspacePanelSummary,
  RunpaneWorkspaceStateResult,
} from '../../../shared/types/runpaneOrchestration';

export interface ManagedCliPanel {
  panelId: string;
  paneId: string;
  paneName: string;
  panelTitle?: string;
  agentType?: string;
  repoId?: number;
  repoName?: string;
  worktreePath?: string;
  agentState: AgentState;
  /** Whether the panel's terminal process is live; a stopped panel has no agent to be idle. */
  running: boolean;
  lastActivityTime?: string;
  heldInputPresent?: boolean;
}

export class WorkspaceStateReader {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly getEpoch: () => string,
    private readonly getGeneration: () => number,
  ) {}

  read(repoId?: number): RunpaneWorkspaceStateResult {
    const at = new Date().toISOString();
    const generation = this.getGeneration();
    const entries: RunpaneWorkspaceEntry[] = [];
    const managedPanels = this.listManagedCliPanels(repoId);
    const managedByPane = new Map<string, ManagedCliPanel[]>();
    for (const panel of managedPanels) {
      const panePanels = managedByPane.get(panel.paneId) ?? [];
      panePanels.push(panel);
      managedByPane.set(panel.paneId, panePanels);
    }
    const sessions = repoId === undefined
      ? this.sessionManager.getAllSessions()
      : this.sessionManager.getSessionsForProject(repoId);

    for (const session of sessions) {
      if (session.archived || session.isHidden) continue;
      const project = this.sessionManager.getProjectForSession(session.id);
      const common = {
        gen: generation,
        at,
        paneId: session.id,
        paneName: session.name,
        repoId: project?.id,
        repoName: project?.name,
        worktreePath: session.worktreePath,
        baseline: true as const,
      };

      const panelSummaries: RunpaneWorkspacePanelSummary[] = [];

      for (const panel of panelManager.getPanelsForSession(session.id)) {
        if (panel.type !== 'terminal') continue;
        const customState = decodeBoundary(panel.state.customState ?? {}, boundary.object({
          isCliPanel: boundary.optional(boundary.boolean),
          agentType: boundary.optional(boundary.string),
        }));
        panelSummaries.push({
          panelId: panel.id,
          title: panel.title,
          agentType: customState.agentType,
          agentState: resolveAgentState(panel.id),
          running: terminalPanelManager.isTerminalInitialized(panel.id),
        });

      }

      const agentEntries = (managedByPane.get(session.id) ?? []).map((panel): RunpaneWorkspaceEntry => ({
          ...common,
          kind: panel.running ? entryKindForState(panel.agentState) : 'panel.stopped',
          panelId: panel.panelId,
          panelTitle: panel.panelTitle,
          agentType: panel.agentType,
          to: panel.agentState,
          running: panel.running,
          source: 'agent',
        }));

      entries.push({ ...common, kind: 'pane.created', source: 'session', panels: panelSummaries });
      entries.push(...agentEntries);
    }

    return { ok: true, epoch: this.getEpoch(), generation, entries };
  }

  listManagedCliPanels(repoId?: number): ManagedCliPanel[] {
    const sessions = repoId === undefined
      ? this.sessionManager.getAllSessions()
      : this.sessionManager.getSessionsForProject(repoId);
    const result: ManagedCliPanel[] = [];

    for (const session of sessions) {
      if (session.archived || session.isHidden) continue;
      const project = this.sessionManager.getProjectForSession(session.id);
      for (const panel of panelManager.getPanelsForSession(session.id)) {
        if (panel.type !== 'terminal') continue;
        const customState = decodeBoundary(panel.state.customState ?? {}, boundary.object({
          isCliPanel: boundary.optional(boundary.boolean),
          agentType: boundary.optional(boundary.string),
        }));
        const snapshot = terminalPanelManager.getTerminalSnapshot(panel.id);
        if ((snapshot?.isCliPanel ?? customState.isCliPanel) !== true) continue;
        result.push({
          panelId: panel.id,
          paneId: session.id,
          paneName: session.name,
          panelTitle: panel.title,
          agentType: snapshot?.agentType ?? customState.agentType,
          repoId: project?.id,
          repoName: project?.name,
          worktreePath: session.worktreePath,
          agentState: resolveAgentState(panel.id),
          running: terminalPanelManager.isTerminalInitialized(panel.id),
          lastActivityTime: snapshot?.lastActivityTime,
          heldInputPresent: snapshot?.screenText ? extractWorkspaceHeldInput(snapshot.screenText) !== undefined : undefined,
        });
      }
    }
    return result;
  }
}

function resolveAgentState(panelId: string): AgentState {
  // A panel whose terminal is not running has no agent to be idle or ready.
  if (!terminalPanelManager.isTerminalInitialized(panelId)) return 'unknown';
  return terminalPanelManager.getAgentStatus(panelId) ?? 'unknown';
}

function entryKindForState(state: AgentState): RunpaneWorkspaceEntryKind {
  if (state === 'working') return 'agent.busy';
  if (state === 'blocked') return 'agent.blocked';
  if (state === 'idle') return 'agent.ready';
  return 'agent.unknown';
}
