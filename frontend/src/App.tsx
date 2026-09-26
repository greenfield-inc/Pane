import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useIPCEvents } from './hooks/useIPCEvents';
import { useNotifications } from './hooks/useNotifications';
import { useResizable } from './hooks/useResizable';
import { useHotkey } from './hooks/useHotkey';
import { useTerminalShortcuts } from './hooks/useTerminalShortcuts';
import { useShortcutHintsOverlay } from './hooks/useShortcutHintsOverlay';
import { useFocusedSurfaceScrolling } from './hooks/useFocusedSurfaceScrolling';

import { ShortcutHintsOverlay } from './components/ShortcutHintsOverlay';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import Welcome from './components/Welcome';
import Help from './components/Help';
import OnboardingDialog, {
  ONBOARDING_GH_PROMPT_SHOWN_PREFERENCE,
  ONBOARDING_REPO_SETUP_PREFERENCE,
  SupportPaneDialog,
} from './components/OnboardingDialog';
import { AboutDialog } from './components/AboutDialog';
import { DocsDialog } from './components/DocsDialog';
import { FeedbackDialog } from './components/FeedbackDialog';
import { UpdateDialog } from './components/UpdateDialog';
import { MainProcessLogger } from './components/MainProcessLogger';
import { ErrorDialog } from './components/ErrorDialog';
import { PermissionDialog } from './components/PermissionDialog';
import { DISCORD_INVITE_URL } from './components/DiscordIcon';
import { ResumeSessionsDialog } from './components/ResumeSessionsDialog';
import { useErrorStore } from './stores/errorStore';
import { useSessionStore } from './stores/sessionStore';
import { rollupSessionAgentState } from './utils/agentStatus';
import { useConfigStore } from './stores/configStore';
import { usePanelStore } from './stores/panelStore';
import { API } from './utils/api';
import { createVisibilityAwareInterval } from './utils/performanceUtils';
import { ContextMenuProvider } from './contexts/ContextMenuContext';

import { CommandPalette } from './components/CommandPalette';
import { Settings } from './components/Settings';
import { CreateSessionDialog } from './components/CreateSessionDialog';
import { AddProjectDialog } from './components/AddProjectDialog';
import { WindowTitleBar } from './components/WindowTitleBar';
import { useNavigationStore } from './stores/navigationStore';
import {
  aliasInstallIdentity,
  aliasWebVisitor,
  capture,
  captureAppFirstOpened,
  captureUnconditionally,
  flushPendingEvents,
  initPostHog,
  posthog,
  queuePendingEvent,
} from './services/posthog';
import type { VersionInfo, VersionUpdateInfo } from './types/session';
import type { AnalyticsIdentity, TerminalShortcut } from './types/config';
import type { ResumableSession } from '../../shared/types/panels';
import type { Project } from './types/project';
import type { SettingsCategoryId, SettingsOpenRequest, SettingsTarget } from './types/settings';
import type {
  PanePermissionRequest,
  PanePermissionResolvedEvent,
  PanePermissionInput,
} from '../../shared/types/daemon';
import { boundary, decodeOptionalBoundary } from '../../shared/validation/boundaryDecoder';

// Stable empty array to avoid creating new references in render
const EMPTY_TERMINAL_SHORTCUTS: TerminalShortcut[] = [];

const preferenceResponseSchema = boundary.object({
  success: boundary.boolean,
  data: boundary.optional(boundary.string),
  error: boundary.optional(boundary.string),
});
function App() {
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(false);
  const [hasCheckedAnalyticsDefault, setHasCheckedAnalyticsDefault] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [updateVersionInfo, setUpdateVersionInfo] = useState<VersionUpdateInfo | null>(null);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PanePermissionRequest | null>(null);
  const [hasResolvedStartupDialogs, setHasResolvedStartupDialogs] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [isSupportPaneOpen, setIsSupportPaneOpen] = useState(false);
  const [hasCheckedOnboarding, setHasCheckedOnboarding] = useState(false);
  const [completedOnboardingThisSession, setCompletedOnboardingThisSession] = useState(false);
  const analyticsCheckStarted = useRef(false);
  const analyticsIdentityPromise = useRef<Promise<AnalyticsIdentity | undefined> | null>(null);
  const appFirstOpenedCaptured = useRef(false);
  const onboardingCheckStarted = useRef(false);
  const welcomeCheckStarted = useRef(false);
  const supportPromptCheckStarted = useRef(false);

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategoryId>('general');
  const [settingsOpenRequest, setSettingsOpenRequest] = useState<SettingsOpenRequest>();
  const settingsRequestNonce = useRef(0);
  const [resumableSessions, setResumableSessions] = useState<ResumableSession[]>([]);
  const [isResumeDialogOpen, setIsResumeDialogOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isKeyboardShortcutsOpen, setIsKeyboardShortcutsOpen] = useState(false);
  const [isDocsOpen, setIsDocsOpen] = useState(false);
  const [showCreateSessionDialog, setShowCreateSessionDialog] = useState(false);
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const activeProjectId = useNavigationStore(s => s.activeProjectId);
  const sidebarCollapsed = useNavigationStore(s => s.sidebarCollapsed);
  const [titleBarControlsSlot, setTitleBarControlsSlot] = useState<HTMLDivElement | null>(null);
  const setSidebarCollapsed = useNavigationStore(s => s.setSidebarCollapsed);

  const handleToggleSidebar = useCallback(() => {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    } else {
      setSidebarCollapsed(true);
    }
  }, [sidebarCollapsed, setSidebarCollapsed]);
  const { currentError, clearError } = useErrorStore();
  const sessions = useSessionStore(state => state.sessions);
  const isLoaded = useSessionStore(state => state.isLoaded);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const { fetchConfig, config: appConfig } = useConfigStore();
  const terminalShortcuts = appConfig?.terminalShortcuts ?? EMPTY_TERMINAL_SHORTCUTS;
  const { isVisible: shortcutHintsVisible } = useShortcutHintsOverlay();
  useFocusedSurfaceScrolling(activeSessionId);

  const openSettings = useCallback((target?: SettingsTarget) => {
    if (target) {
      settingsRequestNonce.current += 1;
      setSettingsOpenRequest({ target, nonce: settingsRequestNonce.current });
    }
    setIsSettingsOpen(true);
  }, []);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
    setSettingsOpenRequest(undefined);
  }, []);

  const { width: sidebarWidth, startResize } = useResizable({
    defaultWidth: 352,
    minWidth: 200,
    maxWidth: 500,
    storageKey: 'pane-sidebar-width'
  });


  useIPCEvents();
  const { showNotification } = useNotifications();

  // Global panel activity status listener
  useEffect(() => {
    const unsubscribe = window.electronAPI?.events?.onPanelActivityStatus?.((data) => {
      usePanelStore.getState().setActivityStatus(data.panelId, data.status, data.lastActivityAt);
    });
    return () => unsubscribe?.();
  }, []);

  // Global agent status listener (blocked / working / done) for terminal panels.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.events?.onPanelAgentStatus?.((data) => {
      const store = usePanelStore.getState();
      const prevState = store.agentStatus[data.panelId];
      store.setAgentStatus(data.panelId, data.sessionId, data.state);

      // A background agent finishing should read as done (blue) right away —
      // mark unseen completion from the unified working -> idle transition
      // instead of waiting for the legacy 30s activity flip.
      if (prevState === 'working' && data.state === 'idle') {
        const next = usePanelStore.getState();
        const activeSessionId = useSessionStore.getState().activeSessionId;
        const sessionSettled =
          rollupSessionAgentState(next.agentStatus, next.agentStatusSession, data.sessionId) === 'idle';
        if (sessionSettled && activeSessionId !== data.sessionId) {
          next.markUnviewedCompletedActivity(data.sessionId);
        }
      }
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const clearViewedCompletedActivity = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = decodeOptionalBoundary(event.detail, boundary.object({
        sessionId: boundary.optional(boundary.string),
      }));
      const sessionId = detail?.sessionId;
      if (sessionId) {
        usePanelStore.getState().clearUnviewedCompletedActivity(sessionId);
      }
    };

    window.addEventListener('session-switched', clearViewedCompletedActivity);
    return () => window.removeEventListener('session-switched', clearViewedCompletedActivity);
  }, []);

  // Keyboard shortcuts

  useHotkey({
    id: 'open-command-palette',
    label: 'Open Command Palette',
    keys: 'mod+shift+p',
    category: 'navigation',
    action: () => setIsCommandPaletteOpen(true),
  });

  useHotkey({
    id: 'toggle-sidebar',
    label: 'Toggle Sidebar',
    keys: 'mod+b',
    category: 'view',
    action: handleToggleSidebar,
  });

  useHotkey({
    id: 'open-settings',
    label: 'Open Settings',
    keys: 'mod+,',
    category: 'navigation',
    action: () => openSettings(),
  });

  useHotkey({
    id: 'focus-sidebar',
    label: 'Focus Sidebar',
    keys: 'mod+shift+e',
    category: 'navigation',
    action: () => {
      if (sidebarCollapsed) handleToggleSidebar();
      // Land on the selected pane (or the first row) so arrow keys work from here.
      requestAnimationFrame(() => {
        const shell = document.querySelector<HTMLElement>('.pane-sidebar-shell');
        const target = shell?.querySelector<HTMLElement>('[aria-current="page"]')
          ?? shell?.querySelector<HTMLElement>('button, [tabindex="0"]');
        target?.focus();
      });
    },
  });

  useHotkey({
    id: 'open-shortcut-settings',
    label: 'Open Shortcut Settings',
    keys: 'mod+alt+/',
    category: 'shortcuts',
    action: () => {
      openSettings({ category: 'shortcuts', setting: 'terminal-shortcuts' });
    },
  });

  useHotkey({
    id: 'new-session',
    label: 'New Pane',
    keys: 'mod+n',
    category: 'session',
    action: () => {
      if (activeProject) setShowCreateSessionDialog(true);
    },
  });

  useHotkey({
    id: 'new-project',
    label: 'New Project',
    keys: 'mod+shift+n',
    category: 'navigation',
    action: () => setShowAddProjectDialog(true),
  });

  // Register terminal shortcuts (hotkey-triggered clipboard paste)
  useTerminalShortcuts();

  // Load config on app startup
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Pull after mount: the page may already have loaded before it can subscribe.
  useEffect(() => {
    const consume = window.electronAPI?.window?.consumeUncleanShutdown;
    if (!consume) return;
    void consume().then(detected => {
      if (detected) {
        showNotification(
          'Pane didn\'t shut down cleanly',
          'Your OS may have been overloaded. Check RAM usage if this keeps happening.'
        );
      }
    }).catch(error => console.error('Failed to read startup notice:', error));
  }, [showNotification]);

  // Fetch projects for global shortcuts
  useEffect(() => {
    const fetchProjects = async () => {
      const res = await API.projects.getAll();
      if (res.success && res.data) setProjects(res.data);
    };
    fetchProjects();
    const handle = () => fetchProjects();
    window.addEventListener('project-changed', handle);
    window.addEventListener('project-sessions-refresh', handle);
    return () => {
      window.removeEventListener('project-changed', handle);
      window.removeEventListener('project-sessions-refresh', handle);
    };
  }, []);

  const activeProject = useMemo(() => {
    if (activeProjectId) return projects.find(p => p.id === activeProjectId);
    return projects.find(p => p.active) || projects[0];
  }, [projects, activeProjectId]);

  const resolveAnalyticsIdentity = useCallback(async (): Promise<AnalyticsIdentity | undefined> => {
    if (!analyticsIdentityPromise.current) {
      analyticsIdentityPromise.current = (async () => {
        try {
          const identityResult = await window.electronAPI?.analytics?.getIdentity?.();
          if (identityResult?.success && identityResult.data) {
            return identityResult.data;
          }
        } catch (error) {
          console.error('[App] Error resolving analytics identity:', error);
        }
        return undefined;
      })();
    }

    const identity = await analyticsIdentityPromise.current;
    if (!identity) {
      analyticsIdentityPromise.current = null;
    }
    return identity;
  }, []);

  const captureFirstOpenOnce = useCallback(async (identity?: AnalyticsIdentity): Promise<void> => {
    if (!identity || appFirstOpenedCaptured.current) return;
    appFirstOpenedCaptured.current = true;
    await captureAppFirstOpened(identity);
  }, []);

  // Apply the default-on experiment only when no explicit legacy choice exists.
  useEffect(() => {
    if (!appConfig || hasCheckedAnalyticsDefault || analyticsCheckStarted.current) return;
    analyticsCheckStarted.current = true;
    let cancelled = false;

    const checkAnalyticsDefault = async () => {
      if (!window.electron?.invoke) {
        if (!cancelled) setHasCheckedAnalyticsDefault(true);
        return;
      }

      try {
        const [legacyConsentResult, defaultAppliedResult] = await Promise.all([
          window.electron.invoke('preferences:get', 'analytics_consent_shown'),
          window.electron.invoke('preferences:get', 'analytics_default_applied'),
        ]);
        const hasLegacyChoice = decodeOptionalBoundary(legacyConsentResult, preferenceResponseSchema)?.data === 'true';
        const hasAppliedDefault = decodeOptionalBoundary(defaultAppliedResult, preferenceResponseSchema)?.data === 'true';

        if (!hasLegacyChoice && !hasAppliedDefault) {
          const identity = await resolveAnalyticsIdentity();

          initPostHog({
            enabled: true,
            posthogApiKey: appConfig.analytics?.posthogApiKey,
            posthogHost: appConfig.analytics?.posthogHost,
            identity,
          }, { flushPendingEvents: false });

          aliasInstallIdentity(identity);
          if (identity?.webDistinctId) {
            aliasWebVisitor(identity.webDistinctId, identity.distinctId);
            void window.electronAPI?.analytics?.redeemAttribution?.();
          }

          await captureUnconditionally('analytics_default_enabled', { experiment: 'analytics_default_on' }, identity);
          await captureFirstOpenOnce(identity);
          flushPendingEvents();
          await window.electron.invoke('preferences:set', 'analytics_default_applied', 'true');
          if (appConfig.analytics?.enabled !== true) {
            await useConfigStore.getState().updateConfig({
              analytics: { ...appConfig.analytics, enabled: true },
            });
          }
        }
      } catch (error) {
        console.error('[App] Error applying analytics default:', error);
      } finally {
        if (!cancelled) setHasCheckedAnalyticsDefault(true);
      }
    };

    void checkAnalyticsDefault();
    return () => {
      cancelled = true;
      analyticsCheckStarted.current = false;
    };
  }, [appConfig, captureFirstOpenOnce, hasCheckedAnalyticsDefault, resolveAnalyticsIdentity]);

  // Initialize PostHog after config loads, then start forwarding main-process events.
  // Both must live in the same effect so buffered events aren't replayed before init.
  useEffect(() => {
    if (!appConfig || !hasCheckedAnalyticsDefault) return;

    let cleanup: (() => void) | undefined;
    let cancelled = false;

    const initializeAnalytics = async () => {
      const analyticsEnabled = appConfig.analytics?.enabled ?? false;
      let consentDecided = false;

      try {
        const [legacyConsentResult, defaultAppliedResult] = await Promise.all([
          window.electron?.invoke?.('preferences:get', 'analytics_consent_shown'),
          window.electron?.invoke?.('preferences:get', 'analytics_default_applied'),
        ]);
        consentDecided = [legacyConsentResult, defaultAppliedResult].some((result) =>
          decodeOptionalBoundary(result, preferenceResponseSchema)?.data === 'true'
        );
      } catch (error) {
        console.error('[App] Error resolving analytics consent state:', error);
      }

      const identity = await resolveAnalyticsIdentity();

      if (cancelled) return;

      initPostHog({
        enabled: analyticsEnabled,
        posthogApiKey: appConfig.analytics?.posthogApiKey,
        posthogHost: appConfig.analytics?.posthogHost,
        identity,
      }, { flushPendingEvents: false });

      if (analyticsEnabled && identity) {
        aliasInstallIdentity(identity);
        if (identity.webDistinctId) {
          aliasWebVisitor(identity.webDistinctId, identity.distinctId);
          void window.electronAPI?.analytics?.redeemAttribution?.();
        }
      }

      // Sync distinct ID to main process so shutdown analytics use the same identity
      const distinctId = identity?.distinctId || posthog.get_distinct_id();
      if (distinctId) {
        window.electronAPI?.analytics?.syncDistinctId(distinctId);
      }

      // Now that PostHog is initialized, register the IPC listener.
      // The preload buffers any events that arrived before this point and replays them.
      if (!window.electronAPI?.analytics?.onMainEvent) return;
      cleanup = window.electronAPI.analytics.onMainEvent((event) => {
        if (analyticsEnabled) {
          capture(event.eventName, event.properties);
        } else if (!consentDecided) {
          queuePendingEvent(event);
        }
      });

      if (analyticsEnabled) {
        await captureFirstOpenOnce(identity);
        flushPendingEvents();
      }
    };

    void initializeAnalytics();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [appConfig, captureFirstOpenOnce, hasCheckedAnalyticsDefault, resolveAnalyticsIdentity]);

  // CRITICAL PERFORMANCE FIX: Cleanup to prevent V8 array iteration issues
  // Uses visibility-aware interval: 60s when active, 600s when hidden
  useEffect(() => {
    const runCleanup = () => {
      const store = useSessionStore.getState();
      if (store.sessions.length > 0) {
        store.cleanupInactiveSessions();
      }
    };

    const cleanupDispose = createVisibilityAwareInterval(runCleanup, 60 * 1000);

    // Immediate cleanup when switching sessions
    const handleSessionSwitch = () => runCleanup();
    window.addEventListener('session-switched', handleSessionSwitch);

    // Pause animations when window is hidden to save battery
    const handleVisibilityChange = () => {
      document.documentElement.classList.toggle('window-hidden', document.hidden);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also pause animations on window blur — document.hidden rarely fires for a
    // visible-but-unfocused window (notably on macOS), so gate on the focus event too.
    window.electronAPI.window?.isFocused?.()
      .then((focused) => {
        document.documentElement.classList.toggle('window-blurred', !focused);
      })
      .catch(() => {
        // Default to focused if the focus query is unavailable.
      });
    const cleanupFocusChanged = window.electronAPI.events.onWindowFocusChanged((focused) => {
      document.documentElement.classList.toggle('window-blurred', !focused);
    });

    return () => {
      cleanupDispose();
      window.removeEventListener('session-switched', handleSessionSwitch);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cleanupFocusChanged();
    };
  }, []);

  // Check if onboarding should be shown after analytics defaults are resolved.
  useEffect(() => {
    if (hasCheckedOnboarding || onboardingCheckStarted.current || !hasCheckedAnalyticsDefault) return;
    onboardingCheckStarted.current = true;
    let cancelled = false;

    const checkOnboarding = async () => {
      if (!window.electron?.invoke) {
        if (!cancelled) setHasCheckedOnboarding(true);
        return;
      }
      try {
        const result = decodeOptionalBoundary(
          await window.electron.invoke('preferences:get', ONBOARDING_REPO_SETUP_PREFERENCE),
          preferenceResponseSchema,
        );
        if (result?.data !== 'true') {
          // Only show onboarding for truly new users (no existing projects).
          // Existing users who upgrade won't have this preference but already have projects.
          const projectsRes = await API.projects.getAll();
          const hasExistingProjects = projectsRes.success && projectsRes.data && projectsRes.data.length > 0;
          if (!hasExistingProjects) {
            if (!cancelled) setIsOnboardingOpen(true);
          }
        }
      } catch (error) {
        console.error('[App] Error checking onboarding:', error);
      } finally {
        if (!cancelled) setHasCheckedOnboarding(true);
      }
    };

    void checkOnboarding();
    return () => {
      cancelled = true;
      onboardingCheckStarted.current = false;
    };
  }, [hasCheckedOnboarding, hasCheckedAnalyticsDefault]);

  useEffect(() => {
    // Show the welcome screen intelligently based on user state.
    // This should only run once when the app is loaded, not when sessions change
    // Don't show welcome until onboarding check has completed and its dialog (if any) is closed
    if (!isLoaded || welcomeCheckStarted.current || !hasCheckedOnboarding || isOnboardingOpen) {
      return;
    }
    welcomeCheckStarted.current = true;
    let cancelled = false;

    const checkInitialState = async () => {
      if (!window.electron?.invoke) {
        if (!cancelled) setHasResolvedStartupDialogs(true);
        return;
      }

      try {
        // Get preferences from database
        const hideWelcomeResult = decodeOptionalBoundary(await window.electron.invoke('preferences:get', 'hide_welcome'), preferenceResponseSchema);
        const welcomeShownResult = decodeOptionalBoundary(await window.electron.invoke('preferences:get', 'welcome_shown'), preferenceResponseSchema);
        const hideWelcome = hideWelcomeResult?.data === 'true';
        const hasSeenWelcome = welcomeShownResult?.data === 'true';


        // If user explicitly said "don't show again", respect that preference
        if (!hideWelcome && !completedOnboardingThisSession) {
          try {
            const projectsResponse = await API.projects.getAll();
            const hasProjects = projectsResponse.success && projectsResponse.data && projectsResponse.data.length > 0;
            // Get sessions from the API to avoid stale closure
            const sessionsResponse = await API.sessions.getAll();
            const hasSessions = sessionsResponse.success && sessionsResponse.data && sessionsResponse.data.length > 0;

            // Show welcome if:
            // 1. First time user (no projects and never seen welcome)
            // 2. Returning user with no active data (no projects and no sessions)
            const isFirstTimeUser = !hasProjects && !hasSeenWelcome;
            const isReturningUserWithNoData = !hasProjects && !hasSessions && hasSeenWelcome;


            if (isFirstTimeUser || isReturningUserWithNoData) {
              if (!cancelled) setIsWelcomeOpen(true);
              // Mark that welcome has been shown at least once
              await window.electron.invoke('preferences:set', 'welcome_shown', 'true');
            }
          } catch (error) {
            console.error('Error checking initial state:', error);
          }
        }

      } finally {
        if (!cancelled) setHasResolvedStartupDialogs(true);
      }
    };

    void checkInitialState();
    return () => {
      cancelled = true;
      welcomeCheckStarted.current = false;
    };
  }, [isLoaded, hasCheckedOnboarding, isOnboardingOpen, completedOnboardingThisSession]);

  useEffect(() => {
    if (
      supportPromptCheckStarted.current ||
      !isLoaded ||
      !hasCheckedAnalyticsDefault ||
      !hasCheckedOnboarding ||
      isOnboardingOpen ||
      completedOnboardingThisSession ||
      !hasResolvedStartupDialogs ||
      isWelcomeOpen
    ) {
      return;
    }

    supportPromptCheckStarted.current = true;
    let cancelled = false;

    const checkDeferredSupportPrompt = async () => {
      if (!window.electron?.invoke || !window.electronAPI?.onboarding?.detectEnvironment) {
        return;
      }

      try {
        const onboardingResult = decodeOptionalBoundary(await window.electron.invoke('preferences:get', ONBOARDING_REPO_SETUP_PREFERENCE), preferenceResponseSchema);
        if (onboardingResult?.data !== 'true') return;

        const promptResult = decodeOptionalBoundary(await window.electron.invoke('preferences:get', ONBOARDING_GH_PROMPT_SHOWN_PREFERENCE), preferenceResponseSchema);
        if (promptResult?.data === 'true') return;

        const envResult = await window.electronAPI.onboarding.detectEnvironment();
        if (!envResult.success || envResult.data?.ghReady !== true) return;

        await window.electron.invoke('preferences:set', ONBOARDING_GH_PROMPT_SHOWN_PREFERENCE, 'true');
        capture('onboarding_support_prompt_shown', {
          source: 'future_launch',
          gh_status: 'gh_ready',
        });
        if (!cancelled) setIsSupportPaneOpen(true);
      } catch (error) {
        console.error('[App] Failed to check deferred onboarding support prompt:', error);
      }
    };

    void checkDeferredSupportPrompt();
    return () => {
      cancelled = true;
      supportPromptCheckStarted.current = false;
    };
  }, [
    isLoaded,
    hasCheckedAnalyticsDefault,
    hasCheckedOnboarding,
    isOnboardingOpen,
    completedOnboardingThisSession,
    hasResolvedStartupDialogs,
    isWelcomeOpen,
  ]);

  // Check for resumable sessions on startup (auto-resume feature)
  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;

    const checkResumableSessions = async () => {
      try {
        const result = await window.electronAPI.sessions.getResumable();
        if (cancelled) return;
        if (result.success && result.data && Array.isArray(result.data) && result.data.length > 0) {
          setResumableSessions(result.data);
          setIsResumeDialogOpen(true);
        }
      } catch (error) {
        console.error('[App] Failed to check for resumable sessions:', error);
      }
    };

    void checkResumableSessions();
    return () => {
      cancelled = true;
    };
  }, [isLoaded]);

  const loadNextPendingPermission = useCallback(async () => {
    try {
      const result = await API.permissions.getPending();
      if (result.success) {
        setCurrentPermissionRequest(result.data?.[0] ?? null);
      } else {
        console.error('Failed to fetch pending permission requests:', result.error);
      }
    } catch (error) {
      console.error('Failed to load pending permission requests:', error);
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.events) {
      return;
    }

    const removePermissionRequest = window.electronAPI.events.onPermissionRequest((request: PanePermissionRequest) => {
      setCurrentPermissionRequest(request);
    });
    const removePermissionResolved = window.electronAPI.events.onPermissionResolved((event: PanePermissionResolvedEvent) => {
      setCurrentPermissionRequest((currentRequest) => (
        currentRequest?.id === event.request.id ? null : currentRequest
      ));
      void loadNextPendingPermission();
    });

    void loadNextPendingPermission();

    return () => {
      removePermissionRequest();
      removePermissionResolved();
    };
  }, [loadNextPendingPermission]);

  useEffect(() => {
    // Set up version update listener
    if (!window.electronAPI?.events) return;

    const handleVersionUpdate = (versionInfo: VersionUpdateInfo) => {
      setUpdateVersionInfo(versionInfo);
      setIsUpdateDialogOpen(true);
      showNotification(
        `🚀 Update Available - Pane v${versionInfo.latest}`,
        'A new version of Pane is available!',
        '/favicon.ico',
        'version_update',
        `update:${versionInfo.latest}` // Deduplicate by version - only track once per version
      );
    };

    // Set up the listener using the events API
    const removeListener = window.electronAPI.events.onVersionUpdateAvailable(handleVersionUpdate);

    return () => {
      if (removeListener) {
        removeListener();
      }
    };
  }, [showNotification]);

  const handleUpdateRequest = useCallback((versionInfo: VersionInfo) => {
    setUpdateVersionInfo({
      ...versionInfo,
      version: versionInfo.latest,
    });
    setIsAboutOpen(false);
    setIsUpdateDialogOpen(true);
  }, []);

  const handlePermissionResponse = useCallback(async (
    requestId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: PanePermissionInput,
    message?: string,
  ) => {
    try {
      const result = await API.permissions.respond(requestId, {
        behavior,
        updatedInput,
        message,
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to respond to permission request');
      }
      await loadNextPendingPermission();
    } catch (error) {
      console.error('Failed to respond to permission request:', error);
    }
  }, [loadNextPendingPermission]);

  return (
    <ContextMenuProvider>
      <div className="pane-app-shell h-screen flex flex-col overflow-hidden bg-bg-primary">
        <WindowTitleBar projects={projects} controlsSlotRef={setTitleBarControlsSlot} />
        <div className="pane-main-layout flex flex-1 min-h-0">
        <MainProcessLogger />
        <div
          className="pane-sidebar-slot pane-reveal flex-shrink-0 overflow-hidden transition-[width] duration-reveal ease-out-strong"
          style={{ width: sidebarCollapsed ? '48px' : `${sidebarWidth}px` }}
        >
          <Sidebar
            onAboutClick={() => setIsAboutOpen(true)}
            onSettingsClick={() => openSettings()}
            onRemoteSettingsClick={() => openSettings({ category: 'remote-access' })}
            width={sidebarWidth}
            onResize={startResize}
            collapsed={sidebarCollapsed}
            onToggleCollapse={handleToggleSidebar}
            titleBarControlsSlot={titleBarControlsSlot}
            onHelpClick={() => setIsHelpOpen(true)}
            onDocsClick={() => setIsDocsOpen(true)}
            onFeedbackClick={() => setIsFeedbackOpen(true)}
            onDiscordClick={() => {
              capture('discord_clicked', { source: 'sidebar' });
              void window.electronAPI.openExternal(DISCORD_INVITE_URL);
            }}
          />
        </div>
        <SessionView />
        <Settings
          isOpen={isSettingsOpen}
          onClose={closeSettings}
          category={settingsCategory}
          onCategoryChange={setSettingsCategory}
          openRequest={settingsOpenRequest}
          onOpenRequestHandled={() => setSettingsOpenRequest(undefined)}
          onShowKeyboardShortcuts={() => {
            closeSettings();
            setIsKeyboardShortcutsOpen(true);
          }}
          onUpdate={handleUpdateRequest}
          onSendFeedback={() => setIsFeedbackOpen(true)}
        />
        <OnboardingDialog
          isOpen={isOnboardingOpen}
          onClose={() => {
            setCompletedOnboardingThisSession(true);
            setIsOnboardingOpen(false);
            window.dispatchEvent(new Event('project-changed'));
          }}
        />
        <SupportPaneDialog
          isOpen={isSupportPaneOpen}
          onClose={() => setIsSupportPaneOpen(false)}
        />
        <Welcome isOpen={isWelcomeOpen} onClose={() => setIsWelcomeOpen(false)} />
        <AboutDialog isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} onUpdate={handleUpdateRequest} />
        <FeedbackDialog isOpen={isFeedbackOpen} onClose={() => setIsFeedbackOpen(false)} />
        <UpdateDialog
          isOpen={isUpdateDialogOpen}
          onClose={() => setIsUpdateDialogOpen(false)}
          versionInfo={updateVersionInfo || undefined}
        />
        <ErrorDialog
          isOpen={!!currentError}
          onClose={clearError}
          title={currentError?.title}
          error={currentError?.error || ''}
          details={currentError?.details}
          command={currentError?.command}
        />
        <PermissionDialog
          request={currentPermissionRequest}
          onRespond={handlePermissionResponse}
          session={currentPermissionRequest ? sessions.find(s => s.id === currentPermissionRequest.sessionId) : undefined}
        />
        <ResumeSessionsDialog
          isOpen={isResumeDialogOpen}
          onClose={() => setIsResumeDialogOpen(false)}
          sessions={resumableSessions}
        />
        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setIsCommandPaletteOpen(false)}
        />
        {showCreateSessionDialog && activeProject && (
          <CreateSessionDialog
            isOpen={showCreateSessionDialog}
            onClose={() => setShowCreateSessionDialog(false)}
            projectName={activeProject.name}
            projectId={activeProject.id}
          />
        )}
        <AddProjectDialog
          isOpen={showAddProjectDialog}
          onClose={() => setShowAddProjectDialog(false)}
        />
        <Help isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
        <Help
          isOpen={isKeyboardShortcutsOpen}
          onClose={() => setIsKeyboardShortcutsOpen(false)}
          shortcutsOnly
        />
        <DocsDialog isOpen={isDocsOpen} onClose={() => setIsDocsOpen(false)} />
        <ShortcutHintsOverlay isVisible={shortcutHintsVisible} shortcuts={terminalShortcuts} />
        </div>
      </div>
    </ContextMenuProvider>
  );
}

export default App;
