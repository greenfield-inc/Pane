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
    agentStatusReason: {},
    agentStatusSnapshotVersion: 0,
    lastActivityAt: {},
    unviewedCompletedActivity: {},
    layouts: {},
    focusedGroupIds: {},
    activationRequests: {},

    // Pure synchronous state updates
    removeBrowserPanelsForHostSwitch: () => {
      for (const [sessionId, panels] of Object.entries(get().panels)) {
        get().setPanels(sessionId, panels.filter(panel => panel.type !== 'browser'));
      }
    },

    setPanels: (sessionId, panels) => {
      set((state) => {
        const panelIds = new Set(panels.map(panel => panel.id));
        for (const [panelId, owner] of Object.entries(state.agentStatusSession)) {
          if (owner === sessionId && !panelIds.has(panelId)) {
            delete state.agentStatus[panelId];
            delete state.agentStatusSession[panelId];
            delete state.agentStatusReason[panelId];
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
        delete state.agentStatusReason[panelId];
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

    setAgentStatus: (panelId, sessionId, agentState, reason = null) => {
      set((state) => {
        state.agentStatus[panelId] = agentState;
        state.agentStatusSession[panelId] = sessionId;
        state.agentStatusReason[panelId] = reason;
      });
    },

    clearAgentStatus: (panelId) => {
      set((state) => {
        delete state.agentStatus[panelId];
        delete state.agentStatusSession[panelId];
        delete state.agentStatusReason[panelId];
      });
    },

    forgetPanel: (panelId) => {
      set((state) => {
        // `removePanel` needs the session id to find the panel in the list;
        // this does not. A panel deleted anywhere — another session, RunPane,
        // a remote daemon — leaves its status behind otherwise, and a stale
        // `blocked` entry keeps the sidebar's "needs input" badge lit for a
        // pane that no longer exists.
        delete state.activityStatus[panelId];
        delete state.agentStatus[panelId];
        delete state.agentStatusSession[panelId];
        delete state.agentStatusReason[panelId];
        delete state.lastActivityAt[panelId];
      });
    },

    forgetSession: (sessionId) => {
      set((state) => {
        // Archiving a session deletes its panes without a `panel:deleted` for
        // each one, so the session is the only handle on what to forget. Panel
        // ids come from both sides: the loaded panel list, and the session id
        // that rides on every status event (background sessions never load
        // their panels at all).
        const panelIds = new Set((state.panels[sessionId] ?? []).map((panel: ToolPanel) => panel.id));
        for (const [panelId, panelSessionId] of Object.entries(state.agentStatusSession)) {
          if (panelSessionId === sessionId) panelIds.add(panelId);
        }
        for (const panelId of panelIds) {
          delete state.activityStatus[panelId];
          delete state.agentStatus[panelId];
          delete state.agentStatusSession[panelId];
          delete state.agentStatusReason[panelId];
          delete state.lastActivityAt[panelId];
        }
        delete state.unviewedCompletedActivity[sessionId];
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

    requestActivation: (request) => {
      set((state) => {
        state.activationRequests[request.sessionId] = request;
      });
    },

    clearActivationRequest: (sessionId) => {
      set((state) => {
        delete state.activationRequests[sessionId];
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
