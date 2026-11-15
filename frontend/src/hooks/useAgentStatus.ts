import { usePanelStore } from '../stores/panelStore';
import { rollupSessionAgentState, toAgentDisplayStatus } from '../utils/agentStatus';
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

/**
 * How many of a Session's Panes wait on the user (a permission prompt or blocker), for the
 * Session row's "N need input". Whether the Session is working comes from the host instead
 * (sessionActivitySync.ts), which uses a stricter rule than these per-tab statuses.
 */
export function useSessionBlockedPaneCount(paneIds: readonly string[]): number {
  return usePanelStore((s) => paneIds.filter(sessionId => rollupSessionAgentState(s.agentStatus, s.agentStatusSession, sessionId) === 'blocked').length);
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
