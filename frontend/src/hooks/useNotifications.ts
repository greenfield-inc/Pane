import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { usePanelStore } from '../stores/panelStore';
import { API } from '../utils/api';
import { useConfigStore } from '../stores/configStore';
import { ToolPanel } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';

// Extend window interface for webkit audio context compatibility
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

interface NotificationSettings {
  playSound: boolean;
  enabled: boolean;
}

export function useNotifications() {
  const settings = useConfigStore((state) => state.config?.notifications) ?? {
    playSound: true,
    enabled: true,
  } satisfies NotificationSettings;

  // Mirror settings into a ref so the Zustand subscription callback reads the
  // latest value without needing to re-subscribe every time a toggle changes.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Window focus state synced from the main process via IPC. document.hasFocus()
  // lies when DevTools is focused or another Electron sub-window has focus, so
  // we use the BrowserWindow.isFocused() source of truth exposed by preload.
  const windowFocusedRef = useRef<boolean | null>(null);
  if (windowFocusedRef.current === null) {
    windowFocusedRef.current = document.hasFocus();
  }

  useEffect(() => {
    const electronWindow = window.electronAPI?.window;
    const electronEvents = window.electronAPI?.events;
    if (!electronWindow?.isFocused || !electronEvents?.onWindowFocusChanged) {
      return;
    }

    // Pull authoritative initial state from the main process. document.hasFocus()
    // is a cold-start fallback; if DevTools or another Electron sub-window owns
    // DOM focus at mount time, document.hasFocus() returns false even though
    // BrowserWindow.isFocused() is true. Without this pull, no focus event
    // fires until the next focus change, and notifications misfire in between.
    electronWindow.isFocused().then((focused) => {
      windowFocusedRef.current = focused;
    }).catch(() => {
      // Leave the document.hasFocus() bootstrap in place on IPC failure.
    });

    const unsubscribe = electronEvents.onWindowFocusChanged((focused) => {
      windowFocusedRef.current = focused;
    });
    return unsubscribe;
  }, []);

  // Track previous agentStatus per panelId to detect transitions.
  const prevAgentStatusRef = useRef<Record<string, AgentState>>({});

  // Project name cache keyed by project id, refreshed on mount and on project changes.
  const projectNamesRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    const loadProjects = async () => {
      const res = await API.projects.getAll();
      if (res.success && res.data) {
        projectNamesRef.current = new Map(
          // SAFETY: The named IPC/API channel contract establishes this response payload type.
          (res.data as { id: number; name: string }[]).map((p) => [p.id, p.name])
        );
      }
    };
    loadProjects();
    window.addEventListener('project-changed', loadProjects);
    return () => window.removeEventListener('project-changed', loadProjects);
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!('Notification' in window)) {
      console.warn('This browser does not support notifications');
      return false;
    }

    if (Notification.permission === 'granted') {
      return true;
    }

    if (Notification.permission === 'denied') {
      return false;
    }

    const permission = await Notification.requestPermission();
    return permission === 'granted';
  }, []);

  const playNotificationSound = useCallback(() => {
    if (!settingsRef.current.playSound) return;

    try {
      // Create a simple notification sound using Web Audio API
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('AudioContext not supported');
        return;
      }
      const audioContext = new AudioContextClass();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.1);

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch (error) {
      console.warn('Could not play notification sound:', error);
    }
  }, []);

  // showNotification fires unconditionally so that the two direct callers in
  // App.tsx (unclean-shutdown and version-update) always work. Activity gating
  // lives only inside maybeNotifyPanelIdle.
  const showNotification = useCallback((
    title: string,
    body: string,
    icon?: string,
    _triggerEvent?: string,
    _trackingKey?: string,
  ) => {
    requestPermission().then((hasPermission) => {
      if (hasPermission) {
        new Notification(title, {
          body,
          icon: icon || '/favicon.ico',
          badge: '/favicon.ico',
          tag: 'claude-code-commander',
          requireInteraction: false,
        });

        playNotificationSound();
      }
    });
  }, [playNotificationSound, requestPermission]);

  /** Resolve a panel to its session + display names, or null when unknown. */
  function findPanelContext(panelId: string) {
    const panelStoreState = usePanelStore.getState();
    let foundSessionId: string | undefined;
    let foundPanel: ToolPanel | undefined;
    for (const [sessionId, panels] of Object.entries(panelStoreState.panels)) {
      const panel = panels.find((p) => p.id === panelId);
      if (panel) {
        foundSessionId = sessionId;
        foundPanel = panel;
        break;
      }
    }
    if (!foundSessionId || !foundPanel) return null;

    const session = useSessionStore.getState().sessions.find((s) => s.id === foundSessionId);
    if (!session) return null;

    const projectName = session.projectId
      ? projectNamesRef.current.get(session.projectId) ?? ''
      : '';
    return {
      session,
      panelName: foundPanel.title || 'Terminal',
      body: projectName ? `${session.name} · ${projectName}` : session.name,
    };
  }

  function maybeNotifyPanelIdle(panelId: string) {
    const currentSettings = settingsRef.current;
    if (!currentSettings.enabled) return;

    // Sole gate: window must be blurred. Everything else (same session, same
    // panel, different panel) is moot if the user can see Pane.
    if (windowFocusedRef.current) return;

    const panelStoreState = usePanelStore.getState();

    if (panelStoreState.agentStatus[panelId] !== 'idle') return;

    const context = findPanelContext(panelId);
    if (!context) return;

    showNotification(
      `${context.panelName} finished`,
      context.body,
      undefined,
      'panel_idle',
      `idle:${panelId}:${Date.now()}`,
    );
  }

  // Fires as soon as an agent flips to blocked: it is waiting on the human, so
  // there is nothing to debounce — the sooner the user knows, the better.
  function maybeNotifyPanelBlocked(panelId: string) {
    const currentSettings = settingsRef.current;
    if (!currentSettings.enabled) return;
    if (windowFocusedRef.current) return;

    const context = findPanelContext(panelId);
    if (!context) return;

    showNotification(
      `${context.panelName} needs your input`,
      context.body,
      undefined,
      'panel_blocked',
      `blocked:${panelId}:${Date.now()}`,
    );
  }

  // Subscribe to panelStore.agentStatus (the unified per-panel agent state) and
  // notify on its transitions: -> blocked fires immediately ("needs your
  // input"); working -> idle fires after the daemon's authoritative settle.
  // Uses the unary subscribe form since panelStore does
  // not use the subscribeWithSelector middleware.
  useEffect(() => {
    // Seed from current store state so panels already tracked at mount time
    // (e.g. restored terminals, agents still running during app startup) are
    // detected on their next transition — and an agent already sitting blocked
    // when the app opens doesn't re-ping.
    prevAgentStatusRef.current = { ...usePanelStore.getState().agentStatus };
    const unsubscribe = usePanelStore.subscribe((state, previousState) => {
      if (state.agentStatusSnapshotVersion !== previousState.agentStatusSnapshotVersion) {
        prevAgentStatusRef.current = { ...state.agentStatus };
        return;
      }
      const agentStatus = state.agentStatus;
      const prev = prevAgentStatusRef.current;
      for (const [panelId, status] of Object.entries(agentStatus)) {
        const prevStatus = prev[panelId];
        if (prevStatus === status) continue;
        if (status === 'blocked') {
          maybeNotifyPanelBlocked(panelId);
        } else if (prevStatus === 'working' && status === 'idle') {
          maybeNotifyPanelIdle(panelId);
        }
      }
      prevAgentStatusRef.current = { ...agentStatus };
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscription must be created once; the notify helpers read live state via refs
  }, []);

  useEffect(() => {
    void requestPermission();
  }, [requestPermission]);

  return {
    settings,
    requestPermission,
    showNotification,
  };
}
