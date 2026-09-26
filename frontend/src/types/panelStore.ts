import { ToolPanel, SessionPanelLayout } from '../../../shared/types/panels';
import { AgentState } from '../../../shared/types/agentStatus';

export interface PanelStore {
  // State (using plain objects instead of Maps for React reactivity)
  panels: Record<string, ToolPanel[]>;        // sessionId -> panels
  activePanels: Record<string, string>;       // sessionId -> active panelId
  activityStatus: Record<string, 'active' | 'idle'>; // panelId -> status
  agentStatus: Record<string, AgentState>;    // panelId -> detected agent state (blocked/working/idle)
  agentStatusSession: Record<string, string>; // panelId -> sessionId (so status rolls up without panels loaded)
  agentStatusSnapshotVersion: number; // Snapshots and terminal endings silently rebaseline notification subscribers
  lastActivityAt: Record<string, string>;     // panelId -> last PTY output timestamp
  unviewedCompletedActivity: Record<string, string>; // sessionId -> completion timestamp

  // Layout state for split tab groups
  layouts: Record<string, SessionPanelLayout>;   // sessionId -> layout tree
  focusedGroupIds: Record<string, string>;        // sessionId -> focused group id

  // Synchronous state update actions
  setPanels: (sessionId: string, panels: ToolPanel[]) => void;
  setActivePanel: (sessionId: string, panelId: string) => void;
  addPanel: (panel: ToolPanel) => void;
  removePanel: (sessionId: string, panelId: string) => void;
  updatePanelState: (panel: ToolPanel) => void;
  setActivityStatus: (panelId: string, status: 'active' | 'idle', lastActivityAt?: string) => void;
  clearActivityStatus: (panelId: string) => void;
  setAgentStatus: (panelId: string, sessionId: string, state: AgentState) => void;
  clearAgentStatus: (panelId: string) => void;
  markUnviewedCompletedActivity: (sessionId: string, completedAt?: string) => void;
  clearUnviewedCompletedActivity: (sessionId: string) => void;

  // Layout actions
  setLayout: (sessionId: string, layout: SessionPanelLayout) => void;
  setFocusedGroup: (sessionId: string, groupId: string) => void;

  // Getters
  getSessionPanels: (sessionId: string) => ToolPanel[];
  getActivePanel: (sessionId: string) => ToolPanel | undefined;
  getPanelActivityStatus: (panelId: string) => 'active' | 'idle';
  getSessionActivityStatus: (sessionId: string) => 'active' | 'idle';
  getPanelAgentState: (panelId: string) => AgentState | undefined;
  getSessionAgentState: (sessionId: string) => AgentState;
  hasUnviewedCompletedActivity: (sessionId: string) => boolean;
  getLayout: (sessionId: string) => SessionPanelLayout | undefined;
  getFocusedGroupId: (sessionId: string) => string | undefined;
}
