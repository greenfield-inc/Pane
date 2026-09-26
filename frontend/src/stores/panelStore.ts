import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { PanelStore } from '../types/panelStore';
import { ToolPanel } from '../../../shared/types/panels';
import { rollupSessionAgentState } from '../utils/agentStatus';

// FIX: Use immer for safe immutable updates
export const usePanelStore = create<PanelStore>()(
  immer((set, get) => ({
    panels: {},
    activePanels: {},
    activityStatus: {},
    agentStatus: {},
    agentStatusSession: {},
    agentStatusSnapshotVersion: 0,
    lastActivityAt: {},
    unviewedCompletedActivity: {},
    layouts: {},
    focusedGroupIds: {},

    // Pure synchronous state updates
    setPanels: (sessionId, panels) => {
      set((state) => {
        const panelIds = new Set(panels.map(panel => panel.id));
        for (const [panelId, owner] of Object.entries(state.agentStatusSession)) {
          if (owner === sessionId && !panelIds.has(panelId)) {
            delete state.agentStatus[panelId];
            delete state.agentStatusSession[panelId];
            delete state.activityStatus[panelId];
            delete state.lastActivityAt[panelId];
          }
        }
        // Replace panels array entirely to ensure React detects changes
        state.panels[sessionId] = panels;
      });
    },

    setActivePanel: (sessionId, panelId) => {
      set((state) => {
        state.activePanels[sessionId] = panelId;
      });
    },

    addPanel: (panel) => {
      set((state) => {
        if (!state.panels[panel.sessionId]) {
          state.panels[panel.sessionId] = [];
        }
        // Check if panel already exists to prevent duplicates
        const existing = state.panels[panel.sessionId].find((p: ToolPanel) => p.id === panel.id);
        if (!existing) {
          state.panels[panel.sessionId].push(panel);
        }
        if (panel.state.isActive) {
          state.activePanels[panel.sessionId] = panel.id;
        }
      });
    },

    removePanel: (sessionId, panelId) => {
      set((state) => {
        if (state.panels[sessionId]) {
          state.panels[sessionId] = state.panels[sessionId].filter((p: ToolPanel) => p.id !== panelId);
        }
        // Clear active panel if it was the removed one
        if (state.activePanels[sessionId] === panelId) {
          delete state.activePanels[sessionId];
        }
        delete state.activityStatus[panelId];
        delete state.agentStatus[panelId];
        delete state.agentStatusSession[panelId];
        delete state.lastActivityAt[panelId];
      });
    },

    updatePanelState: (panel) => {
      set((state) => {
        const sessionPanels = state.panels[panel.sessionId];
        if (sessionPanels) {
          const index = sessionPanels.findIndex((p: ToolPanel) => p.id === panel.id);
          if (index !== -1) {
            sessionPanels[index] = panel;
          }
        }
      });
    },

    setActivityStatus: (panelId, status, lastActivityAt) => {
      set((state) => {
        state.activityStatus[panelId] = status;
        if (lastActivityAt) {
          state.lastActivityAt[panelId] = lastActivityAt;
        }
      });
    },

    clearActivityStatus: (panelId) => {
      set((state) => {
        delete state.activityStatus[panelId];
        delete state.lastActivityAt[panelId];
      });
    },

    setAgentStatus: (panelId, sessionId, agentState) => {
      set((state) => {
        state.agentStatus[panelId] = agentState;
        state.agentStatusSession[panelId] = sessionId;
      });
    },

    clearAgentStatus: (panelId) => {
      set((state) => {
        delete state.agentStatus[panelId];
        delete state.agentStatusSession[panelId];
      });
    },

    markUnviewedCompletedActivity: (sessionId, completedAt) => {
      set((state) => {
        state.unviewedCompletedActivity[sessionId] = completedAt ?? new Date().toISOString();
      });
    },

    clearUnviewedCompletedActivity: (sessionId) => {
      set((state) => {
        delete state.unviewedCompletedActivity[sessionId];
      });
    },

    // Layout actions
    setLayout: (sessionId, layout) => {
      set((state) => {
        state.layouts[sessionId] = layout;
      });
    },

    setFocusedGroup: (sessionId, groupId) => {
      set((state) => {
        state.focusedGroupIds[sessionId] = groupId;
      });
    },

    // Getters remain the same
    getSessionPanels: (sessionId) => get().panels[sessionId] || [],
    getActivePanel: (sessionId) => {
      const panels = get().panels[sessionId] || [];
      return panels.find(p => p.id === get().activePanels[sessionId]);
    },
    getPanelActivityStatus: (panelId) => get().activityStatus[panelId] || 'idle',
    getSessionActivityStatus: (sessionId) => {
      const sessionPanels = get().panels[sessionId] || [];
      const actStatus = get().activityStatus;
      return sessionPanels.some((p) => actStatus[p.id] === 'active') ? 'active' : 'idle';
    },
    getPanelAgentState: (panelId) => get().agentStatus[panelId],
    getSessionAgentState: (sessionId) => {
      // Roll up by the sessionId carried on each status event, so background
      // sessions (whose panels aren't loaded into the store) still light up.
      const { agentStatus, agentStatusSession } = get();
      return rollupSessionAgentState(agentStatus, agentStatusSession, sessionId);
    },
    hasUnviewedCompletedActivity: (sessionId) => {
      return Boolean(get().unviewedCompletedActivity[sessionId]);
    },

    // Layout getters
    getLayout: (sessionId) => get().layouts[sessionId],
    getFocusedGroupId: (sessionId) => get().focusedGroupIds[sessionId],
  }))
);
