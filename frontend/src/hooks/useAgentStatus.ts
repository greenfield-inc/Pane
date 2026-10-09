import { usePanelStore } from '../stores/panelStore';
import { rollupAgentDisplayStatus, rollupSessionAgentState, toAgentDisplayStatus } from '../utils/agentStatus';
import type { AgentDisplayStatus } from '../../../shared/types/agentStatus';

/**
 * Session-level at-a-glance status for the sidebar / session list: the panels'
 * states rolled up (blocked > working > idle) and mapped to a display status,
 * where a session that finished while the user was elsewhere reads as `done`.
 *
 * Rolls up by the sessionId carried on each status event (not `panels`), so
 * background sessions and Pane Chat — whose panels aren't loaded into the store —
 * still light up.
 */
export function useSessionAgentDisplayStatus(sessionId: string): AgentDisplayStatus {
  const raw = usePanelStore((s) => rollupSessionAgentState(s.agentStatus, s.agentStatusSession, sessionId));
  const unseen = usePanelStore((s) => Boolean(s.unviewedCompletedActivity[sessionId]));
  return toAgentDisplayStatus(raw, unseen);
}

/** Per-panel display status for pane tabs. */
export function usePanelAgentDisplayStatus(panelId: string, sessionId: string): AgentDisplayStatus {
  const raw = usePanelStore((s) => s.agentStatus[panelId]);
  const unseen = usePanelStore((s) => Boolean(s.unviewedCompletedActivity[sessionId]));
  return toAgentDisplayStatus(raw, unseen);
}

export interface OrchestrationSessionActivity {
  status: AgentDisplayStatus;
  /** Child Panes whose agents are working right now. */
  working: number;
  /** Child Panes waiting on the user (permission prompt or blocker). */
  blocked: number;
}

/**
 * Activity for a Session row: its own orchestrator terminal plus every
 * associated Pane, rolled up the same way as a Pane row. The counts cover the
 * child Panes so the row can say how much delegated work is in flight.
 */
export function useOrchestrationSessionActivity(internalSessionId: string, paneIds: readonly string[]): OrchestrationSessionActivity {
  // A primitive snapshot keeps the store subscription stable between updates.
  const snapshot = usePanelStore((s) => {
    const display = (sessionId: string) => toAgentDisplayStatus(
      rollupSessionAgentState(s.agentStatus, s.agentStatusSession, sessionId),
      Boolean(s.unviewedCompletedActivity[sessionId]),
    );
    const children = paneIds.map(display);
    const status = rollupAgentDisplayStatus([display(internalSessionId), ...children]);
    const working = children.filter(value => value === 'working').length;
    const blocked = children.filter(value => value === 'blocked').length;
    return `${status}|${working}|${blocked}`;
  });
  const [status, working, blocked] = snapshot.split('|');
  // SAFETY: The snapshot's first field is always produced by rollupAgentDisplayStatus above.
  return { status: status as AgentDisplayStatus, working: Number(working), blocked: Number(blocked) };
}

/**
 * Agents waiting on the user, anywhere. Both sidebars badge Mission Control with
 * this, so it lives here rather than being recomputed in each of them.
 */
export function useBlockedAgentCount(): number {
  return usePanelStore((s) => {
    let count = 0;
    for (const state of Object.values(s.agentStatus)) {
      if (state === 'blocked') count += 1;
    }
    return count;
  });
}
