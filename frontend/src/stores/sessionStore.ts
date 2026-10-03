/**
 * Session state management for Pane.
 * Note: "Sessions" are called "Panes" in the UI. Internally they remain
 * "sessions" in code, database, and IPC to avoid a massive refactor.
 */

import { create } from 'zustand';
import type { Session, SessionOutput, GitStatus, ClaudeJsonMessage } from '../types/session';
import { API } from '../utils/api';
import { startSwitchPane } from '../utils/journeyTimings';
import { normalizeSession, normalizeSessionOutput, normalizeSessions } from '../utils/sessionNormalization';

interface CreateSessionRequest {
  prompt: string;
  worktreeTemplate: string;
  count: number;
}

interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  activeMainRepoSession: Session | null; // Special storage for main repo session
  isLoaded: boolean;
  terminalOutput: Record<string, string[]>; // sessionId -> terminal output lines
  deletingSessionIds: Set<string>; // Track sessions currently being deleted
  gitStatusLoading: Set<string>; // Track sessions currently loading git status
  
  // Batching for git status updates
  gitStatusBatchTimer: NodeJS.Timeout | null;
  pendingGitStatusLoading: Map<string, boolean>; // sessionId -> loading state
  pendingGitStatusUpdates: Map<string, GitStatus>; // sessionId -> GitStatus
  
  setSessions: (sessions: Session[]) => void;
  loadSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  updateSession: (session: Session) => void;
  deleteSession: (session: Pick<Session, 'id'>) => void;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  addSessionOutput: (output: SessionOutput) => void;
  setSessionOutput: (sessionId: string, output: string) => void;
  setSessionOutputs: (sessionId: string, outputs: SessionOutput[]) => void;
  clearSessionOutput: (sessionId: string) => void;
  addTerminalOutput: (output: { sessionId: string; type: 'stdout' | 'stderr'; data: string }) => void;
  clearTerminalOutput: (sessionId: string) => void;
  getTerminalOutput: (sessionId: string) => string[];
  createSession: (request: CreateSessionRequest) => Promise<void>;
  markSessionAsViewed: (sessionId: string) => Promise<void>;
  
  setDeletingSessionIds: (ids: string[]) => void;
  addDeletingSessionId: (id: string) => void;
  removeDeletingSessionId: (id: string) => void;
  clearDeletingSessionIds: () => void;
  
  getActiveSession: () => Session | undefined;
  updateSessionGitStatus: (sessionId: string, gitStatus: GitStatus) => void;
  setGitStatusLoading: (sessionId: string, loading: boolean) => void;
  isGitStatusLoading: (sessionId: string) => boolean;
  
  // Batch update methods
  setGitStatusLoadingBatch: (updates: Array<{ sessionId: string; loading: boolean }>) => void;
  updateSessionGitStatusBatch: (updates: Array<{ sessionId: string; status: GitStatus }>) => void;
  processPendingGitStatusUpdates: () => void;
  
  // Performance cleanup methods
  cleanupInactiveSessions: () => void;

  // Spotlight tracking (projectId → sessionId)
  activeSpotlights: Map<number, string>;
  setSpotlightActive: (sessionId: string, projectId: number, active: boolean) => void;
  isSpotlightActive: (sessionId: string) => boolean;
  getSpotlightedSessionForProject: (projectId: number) => string | undefined;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  activeMainRepoSession: null,
  isLoaded: false,
  terminalOutput: {},
  deletingSessionIds: new Set(),
  gitStatusLoading: new Set(),
  
  // Batching state
  gitStatusBatchTimer: null,
  pendingGitStatusLoading: new Map(),
  pendingGitStatusUpdates: new Map(),

  activeSpotlights: new Map(),
  
  setSessions: (sessions) => set({ sessions: normalizeSessions(sessions) }),
  
  loadSessions: (sessions) => set({ sessions: normalizeSessions(sessions), isLoaded: true }),
  
  addSession: (session) => set((state) => {
    const normalizedSession = normalizeSession(session);
    const shouldActivate = normalizedSession.activateOnCreate !== false;
    
    // Initialize arrays if they don't exist
    const sessionWithArrays = {
      ...normalizedSession,
      output: normalizedSession.output || [],
      jsonMessages: normalizedSession.jsonMessages || []
    };
    
    return {
      sessions: [sessionWithArrays, ...state.sessions],  // Add new sessions at the top
      activeSessionId: shouldActivate ? normalizedSession.id : state.activeSessionId
    };
  }),
  
  updateSession: (updatedSession) => set((state) => {
    const normalizedUpdatedSession = normalizeSession(updatedSession);
    
    const activeMainRepoSession = state.activeMainRepoSession?.id === normalizedUpdatedSession.id
      ? {
          ...state.activeMainRepoSession,
          ...normalizedUpdatedSession,
          output: state.activeMainRepoSession.output,
          jsonMessages: state.activeMainRepoSession.jsonMessages,
        }
      : state.activeMainRepoSession;

    // Keep the list entry in sync with the active main-repo session.
    // Performance: Only clone array if session exists
    let newSessions = state.sessions;
    for (let i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === normalizedUpdatedSession.id) {
        newSessions = state.sessions.slice();
        const updatedSessionWithOutput = {
          ...state.sessions[i],
          ...normalizedUpdatedSession,
          output: state.sessions[i].output,
          jsonMessages: state.sessions[i].jsonMessages
        };
        newSessions[i] = updatedSessionWithOutput;
        break;
      }
    }
    
    return {
      ...state,
      sessions: newSessions,
      activeMainRepoSession
    };
  }),
  
  deleteSession: (deletedSession) => set((state) => {
    // Clear the active main repo session if it's being deleted
    const newActiveMainRepoSession = state.activeMainRepoSession?.id === deletedSession.id 
      ? null 
      : state.activeMainRepoSession;
    
    // Clean up terminal output for deleted session to free memory
    const newTerminalOutput = { ...state.terminalOutput };
    delete newTerminalOutput[deletedSession.id];
    
    return {
      sessions: state.sessions.filter(session => session.id !== deletedSession.id),
      activeSessionId: state.activeSessionId === deletedSession.id ? null : state.activeSessionId,
      activeMainRepoSession: newActiveMainRepoSession,
      terminalOutput: newTerminalOutput
    };
  }),
  
  setActiveSession: async (sessionId) => {
    
    if (!sessionId) {
      set({ activeSessionId: null, activeMainRepoSession: null });
      // Notify backend about active session change for smart git status polling
      try {
        await window.electronAPI.invoke('sessions:set-active-session', null);
      } catch (error) {
        console.warn('Failed to notify backend about active session change:', error);
      }
      return;
    }
    
    const wasAlreadyActive = get().activeSessionId === sessionId;

    // Emit session-switched event for cleanup
    if (get().activeSessionId !== sessionId) {
      startSwitchPane(sessionId);
      window.dispatchEvent(new CustomEvent('session-switched', { detail: { sessionId } }));
      
      // Notify backend about active session change for smart git status polling
      try {
        await window.electronAPI.invoke('sessions:set-active-session', sessionId);
      } catch (error) {
        console.warn('Failed to notify backend about active session change:', error);
      }
    }
    
    // First check if the session is already in our local store
    const state = get();
    const existingSession = state.sessions.find(s => s.id === sessionId);
    
    if (existingSession) {
      
      if (existingSession.isMainRepo) {
        // Store main repo session separately with initialized arrays
        set({ 
          activeSessionId: sessionId, 
          activeMainRepoSession: {
            ...existingSession,
            output: existingSession.output || [],
            jsonMessages: existingSession.jsonMessages || []
          }
        });
      } else {
        // Regular session - just set the ID
        set({ activeSessionId: sessionId, activeMainRepoSession: null });
      }
      
      // Only mark session as viewed if it wasn't already active
      // This prevents the blue dot from disappearing when the session completes while you're viewing it
      if (!wasAlreadyActive) {
        get().markSessionAsViewed(sessionId);
      }
      return;
    }
    
    // If not in local store, fetch from backend (this might be a stale UI)
    try {
      const response = await API.sessions.get(sessionId);
      
      if (response.success && response.data) {
        const session = normalizeSession(response.data);
        
        // Add the session to local store if not already there
        const currentSessions = get().sessions;
        const sessionExists = currentSessions.find(s => s.id === sessionId);
        if (!sessionExists) {
          set(state => ({
            sessions: [...state.sessions, {
              ...session,
              output: session.output || [],
              jsonMessages: session.jsonMessages || []
            }]
          }));
        }
        
        if (session.isMainRepo) {
          // Store main repo session separately with initialized arrays
          set({ 
            activeSessionId: sessionId, 
            activeMainRepoSession: {
              ...session,
              output: session.output || [],
              jsonMessages: session.jsonMessages || []
            }
          });
        } else {
          // Regular session
          set({ activeSessionId: sessionId, activeMainRepoSession: null });
        }
        // Only mark session as viewed if it wasn't already active
        if (!wasAlreadyActive) {
          get().markSessionAsViewed(sessionId);
        }
      } else {
        console.error('[SessionStore] Failed to fetch session:', sessionId, response);
      }
    } catch (error) {
      console.error('[SessionStore] Error setting active session:', error);
      set({ activeSessionId: sessionId, activeMainRepoSession: null });
    }
  },
  
  addSessionOutput: (output) => set((state) => {
    const normalizedOutput = normalizeSessionOutput(output);
    
    // Find session in sessions array
    const sessionIndex = state.sessions.findIndex(s => s.id === normalizedOutput.sessionId);
    if (sessionIndex === -1) {
      return state;
    }
    
    // Performance: Only clone sessions array once
    const sessions = state.sessions.slice();
    const session = sessions[sessionIndex];
    
    // CRITICAL PERFORMANCE FIX: Much stricter limits to prevent V8 array iteration issues
    const MAX_OUTPUTS = 300; // Drastically reduced from 1000
    const MAX_MESSAGES = 100; // Drastically reduced from 500
    
    if (normalizedOutput.type === 'json') {
      // Update jsonMessages array with limit
      const currentMessages = session.jsonMessages || [];
      // SAFETY: The output type discriminator is paired with this payload shape by the IPC contract.
      const newMessage = { ...(normalizedOutput.data as ClaudeJsonMessage), timestamp: normalizedOutput.timestamp };
      const newJsonMessages = currentMessages.length >= MAX_MESSAGES
        ? [...currentMessages.slice(1), newMessage] // Remove oldest when at limit
        : [...currentMessages, newMessage];
      sessions[sessionIndex] = { ...session, jsonMessages: newJsonMessages };
    } else {
      // Add stdout/stderr to output array with limit
      const currentOutput = session.output || [];
      // SAFETY: The output type discriminator is paired with this payload shape by the IPC contract.
      const outputText = normalizedOutput.data as string;
      const newOutput = currentOutput.length >= MAX_OUTPUTS
        ? [...currentOutput.slice(1), outputText] // Remove oldest when at limit
        : [...currentOutput, outputText];
      sessions[sessionIndex] = { ...session, output: newOutput };
    }
    
    // Also update activeMainRepoSession if it matches
    let updatedActiveMainRepoSession = state.activeMainRepoSession;
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === normalizedOutput.sessionId) {
      if (normalizedOutput.type === 'json') {
        const currentMessages = state.activeMainRepoSession.jsonMessages || [];
        // SAFETY: The output type discriminator is paired with this payload shape by the IPC contract.
        const newMessage = { ...(normalizedOutput.data as ClaudeJsonMessage), timestamp: normalizedOutput.timestamp };
        const newJsonMessages = currentMessages.length >= MAX_MESSAGES
          ? [...currentMessages.slice(1), newMessage]
          : [...currentMessages, newMessage];
        updatedActiveMainRepoSession = { ...state.activeMainRepoSession, jsonMessages: newJsonMessages };
      } else {
        const currentOutput = state.activeMainRepoSession.output || [];
        // SAFETY: The output type discriminator is paired with this payload shape by the IPC contract.
        const outputText = normalizedOutput.data as string;
        const newOutput = currentOutput.length >= MAX_OUTPUTS
          ? [...currentOutput.slice(1), outputText]
          : [...currentOutput, outputText];
        updatedActiveMainRepoSession = { ...state.activeMainRepoSession, output: newOutput };
      }
    }
    
    return { 
      ...state,
      sessions,
      activeMainRepoSession: updatedActiveMainRepoSession
    };
  }),
  
  setSessionOutput: (sessionId, output) => set((state) => {
    // Performance: Only clone array if session exists
    let updatedSessions = state.sessions;
    for (let i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === sessionId) {
        updatedSessions = state.sessions.slice();
        updatedSessions[i] = { ...state.sessions[i], output: [output] };
        break;
      }
    }
    
    // Update activeMainRepoSession if it matches
    let updatedActiveMainRepoSession = state.activeMainRepoSession;
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === sessionId) {
      updatedActiveMainRepoSession = { ...state.activeMainRepoSession, output: [output] };
    }
    
    return {
      ...state,
      sessions: updatedSessions,
      activeMainRepoSession: updatedActiveMainRepoSession
    };
  }),
  
  setSessionOutputs: (sessionId, outputs) => set((state) => {
    
    const sessionIndex = state.sessions.findIndex(session => session.id === sessionId);
    if (sessionIndex === -1 && state.activeMainRepoSession?.id !== sessionId) return state;

    const MAX_STORED_OUTPUTS = 300;
    const MAX_STORED_MESSAGES = 100;
    const stdOutputs: string[] = [];
    const jsonMessages: ClaudeJsonMessage[] = [];

    // Read newest first so each category retains its own tail. Only normalize
    // messages we keep, and stop when both bounded buffers are full.
    for (let i = outputs.length - 1; i >= 0; i--) {
      const output = outputs[i];
      if (output.type === 'json' && jsonMessages.length < MAX_STORED_MESSAGES) {
        // SAFETY: The output type discriminator is paired with this payload shape by the IPC contract.
        jsonMessages.push({ ...(output.data as ClaudeJsonMessage), timestamp: normalizeSessionOutput(output).timestamp });
      } else if ((output.type === 'stdout' || output.type === 'stderr') && stdOutputs.length < MAX_STORED_OUTPUTS) {
        // SAFETY: The output type discriminator is paired with this payload shape by the IPC contract.
        stdOutputs.push(output.data as string);
      }
      if (stdOutputs.length === MAX_STORED_OUTPUTS && jsonMessages.length === MAX_STORED_MESSAGES) break;
    }
    stdOutputs.reverse();
    jsonMessages.reverse();

    let updatedSessions = state.sessions;
    if (sessionIndex !== -1) {
      updatedSessions = state.sessions.slice();
      updatedSessions[sessionIndex] = { ...state.sessions[sessionIndex], output: stdOutputs, jsonMessages };
    }

    // Also update activeMainRepoSession if it matches
    let updatedActiveMainRepoSession = state.activeMainRepoSession;
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === sessionId) {
      updatedActiveMainRepoSession = { ...state.activeMainRepoSession, output: stdOutputs, jsonMessages };
    }
    
    return {
      ...state,
      sessions: updatedSessions,
      activeMainRepoSession: updatedActiveMainRepoSession
    };
  }),
  
  clearSessionOutput: (sessionId) => set((state) => {
    // Performance: Only clone array if session exists
    let updatedSessions = state.sessions;
    for (let i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].id === sessionId) {
        updatedSessions = state.sessions.slice();
        updatedSessions[i] = { ...state.sessions[i], output: [], jsonMessages: [] };
        break;
      }
    }
    
    // Update activeMainRepoSession if it matches
    let updatedActiveMainRepoSession = state.activeMainRepoSession;
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === sessionId) {
      updatedActiveMainRepoSession = { ...state.activeMainRepoSession, output: [], jsonMessages: [] };
    }
    
    return {
      ...state,
      sessions: updatedSessions,
      activeMainRepoSession: updatedActiveMainRepoSession
    };
  }),
  
  createSession: async (request) => {
    try {
      const response = await API.sessions.create(request);

      if (!response.success) {
        throw new Error(response.error || 'Failed to create session');
      }

      // Sessions will be added via IPC events, no need to manually add here
    } catch (error) {
      console.error('Error creating session:', error);
      throw error;
    }
  },
  
  addTerminalOutput: (output) => set((state) => {
    // Performance optimization: Much stricter limit to prevent memory issues
    const MAX_TERMINAL_LINES = 1000; // Drastically reduced from 5000
    
    const existingOutput = state.terminalOutput[output.sessionId] || [];
    
    // If already at max, remove oldest before adding new
    let updatedOutput: string[];
    if (existingOutput.length >= MAX_TERMINAL_LINES) {
      // Shift array instead of creating new one for better performance
      updatedOutput = existingOutput.slice(-(MAX_TERMINAL_LINES - 1));
      updatedOutput.push(output.data);
    } else {
      updatedOutput = [...existingOutput, output.data];
    }
    
    return {
      terminalOutput: {
        ...state.terminalOutput,
        [output.sessionId]: updatedOutput
      }
    };
  }),

  clearTerminalOutput: (sessionId: string) => set((state) => ({
    terminalOutput: {
      ...state.terminalOutput,
      [sessionId]: []
    }
  })),

  getTerminalOutput: (sessionId) => {
    const state = get();
    return state.terminalOutput[sessionId] || [];
  },
  
  getActiveSession: () => {
    const state = get();
    
    // If we have a main repo session, return it
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === state.activeSessionId) {
      return state.activeMainRepoSession;
    }
    
    // Otherwise look in regular sessions
    const found = state.sessions.find(session => session.id === state.activeSessionId);
    return found;
  },

  updateSessionGitStatus: (sessionId, gitStatus) => {
    const state = get();
    const pendingGitStatusUpdates = new Map(state.pendingGitStatusUpdates);
    pendingGitStatusUpdates.set(sessionId, gitStatus);
    
    // Clear existing timer
    if (state.gitStatusBatchTimer) {
      clearTimeout(state.gitStatusBatchTimer);
    }
    
    // Set new timer to process pending updates
    const timer = setTimeout(() => {
      get().processPendingGitStatusUpdates();
    }, 50); // 50ms batch window
    
    set({ pendingGitStatusUpdates, gitStatusBatchTimer: timer });
  },
  
  setGitStatusLoading: (sessionId, loading) => {
    const state = get();
    const pendingGitStatusLoading = new Map(state.pendingGitStatusLoading);
    pendingGitStatusLoading.set(sessionId, loading);
    
    // Clear existing timer
    if (state.gitStatusBatchTimer) {
      clearTimeout(state.gitStatusBatchTimer);
    }
    
    // Set new timer to process pending updates
    const timer = setTimeout(() => {
      get().processPendingGitStatusUpdates();
    }, 50); // 50ms batch window
    
    set({ pendingGitStatusLoading, gitStatusBatchTimer: timer });
  },
  
  isGitStatusLoading: (sessionId) => {
    return get().gitStatusLoading.has(sessionId);
  },

  setDeletingSessionIds: (ids) => set({ deletingSessionIds: new Set(ids) }),
  
  addDeletingSessionId: (id) => set((state) => {
    const newSet = new Set(state.deletingSessionIds);
    newSet.add(id);
    return { deletingSessionIds: newSet };
  }),
  
  removeDeletingSessionId: (id) => set((state) => {
    const newSet = new Set(state.deletingSessionIds);
    newSet.delete(id);
    return { deletingSessionIds: newSet };
  }),
  
  clearDeletingSessionIds: () => set({ deletingSessionIds: new Set() }),

  markSessionAsViewed: async (sessionId) => {
    try {
      const response = await API.sessions.markViewed(sessionId);

      if (!response.success) {
        throw new Error(response.error || 'Failed to mark session as viewed');
      }

      // Session will be updated via IPC events, no need to manually update here
    } catch (error) {
      console.error('Error marking session as viewed:', error);
    }
  },
  
  // Batch update methods
  setGitStatusLoadingBatch: (updates) => {
    set((state) => {
      const newLoadingSet = new Set(state.gitStatusLoading);
      
      updates.forEach(({ sessionId, loading }) => {
        if (loading) {
          newLoadingSet.add(sessionId);
        } else {
          newLoadingSet.delete(sessionId);
        }
      });
      
      return { gitStatusLoading: newLoadingSet };
    });
  },
  
  updateSessionGitStatusBatch: (updates) => {
    set((state) => {
      // Build maps for efficient lookup
      const statusUpdates = new Map(updates.map(u => [u.sessionId, u.status]));
      
      // Remove updated sessions from loading set
      const newLoadingSet = new Set(state.gitStatusLoading);
      updates.forEach(({ sessionId }) => {
        newLoadingSet.delete(sessionId);
      });
      
      // Performance: Only clone sessions array if updates affect sessions
      let sessions = state.sessions;
      let sessionsModified = false;
      
      for (let i = 0; i < state.sessions.length; i++) {
        const newStatus = statusUpdates.get(state.sessions[i].id);
        if (newStatus) {
          if (!sessionsModified) {
            sessions = state.sessions.slice();
            sessionsModified = true;
          }
          sessions[i] = { ...state.sessions[i], gitStatus: newStatus };
        }
      }
      
      // Update main repo session if needed
      let activeMainRepoSession = state.activeMainRepoSession;
      if (activeMainRepoSession) {
        const mainRepoUpdate = statusUpdates.get(activeMainRepoSession.id);
        if (mainRepoUpdate) {
          activeMainRepoSession = { ...activeMainRepoSession, gitStatus: mainRepoUpdate };
        }
      }
      
      return { sessions, activeMainRepoSession, gitStatusLoading: newLoadingSet };
    });
  },
  
  processPendingGitStatusUpdates: () => {
    const state = get();

    if (state.gitStatusBatchTimer) {
      clearTimeout(state.gitStatusBatchTimer);
    }

    const loadingUpdates = Array.from(state.pendingGitStatusLoading, ([sessionId, loading]) => ({
      sessionId,
      loading,
    }));
    const statusUpdates = Array.from(state.pendingGitStatusUpdates, ([sessionId, status]) => ({
      sessionId,
      status,
    }));

    // Reset the queues before publishing their snapshots so every observable
    // collection gets a new identity and subsequent updates start a fresh batch.
    set({
      gitStatusBatchTimer: null,
      pendingGitStatusLoading: new Map(),
      pendingGitStatusUpdates: new Map(),
    });

    if (loadingUpdates.length > 0) {
      get().setGitStatusLoadingBatch(loadingUpdates);
    }

    if (statusUpdates.length > 0) {
      get().updateSessionGitStatusBatch(statusUpdates);
    }
  },
  
  cleanupInactiveSessions: () => set((state) => {
    // Performance: Clear output data for inactive sessions to free memory
    const activeId = state.activeSessionId;
    const MAX_INACTIVE_OUTPUTS = 50; // Even less for inactive sessions
    
    // Create new sessions array with trimmed outputs for inactive sessions
    const cleanedSessions = state.sessions.map(session => {
      if (session.id === activeId) {
        // Don't touch active session
        return session;
      }
      
      // For inactive sessions, aggressively trim outputs
      if (session.output && session.output.length > MAX_INACTIVE_OUTPUTS) {
        return {
          ...session,
          output: session.output.slice(-MAX_INACTIVE_OUTPUTS),
          jsonMessages: session.jsonMessages ? session.jsonMessages.slice(-25) : []
        };
      }
      
      return session;
    });
    
    // Also cleanup terminal outputs for inactive sessions
    const cleanedTerminalOutput: Record<string, string[]> = {};
    Object.keys(state.terminalOutput).forEach(sessionId => {
      if (sessionId === activeId) {
        // Keep active session's terminal output
        cleanedTerminalOutput[sessionId] = state.terminalOutput[sessionId];
      } else if (state.terminalOutput[sessionId].length > 50) {
        // Trim inactive session's terminal output more aggressively
        cleanedTerminalOutput[sessionId] = state.terminalOutput[sessionId].slice(-50);
      } else {
        cleanedTerminalOutput[sessionId] = state.terminalOutput[sessionId];
      }
    });
    
    return {
      sessions: cleanedSessions,
      terminalOutput: cleanedTerminalOutput
    };
  }),

  setSpotlightActive: (sessionId, projectId, active) => set((state) => {
    const newMap = new Map(state.activeSpotlights);
    if (active) {
      newMap.set(projectId, sessionId);
    } else {
      newMap.delete(projectId);
    }
    return { activeSpotlights: newMap };
  }),

  isSpotlightActive: (sessionId) => {
    const state = get();
    for (const spotlightedSessionId of state.activeSpotlights.values()) {
      if (spotlightedSessionId === sessionId) return true;
    }
    return false;
  },

  getSpotlightedSessionForProject: (projectId) => {
    return get().activeSpotlights.get(projectId);
  },
}));
