import { useEffect, useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useErrorStore } from '../stores/errorStore';
import { usePanelStore } from '../stores/panelStore';
import { useConfigStore } from '../stores/configStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useSessionWorkspaceLayoutStore } from '../stores/sessionWorkspaceLayoutStore';
import { panelApi } from '../services/panelApi';
import { openPaneTarget } from '../components/terminal/openPaneLink';
import { restoreHostNavigation, withHostNavigationWritesPaused } from '../utils/hostNavigationMemory';
import { API } from '../utils/api';
import { rememberPaneLayout } from '../utils/paneLayoutMemory';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { devLog } from '../utils/console';
import { claimCreatedPane, markAppReady } from '../utils/journeyTimings';
import type { Session, SessionOutput, GitStatus } from '../types/session';
import { isOrchestrationInternalSessionId } from '../../../shared/types/orchestrationSession';

interface SessionEventData {
  sessionId: string;
}

type ValidatedEventData = SessionEventData | SessionOutput;

// Initial reads and all resyncs share ownership. A later runtime event retires
// the whole outgoing continuation, including lists, restoration and events.
let runtimeGeneration = 0;

async function reloadRemoteRuntimeState(loadSessions: (sessions: Session[]) => void, hostChanged: boolean, ownsRuntime: () => boolean): Promise<void> {
  if (!ownsRuntime()) return;
  if (hostChanged) {
    // Invalidate outgoing Session requests and tile memory before any host read.
    useOrchestrationSessionStore.getState().invalidateHost();
    useSessionStore.getState().invalidateHost();
    usePanelStore.setState({ panels: {}, activePanels: {}, layouts: {}, focusedGroupIds: {},
      agentStatus: {}, agentStatusSession: {}, agentStatusSnapshotVersion: 0, activityStatus: {}, lastActivityAt: {}, unviewedCompletedActivity: {} });
    useSessionWorkspaceLayoutStore.getState().reset();
    // Main keeps expanded repositories per host; load them before the new host's repositories arrive.
    const uiState = await window.electronAPI.uiState.getExpanded();
    if (!ownsRuntime()) return;
    useNavigationStore.getState().resetExpandedProjectsForHost(uiState.success ? uiState.data?.expandedProjects ?? [] : []);
  }
  // Repository ids are per host, so another host's repository view is meaningless.
  if (hostChanged && useNavigationStore.getState().activeView === 'project') {
    useNavigationStore.getState().navigateToSessions();
    await useSessionStore.getState().setActiveSession(null);
    if (!ownsRuntime()) return;
  }
  await useConfigStore.getState().fetchConfig(ownsRuntime);
  if (!ownsRuntime()) return;

  const sessionsResponse = await API.sessions.getAll();
  if (!ownsRuntime()) return;
  if (sessionsResponse.success && sessionsResponse.data) {
    const sessionsWithJsonMessages = sessionsResponse.data.map((session: Session) => ({
      ...session,
      jsonMessages: session.jsonMessages || [],
    }));
    loadSessions(sessionsWithJsonMessages);

    // The list leaves out repository Panes, so keep the open repository view's own Pane.
    const { activeSessionId, activeMainRepoSession } = useSessionStore.getState();
    if (activeSessionId && activeSessionId !== activeMainRepoSession?.id
      && !sessionsWithJsonMessages.some((session: Session) => session.id === activeSessionId)) {
      await useSessionStore.getState().setActiveSession(null);
      if (!ownsRuntime()) return;
      usePanelStore.getState().setPanels(activeSessionId, []);
    }
  }

  if (hostChanged) {
    // The new host's config and Panes have landed, so its remembered location
    // can be validated and reopened; the panel load below brings back its tab.
    await restoreHostNavigation(ownsRuntime);
    if (!ownsRuntime()) return;
  }

  const activeSessionId = useSessionStore.getState().activeSessionId;
  if (activeSessionId) {
    const panels = await panelApi.loadPanelsForSession(activeSessionId);
    if (!ownsRuntime()) return;
    // The tab shown stays this desktop's own; the host's active flag is only
    // the last one any client picked.
    usePanelStore.getState().setPanels(activeSessionId, panels);
  }

  if (!ownsRuntime()) return;
  window.dispatchEvent(new Event('project-changed'));
  window.dispatchEvent(new Event('project-sessions-refresh'));
  // Sessions belong to the host too; adopt the new host's selection.
  window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { kind: 'runtime-resync', selectionChanged: true } }));
}

async function resyncRemoteRuntimeState(loadSessions: (sessions: Session[]) => void, hostChanged: boolean, ownsRuntime: () => boolean): Promise<void> {
  if (!hostChanged) {
    await reloadRemoteRuntimeState(loadSessions, false, ownsRuntime);
    return;
  }
  // A switch clears the outgoing host's selection before restoring the incoming
  // host's; don't let those intermediate states be remembered as either one's.
  await withHostNavigationWritesPaused(() => reloadRemoteRuntimeState(loadSessions, true, ownsRuntime));
}

// Frontend validation helpers
function validateEventSession(eventData: ValidatedEventData, activeSessionId?: string): boolean {
  if (!eventData || !eventData.sessionId) {
    console.warn('[useIPCEvents] Event missing sessionId:', eventData);
    return false;
  }
  
  // If we have an active session context, validate the event matches
  if (activeSessionId && eventData.sessionId !== activeSessionId) {
    console.warn(`[useIPCEvents] Event sessionId ${eventData.sessionId} does not match active session ${activeSessionId}`);
    return false;
  }
  
  return true;
}


// Throttle utility with external drain support
interface ThrottledWithDrain<T extends (...args: never[]) => void> {
  throttled: (...args: Parameters<T>) => void;
  drain: (sessionId: string) => void;
}

function createThrottledWithDrain<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
  keyFn: (...args: Parameters<T>) => string,
): ThrottledWithDrain<T> {
  const pendingCalls = new Map<string, Parameters<T>>();
  let lastCallTime = 0;
  let timeoutId: NodeJS.Timeout | null = null;

  const throttled = (...args: Parameters<T>): void => {
    const now = Date.now();
    const key = keyFn(...args);
    pendingCalls.set(key, args);

    const delay = Math.max(0, delayMs - (now - lastCallTime));
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      lastCallTime = Date.now();
      for (const callArgs of pendingCalls.values()) {
        fn(...callArgs);
      }
      pendingCalls.clear();
      timeoutId = null;
    }, delay);
  };

  const drain = (sessionId: string): void => {
    pendingCalls.delete(sessionId);
  };

  return { throttled, drain };
}

export function useIPCEvents() {
  const loadSessions = useSessionStore(state => state.loadSessions);
  const addSession = useSessionStore(state => state.addSession);
  const updateSession = useSessionStore(state => state.updateSession);
  const deleteSession = useSessionStore(state => state.deleteSession);
  const showError = useErrorStore(state => state.showError);
  
  // Create throttled handlers for git status events (with drain support)
  const [gitStatusLoading] = useState(() =>
    createThrottledWithDrain(
      (data: { sessionId: string }) => {
        // Validate event has required session context
        if (!validateEventSession(data)) {
          return; // Ignore invalid events
        }
        useSessionStore.getState().setGitStatusLoading(data.sessionId, true);

        // Also emit a custom event for individual components to listen to
        window.dispatchEvent(new CustomEvent('git-status-loading', {
          detail: { sessionId: data.sessionId }
        }));
      },
      100,
      (data) => data.sessionId,
    )
  );

  const [gitStatusUpdated] = useState(() =>
    createThrottledWithDrain(
      (data: { sessionId: string; gitStatus: GitStatus }) => {
        // Validate event has required session context
        if (!validateEventSession(data)) {
          return; // Ignore invalid events
        }

        // Only log significant status changes in production
        if (data.gitStatus.state !== 'clean' || process.env.NODE_ENV === 'development') {
          devLog.debug(`[useIPCEvents] Git status: ${data.sessionId.substring(0, 8)} → ${data.gitStatus.state}`);
        }

        // Update the store and clear loading state
        useSessionStore.getState().updateSessionGitStatus(data.sessionId, data.gitStatus);
        useSessionStore.getState().setGitStatusLoading(data.sessionId, false);

        // Also emit a custom event for individual components to listen to
        window.dispatchEvent(new CustomEvent('git-status-updated', {
          detail: { sessionId: data.sessionId, gitStatus: data.gitStatus }
        }));
      },
      100,
      (data) => data.sessionId,
    )
  );
  
  useEffect(() => {
    // Check if we're in Electron environment
    if (!window.electronAPI) {
      console.warn('Electron API not available, events will not work');
      return;
    }

    // Set up IPC event listeners
    let disposed = false;
    const initialGeneration = runtimeGeneration;
    const ownsInitialRead = () => !disposed && initialGeneration === runtimeGeneration;
    const unsubscribeFunctions: (() => void)[] = [];

    // Listen for session events
    unsubscribeFunctions.push(window.electronAPI.events.onSessionCreationFailed((failure) => {
      showError({
        title: 'Failed to Create Pane',
        error: failure.error,
        details: `Pane: ${failure.name}`,
      });
    }));
    const unsubscribeSessionCreated = window.electronAPI.events.onSessionCreated((session: Session) => {
      devLog.debug('[useIPCEvents] Session created:', session.id);
      claimCreatedPane(session.id);
      addSession({...session, output: session.output || [], jsonMessages: session.jsonMessages || []});
      // Set git status as loading for new sessions
      useSessionStore.getState().setGitStatusLoading(session.id, true);
    });
    unsubscribeFunctions.push(unsubscribeSessionCreated);

    const unsubscribeSessionUpdated = window.electronAPI.events.onSessionUpdated((session: Session) => {
      devLog.debug('[useIPCEvents] Session updated event received:', {
        id: session.id,
        status: session.status
      });
      
      // Ensure we have valid session data
      if (!session || !session.id) {
        console.error('[useIPCEvents] Invalid session data received:', session);
        return;
      }
      
      // Update the session with initialized arrays
      const sessionWithArrays = {
        ...session,
        output: session.output || [],
        jsonMessages: session.jsonMessages || []
      };
      
      updateSession(sessionWithArrays);
      
      // Force a re-render if this is the active session and status changed to stopped
      const state = useSessionStore.getState();
      if (state.activeSessionId === session.id && 
          (session.status === 'stopped' || session.status === 'error')) {
        // Emit a custom event to trigger UI updates
        window.dispatchEvent(new CustomEvent('session-status-changed', { 
          detail: { sessionId: session.id, status: session.status } 
        }));
      }
    });
    unsubscribeFunctions.push(unsubscribeSessionUpdated);

    const unsubscribePaneFocusRequested = window.electronAPI.events.onPaneFocusRequested(({ paneId, panelId }) => {
      devLog.debug('[useIPCEvents] Pane focus requested:', { paneId, panelId });
      // `panes focus` and `panes create --focus` move the host's own desktop
      // window only; a desktop connected to that host as a remote stays put.
      const config = useConfigStore.getState().config;
      if (!config || getActiveRemoteHostId(config.remoteDaemon) !== null) return;
      // Same as clicking the Pane in the sidebar, which also leaves a repository or Sessions view.
      useNavigationStore.getState().navigateToSessions();
      void useSessionStore.getState().setActiveSession(paneId).then(() => {
        if (panelId) {
          usePanelStore.getState().setActivePanel(paneId, panelId);
        }
      });
    });
    unsubscribeFunctions.push(unsubscribePaneFocusRequested);

    // pane:// links. A host sends Pane links as pane:focus-requested; a remote-mode client sends them here.
    const unsubscribePaneOpenLink = window.electronAPI.events.onPaneOpenLink((target) => {
      if (target.kind === 'pane') {
        void openPaneTarget(target).catch(error => console.error('[useIPCEvents] Failed to open Pane link:', error));
        return;
      }
      if (target.kind === 'repo') {
        useNavigationStore.getState().navigateToProject(target.repoId);
        return;
      }
      useNavigationStore.getState().navigateToPaneChat();
      void useOrchestrationSessionStore.getState().select({ sessionId: target.sessionId });
    });
    unsubscribeFunctions.push(unsubscribePaneOpenLink);

    // A paired phone edited shortcuts or voice keys; pick them up without a restart.
    const unsubscribeRemoteSettingsChanged = window.electronAPI.events.onRemoteSettingsChanged(() => {
      void useConfigStore.getState().fetchConfig().catch(() => undefined);
    });
    unsubscribeFunctions.push(unsubscribeRemoteSettingsChanged);

    const unsubscribeSessionDeleted = window.electronAPI.events.onSessionDeleted((sessionData) => {
      devLog.debug('[useIPCEvents] Session deleted:', sessionData);
      const sessionId = sessionData.id;

      // Drain any pending throttled git status calls for this session
      if (sessionId) {
        gitStatusLoading.drain(sessionId);
        gitStatusUpdated.drain(sessionId);
      }

      // Archived or deleted: drop this desktop's view memory for the Pane.
      const config = useConfigStore.getState().config;
      if (sessionId && config) rememberPaneLayout(getActiveRemoteHostId(config.remoteDaemon), sessionId, null);

      // Dispatch a custom event for other components to listen to
      window.dispatchEvent(new CustomEvent('session-deleted', {
        detail: { id: sessionId }
      }));

      // Create a minimal session object for deletion
      deleteSession(sessionData);
    });
    unsubscribeFunctions.push(unsubscribeSessionDeleted);

    const unsubscribeSessionsLoaded = window.electronAPI.events.onSessionsLoaded((sessions: Session[]) => {
      // Group logging for session loading
      const withStatus = sessions.filter(s => s.gitStatus).length;
      const withoutStatus = sessions.filter(s => !s.gitStatus).length;
      if (withoutStatus > 0) {
        devLog.debug(`[useIPCEvents] Sessions: ${sessions.length} total (${withStatus} with status, ${withoutStatus} pending)`);
      } else {
        devLog.debug(`[useIPCEvents] Sessions: ${sessions.length} loaded`);
      }
      
      const sessionsWithJsonMessages = sessions.map(session => ({
        ...session,
        jsonMessages: session.jsonMessages || []
      }));
      loadSessions(sessionsWithJsonMessages);
      // Set git status as loading for sessions without git status
      sessions.forEach(session => {
        if (!session.gitStatus && !session.archived) {
          useSessionStore.getState().setGitStatusLoading(session.id, true);
        }
      });
    });
    unsubscribeFunctions.push(unsubscribeSessionsLoaded);

    const unsubscribeSessionOutput = window.electronAPI.events.onSessionOutput((output: SessionOutput) => {
      // Validate event has required session context
      if (!validateEventSession(output)) {
        return; // Ignore invalid events
      }

      devLog.debug(`[useIPCEvents] Received session output for ${output.sessionId}, type: ${output.type}`);

      // Just emit custom event to notify that new output is available
      // Include panelId (if present) so panel-based views can react precisely
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: output.sessionId, panelId: output.panelId }
      }));
    });
    unsubscribeFunctions.push(unsubscribeSessionOutput);

    const unsubscribeTerminalOutput = window.electronAPI.events.onTerminalOutput((output) => {
      // Panel output belongs to its TerminalPanel, which writes it to xterm.
      // Copying it here re-rendered the session view on every 32 ms flush.
      if ('panelId' in output || isOrchestrationInternalSessionId(output.sessionId)) {
        return;
      }

      devLog.debug(`[useIPCEvents] Received terminal output for ${output.sessionId}`);
      useSessionStore.getState().addTerminalOutput(output);
    });
    unsubscribeFunctions.push(unsubscribeTerminalOutput);
    
    const unsubscribeOutputAvailable = window.electronAPI.events.onSessionOutputAvailable((info: { sessionId: string }) => {
      // Validate event has required session context
      if (!validateEventSession(info)) {
        return; // Ignore invalid events
      }

      devLog.debug(`[useIPCEvents] Output available notification for session ${info.sessionId}`);
      
      // Emit custom event to notify that output is available
      window.dispatchEvent(new CustomEvent('session-output-available', {
        detail: { sessionId: info.sessionId }
      }));
    });
    unsubscribeFunctions.push(unsubscribeOutputAvailable);

    const unsubscribeOrchestrationChanged = window.electronAPI.events.onOrchestrationSessionsChanged?.((change) => {
      window.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: change }));
    });
    if (unsubscribeOrchestrationChanged) unsubscribeFunctions.push(unsubscribeOrchestrationChanged);

    const unsubscribeOrchestrationOverview = window.electronAPI.events.onOrchestrationSessionsOverviewUpdated?.((change) => {
      window.dispatchEvent(new CustomEvent('orchestration-sessions-overview-updated', { detail: change }));
    });
    if (unsubscribeOrchestrationOverview) unsubscribeFunctions.push(unsubscribeOrchestrationOverview);
    
    // Listen for zombie process detection
    const unsubscribeZombieProcesses = window.electronAPI.events.onZombieProcessesDetected((data: { sessionId?: string | null; pids?: number[]; message: string }) => {
      console.error('[useIPCEvents] Zombie processes detected:', data);
      
      // Show error to user
      const errorMessage = data.message || 'Some child processes could not be terminated. Please check your system process list.';
      const details = data.pids && data.pids.length > 0 
        ? `Unable to terminate process IDs: ${data.pids.join(', ')}\n\nYou may need to manually kill these processes.`
        : undefined;
      
      showError({
        title: 'Zombie Processes Detected',
        error: errorMessage,
        details
      });
      
      // Also log PIDs if available
      if (data.pids && data.pids.length > 0) {
        console.error(`Zombie process PIDs: ${data.pids.join(', ')}`);
      }
    });
    unsubscribeFunctions.push(unsubscribeZombieProcesses);

    // Listen for git status updates (throttled)
    const unsubscribeGitStatusUpdated = window.electronAPI.events.onGitStatusUpdated(gitStatusUpdated.throttled);
    unsubscribeFunctions.push(unsubscribeGitStatusUpdated);

    // Listen for git status loading events (throttled)
    const unsubscribeGitStatusLoading = window.electronAPI.events.onGitStatusLoading?.(gitStatusLoading.throttled);
    if (unsubscribeGitStatusLoading) {
      unsubscribeFunctions.push(unsubscribeGitStatusLoading);
    }
    
    // Listen for batch git status events
    const unsubscribeGitStatusLoadingBatch = window.electronAPI.events.onGitStatusLoadingBatch?.((sessionIds: string[]) => {
      const state = useSessionStore.getState();
      const knownIds = new Set(state.sessions.map((s) => s.id));
      const filteredIds = sessionIds.filter((id) => knownIds.has(id));
      if (filteredIds.length > 0) {
        const updates = filteredIds.map(sessionId => ({ sessionId, loading: true }));
        state.setGitStatusLoadingBatch(updates);

        // Dispatch custom events for each session
        filteredIds.forEach(sessionId => {
          window.dispatchEvent(new CustomEvent('git-status-loading', {
            detail: { sessionId }
          }));
        });
      }
    });
    if (unsubscribeGitStatusLoadingBatch) {
      unsubscribeFunctions.push(unsubscribeGitStatusLoadingBatch);
    }

    const unsubscribeGitStatusUpdatedBatch = window.electronAPI.events.onGitStatusUpdatedBatch?.((updates: Array<{ sessionId: string; status: GitStatus }>) => {
      devLog.debug(`[useIPCEvents] Git status batch update: ${updates.length} sessions`);
      const state = useSessionStore.getState();
      const knownIds = new Set(state.sessions.map((s) => s.id));
      const filtered = updates.filter((entry) => knownIds.has(entry.sessionId));
      if (filtered.length > 0) {
        state.updateSessionGitStatusBatch(filtered);

        // Dispatch custom events for each session
        filtered.forEach(({ sessionId, status }) => {
          window.dispatchEvent(new CustomEvent('git-status-updated', {
            detail: { sessionId, gitStatus: status }
          }));
        });
      }
    });
    if (unsubscribeGitStatusUpdatedBatch) {
      unsubscribeFunctions.push(unsubscribeGitStatusUpdatedBatch);
    }

    // Listen for spotlight events
    const unsubscribeSpotlightStatus = window.electronAPI.events.onSpotlightStatusChanged?.((data: { sessionId: string; projectId: number; active: boolean }) => {
      devLog.debug(`[useIPCEvents] Spotlight status changed: session=${data.sessionId}, project=${data.projectId}, active=${data.active}`);
      useSessionStore.getState().setSpotlightActive(data.sessionId, data.projectId, data.active);
    });
    if (unsubscribeSpotlightStatus) {
      unsubscribeFunctions.push(unsubscribeSpotlightStatus);
    }

    const unsubscribeSpotlightError = window.electronAPI.events.onSpotlightSyncError?.((data: { sessionId: string; projectId: number; error: string }) => {
      console.error(`[useIPCEvents] Spotlight sync error for session ${data.sessionId}:`, data.error);
      // Show error via existing error store
      showError({
        title: 'Spotlight Sync Error',
        error: data.error,
        details: `Session: ${data.sessionId}`
      });
    });
    if (unsubscribeSpotlightError) {
      unsubscribeFunctions.push(unsubscribeSpotlightError);
    }

    const unsubscribeSpotlightTamper = window.electronAPI.events.onSpotlightTamperDetected?.((data: { sessionId: string; projectId: number; message: string }) => {
      console.warn(`[useIPCEvents] Spotlight tamper detected for session ${data.sessionId}:`, data.message);
      showError({
        title: 'Spotlight Disabled',
        error: data.message,
        details: `The spotlight was automatically disabled because the repository root was modified externally.`
      });
    });
    if (unsubscribeSpotlightTamper) {
      unsubscribeFunctions.push(unsubscribeSpotlightTamper);
    }

    const unsubscribeRemoteResync = window.electronAPI.events.onRemoteDaemonResyncRequested?.(({ hostChanged }) => {
      const generation = ++runtimeGeneration;
      const ownsRuntime = () => !disposed && generation === runtimeGeneration;
      // Destroy outgoing guests before async resync. Hosts can share panel IDs,
      // but their file URLs and Electron partitions must never be reused.
      if (hostChanged) {
        panelApi.invalidateHostLoads();
        usePanelStore.getState().removeBrowserPanelsForHostSwitch();
      }
      void (async () => {
        try {
          await resyncRemoteRuntimeState(loadSessions, hostChanged, ownsRuntime);
        } catch (error) {
          if (ownsRuntime()) console.error('[useIPCEvents] Failed to resync renderer state after remote reconnect:', error);
        }
      })();
    });
    if (unsubscribeRemoteResync) {
      unsubscribeFunctions.push(unsubscribeRemoteResync);
    }

    // Load initial sessions
    API.sessions.getAll()
      .then(response => {
        if (!ownsInitialRead()) return;
        if (response.success && response.data) {
          const sessionsWithJsonMessages = response.data.map((session: Session) => ({
            ...session,
            jsonMessages: session.jsonMessages || []
          }));
          loadSessions(sessionsWithJsonMessages);
          markAppReady();
        }
      })
      .catch(error => {
        if (ownsInitialRead()) console.error('Failed to load initial sessions:', error);
      });

    return () => {
      disposed = true;
      // Clean up all event listeners
      unsubscribeFunctions.forEach(unsubscribe => unsubscribe());
    };
  }, [loadSessions, addSession, updateSession, deleteSession, showError, gitStatusLoading, gitStatusUpdated]);
}
