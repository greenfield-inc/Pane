import { create } from 'zustand';
import type { AgentState } from '../../../shared/types/agentStatus';
import { SETTINGS_PREFERENCE_KEYS } from '../types/settings';
import { rollupAgentState } from '../utils/agentStatus';
import { usePanelStore } from './panelStore';
import { useSessionStore } from './sessionStore';

/**
 * How long a Pane must keep needing the user (or keep not needing them) before
 * the inbox adds or drops its row. Agent detection re-evaluates every 500 ms
 * and publishes a waiting prompt at once, so this spans three polls: a prompt
 * that clears itself never pops a row in and out. Working to idle already
 * settles for 10 s in the main process.
 */
export const ATTENTION_INBOX_HOLD_MS = 1500;

/**
 * `finished`: an agent in the Pane completed a real turn (it showed visible work
 * before going idle) during this run of Pane. Startup alone never counts.
 * `dismissed`: the user hid the row; it returns once the agent works again.
 */
type AttentionMark = 'finished' | 'dismissed';

interface AttentionInboxState {
  /** The experimental "Attention inbox" sidebar preference. */
  enabled: boolean;
  /** The user asked to see every Pane while the inbox is on. */
  showAll: boolean;
  /** Panes the inbox lists, after the hold. */
  members: ReadonlySet<string>;
  marks: Record<string, AttentionMark>;
  setEnabled: (enabled: boolean) => void;
  setShowAll: (showAll: boolean) => void;
  dismiss: (sessionId: string) => void;
  markFinished: (sessionId: string) => void;
  loadEnabled: () => Promise<void>;
}

export const useAttentionInboxStore = create<AttentionInboxState>((set) => ({
  enabled: false,
  showAll: false,
  members: new Set(),
  marks: {},
  setEnabled: (enabled) => set({ enabled, showAll: false }),
  setShowAll: (showAll) => set({ showAll }),
  dismiss: (sessionId) => set(state => {
    const members = new Set(state.members);
    members.delete(sessionId);
    return { members, marks: { ...state.marks, [sessionId]: 'dismissed' } };
  }),
  markFinished: (sessionId) => set(state => ({ marks: { ...state.marks, [sessionId]: 'finished' } })),
  loadEnabled: async () => {
    try {
      // SAFETY: The named IPC/API channel contract establishes this response payload type.
      const result = await window.electron?.invoke('preferences:get', SETTINGS_PREFERENCE_KEYS.sidebarAttentionInbox) as { data?: string } | undefined;
      set({ enabled: result?.data === 'true' });
    } catch {
      set({ enabled: false });
    }
  },
}));

function rollupBySession(agentStatus: Record<string, AgentState>, agentStatusSession: Record<string, string>): Map<string, AgentState> {
  const states = new Map<string, AgentState[]>();
  for (const [panelId, state] of Object.entries(agentStatus)) {
    const sessionId = agentStatusSession[panelId];
    if (!sessionId) continue;
    const list = states.get(sessionId) ?? [];
    list.push(state);
    states.set(sessionId, list);
  }
  return new Map([...states].map(([sessionId, list]) => [sessionId, rollupAgentState(list)]));
}

/**
 * Track which Panes need the user: waiting on input or approval, finished a
 * turn this run, or errored. Opening a Pane does not change membership; its
 * agent working again does. Returns the unsubscribe function.
 */
export function subscribeAttentionInbox(): () => void {
  let panelStates: Record<string, AgentState> = {};
  let rollups = new Map<string, AgentState>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const needsYou = (sessionId: string, sessionsById = new Map(useSessionStore.getState().sessions.map(item => [item.id, item]))): boolean => {
    const session = sessionsById.get(sessionId);
    if (!session || session.archived || session.isHidden) return false;
    const mark = useAttentionInboxStore.getState().marks[sessionId];
    if (mark === 'dismissed') return false;
    const state = rollups.get(sessionId);
    return state === 'blocked' || session.status === 'error' || (mark === 'finished' && state === 'idle');
  };

  const settle = (sessionId: string) => {
    timers.delete(sessionId);
    const members = new Set(useAttentionInboxStore.getState().members);
    if (needsYou(sessionId)) members.add(sessionId);
    else members.delete(sessionId);
    useAttentionInboxStore.setState({ members });
  };

  const reconcile = () => {
    const { members } = useAttentionInboxStore.getState();
    const sessionsById = new Map(useSessionStore.getState().sessions.map(session => [session.id, session]));
    for (const sessionId of new Set([...members, ...timers.keys(), ...sessionsById.keys()])) {
      const pending = timers.get(sessionId);
      if (needsYou(sessionId, sessionsById) === members.has(sessionId)) {
        if (pending) clearTimeout(pending);
        timers.delete(sessionId);
      } else if (!pending) {
        timers.set(sessionId, setTimeout(() => settle(sessionId), ATTENTION_INBOX_HOLD_MS));
      }
    }
  };

  const onAgentStatus = () => {
    const { agentStatus, agentStatusSession } = usePanelStore.getState();
    const marks = { ...useAttentionInboxStore.getState().marks };
    let marksChanged = false;
    // Any agent in a Pane starting work clears its mark, even while another
    // agent in the same Pane stays blocked and holds the rollup.
    for (const [panelId, state] of Object.entries(agentStatus)) {
      const sessionId = agentStatusSession[panelId];
      if (state === 'working' && panelStates[panelId] !== 'working' && sessionId && marks[sessionId]) {
        delete marks[sessionId];
        marksChanged = true;
      }
    }
    panelStates = agentStatus;
    rollups = rollupBySession(agentStatus, agentStatusSession);
    if (marksChanged) useAttentionInboxStore.setState({ marks });
    reconcile();
  };

  onAgentStatus();
  const unsubscribePanels = usePanelStore.subscribe((state, previous) => {
    if (state.agentStatus !== previous.agentStatus || state.agentStatusSession !== previous.agentStatusSession) onAgentStatus();
  });
  const unsubscribeSessions = useSessionStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) reconcile();
  });
  const unsubscribeMarks = useAttentionInboxStore.subscribe((state, previous) => {
    if (state.marks !== previous.marks) reconcile();
  });

  return () => {
    unsubscribePanels();
    unsubscribeSessions();
    unsubscribeMarks();
    timers.forEach(clearTimeout);
    timers.clear();
  };
}
