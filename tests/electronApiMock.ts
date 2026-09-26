import type { Page } from '@playwright/test';
import type { PaneChatAgent } from '../shared/types/paneChat';
import type { PanePermissionRequest, PanePermissionResponse } from '../shared/types/permissions';
import type {
  RemoteDaemonClientRecord,
  RemoteDaemonConfig,
  RemoteDaemonHostConfig,
  RemotePaneConnectionProfile,
  RemotePaneConnectionState,
} from '../shared/types/remoteDaemon';
import type { SubmitFeedbackRequest } from '../shared/types/feedback';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import { DEFAULT_APPEARANCE, LIGHT_THEMES, normalizeAppearance, type AppearanceConfig } from '../shared/types/appearance';
import type { DiffManifest, DiffScope, FileDiffResult } from '../shared/types/gitDiff';

type MockEventValue = JsonValue | object | undefined;
type MockEventCallback = (...args: MockEventValue[]) => void;

type AnalyticsMainEvent = {
  eventName: string;
  properties?: JsonObject;
};

type ElectronApiMockOptions = {
  analyticsConsentShown?: boolean;
  analyticsIdentity?: JsonObject;
  initialConfig?: JsonObject;
  initialWindowFocused?: boolean;
  initialPreferences?: Record<string, string>;
  platform?: 'darwin' | 'linux' | 'win32';
  /** Whether main handed the title bar to the page (Window Controls Overlay). */
  windowControlsOverlayEnabled?: boolean;
  appearanceSnapshot?: boolean;
  availableShells?: Array<Record<string, string>>;
  configReadDelayMs?: number;
  configGetFailures?: number;
  notificationsSupported?: boolean;
  mainAnalyticsEvents?: AnalyticsMainEvent[];
  initialProjects?: JsonObject[];
  initialSessions?: JsonObject[];
  initialPanels?: JsonObject[];
  initialUiState?: Partial<{
    expandedProjects: number[];
    expandedFolders: string[];
    sessionSortAscending: boolean;
    pinnedSectionExpanded: boolean;
    repositoriesSectionExpanded: boolean;
  }>;
  initialExecutions?: JsonObject[];
  diffManifests?: Record<string, DiffManifest>;
  fileDiffs?: Record<string, FileDiffResult>;
  diffManifestDelayMs?: Record<string, number>;
  fileDiffDelayMs?: Record<string, number>;
  diffManifestErrors?: Record<string, string>;
  fileDiffErrors?: Record<string, string>;
  testPerf?: boolean;
  gitCommands?: JsonObject;
  /** Seeded split layout for the session under test (panels:get-layout). */
  initialLayout?: JsonObject | null;
  initialTerminalStates?: Record<string, JsonObject>;
  /** Value returned by `git:get-github-remote` (enables git SHA/issue links). */
  githubRemoteUrl?: string | null;
  initialAgentUsage?: JsonObject;
  initialUsageReport?: JsonObject;
  initialLeaderboardStatus?: JsonObject;
  initialLeaderboard?: JsonObject;
  forcedAgentUsageError?: string;
  detectedBranch?: string | null;
  detectedBranchByPath?: Record<string, string | null>;
  mainRepoSessionDelayByProjectId?: Record<number, number>;
  mainRepoSessionErrorByProjectId?: Record<number, string>;
  activeProjectId?: number | null;
  paneChatAgentChangeDelayMs?: number;
  feedbackOutcome?: 'success' | 'failure';
  openExternalOutcome?: 'success' | 'failure';
};

export async function installElectronApiMock(page: Page, options: ElectronApiMockOptions = {}) {
  type SerializedOptions = ElectronApiMockOptions & {
    appearance: { defaults: AppearanceConfig; lightThemes: string[]; seeded: AppearanceConfig };
  };
  await page.addInitScript((mockOptions: SerializedOptions) => {
    if (mockOptions.notificationsSupported === false) {
      Reflect.deleteProperty(window, 'Notification');
    }
    function success(): Promise<{ success: true; data: null }>;
    function success<Value>(data: Value): Promise<{ success: true; data: Value }>;
    function success<Value>(data?: Value) {
      return Promise.resolve({ success: true, data: data ?? null });
    }
    const unsubscribe = () => undefined;
    const listeners = new Map<string, Set<MockEventCallback>>();
    const pendingPermissions: PanePermissionRequest[] = [];
    const feedbackSubmissions: SubmitFeedbackRequest[] = [];
    const openedExternalUrls: string[] = [];
    const diffManifestCalls: Array<{ sessionId: string; scope: DiffScope }> = [];
    const fileDiffCalls: Array<{ sessionId: string; scope: DiffScope; path: string }> = [];
    const panelCreates: JsonObject[] = [];
    const panelUpdates: Array<{ panelId: string; updates: JsonObject }> = [];
    const panelActivations: Array<{ sessionId: string; panelId: string }> = [];
    const clone = <T>(value: T): T => structuredClone(value);
    const scopeMockKey = (scope: DiffScope): string => {
      if (scope.kind === 'commit') return `commit:${scope.hash}`;
      if (scope.kind === 'commit-range') return `range:${scope.olderHash}:${scope.newerHash}`;
      if (scope.kind === 'working-tree-range') return `working-range:${scope.baseHash}`;
      return scope.kind;
    };
    const requestOption = <Value>(values: Record<string, Value> | undefined, sessionId: string, key: string): Value | undefined =>
      values?.[`${sessionId}:${key}`] ?? values?.[key];
    interface MockPreferences {
      [key: string]: string;
    }
    const preferences: MockPreferences = {
      analytics_consent_shown: mockOptions.analyticsConsentShown === false ? 'false' : 'true',
      ...clone(mockOptions.initialPreferences ?? {}),
    };
    const defaultAnalyticsIdentity = {
      distinctId: 'test',
      installId: 'install_test',
      identitySource: 'anonymous',
      appVersion: 'test',
      platform: 'linux',
      electronVersion: 'test',
      webAttributionPresent: false,
      isFirstLaunch: false,
      previousVersion: 'test',
    };
    let nextRemoteConnectionId = 1;
    const remoteDaemonConfig: RemoteDaemonConfig = {
      host: {
        config: {
          enabled: false,
          listenHost: '127.0.0.1',
          listenPort: 42137,
          pairingRequired: true,
          allowInsecureHttpOnLoopback: true,
        },
        clients: [],
      },
      client: {
        profiles: [],
        activeProfileId: null,
        mode: 'local',
      },
    };
    const remoteConnectionState: RemotePaneConnectionState = {
      mode: 'local',
      status: 'local',
      activeProfileId: null,
      activeProfileLabel: null,
      activeBaseUrl: null,
      lastError: null,
      lastSeenAt: null,
    };
    const remoteHostState = {
      enabled: false,
      status: 'inactive' as const,
      listenHost: null,
      listenPort: null,
      lastError: null,
      connectedClients: [],
      executableHealth: {
        processImage: { status: 'unknown' as const, runtimePath: null, installedPath: null, evidence: 'Executable identity has not been checked yet.' },
        restart: { status: 'unknown' as const, evidence: 'Remote daemon launcher readiness has not been checked yet.' },
        checkedAt: '1970-01-01T00:00:00.000Z',
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
    const configState: JsonObject = {
      remoteDaemon: clone(remoteDaemonConfig),
      defaultOrchestratorAgent: 'claude',
      ...clone(mockOptions.appearance.defaults),
      ...clone(mockOptions.initialConfig ?? {}),
      ...clone(mockOptions.appearance.seeded),
    };
    const paneChatSession = {
      id: '__pane_chat_session__',
      name: 'Pane Chat',
      worktreePath: '/tmp/.pane',
      prompt: '',
      status: 'stopped',
      createdAt: new Date(0).toISOString(),
      lastActivity: new Date(0).toISOString(),
      output: [],
      jsonMessages: [],
      isRunning: false,
      permissionMode: 'ignore',
      displayOrder: 0,
      isFavorite: false,
      toolType: 'none',
      archived: false,
      isHidden: true,
    };
    const createPaneChatPanel = (agent: PaneChatAgent) => ({
      id: agent === 'claude' ? '__pane_chat_terminal__' : `__pane_chat_terminal_${agent}__`,
      sessionId: '__pane_chat_session__',
      type: 'terminal',
      title: agent === 'claude' ? 'Pane Chat' : `Pane Chat - ${agent === 'codex' ? 'Codex' : 'Cursor'}`,
      state: {
        isActive: true,
        hasBeenViewed: false,
        customState: {
          initialCommand: agent === 'claude'
            ? 'claude --dangerously-skip-permissions'
            : agent === 'codex' ? 'codex --yolo' : 'cursor-agent --force --trust',
          initialInput: agent === 'cursor'
            ? 'Read /tmp/.pane/skills/pane-chat/pane-orchestrator/SKILL.md and initialize yourself as Pane Chat.'
            : 'Use the pane-orchestrator skill and initialize yourself as Pane Chat.',
          initialInputMode: 'argument',
          initialInputSubmitStrategy: 'enter',
          agentType: agent,
          isCliPanel: true,
          isCliReady: false,
        },
      },
      metadata: {
        createdAt: new Date(0).toISOString(),
        lastActiveAt: new Date(0).toISOString(),
        position: agent === 'claude' ? 0 : agent === 'codex' ? 1 : 2,
        permanent: true,
      },
    });
    const createPaneChatState = () => {
      const agent = configState.defaultOrchestratorAgent === 'codex' || configState.defaultOrchestratorAgent === 'cursor'
        ? configState.defaultOrchestratorAgent
        : 'claude';
      return {
        session: clone(paneChatSession),
        panel: clone(createPaneChatPanel(agent)),
        agent,
        cwd: '/tmp/.pane',
        guidePath: '/tmp/.pane/skills/pane-chat/pane-orchestrator/SKILL.md',
        started: false,
      };
    };
    let mockProjects = clone(mockOptions.initialProjects ?? []);
    let mockSessions = clone(mockOptions.initialSessions ?? []);
    let mockPanels = clone(mockOptions.initialPanels ?? []);
    const uiState = {
      expandedProjects: [] satisfies number[],
      expandedFolders: [] satisfies string[],
      sessionSortAscending: true,
      pinnedSectionExpanded: true,
      repositoriesSectionExpanded: true,
      ...clone(mockOptions.initialUiState ?? {}),
    };
    let mockActiveProjectId = mockOptions.activeProjectId === undefined
      ? Number(mockProjects.find((project) => project.active === true)?.id ?? null) || null
      : mockOptions.activeProjectId;
    let lastProjectUpdate: { projectId: string; updates: JsonObject } | null = null;
    let configGetCount = 0;
    let nextConfigUpdateError: string | null = null;
    let nextPreferenceSetError: string | null = null;
    let nextBackgroundColorWriteError: string | null = null;
    let remainingConfigGetFailures = mockOptions.configGetFailures ?? 0;
    const configUpdates: JsonObject[] = [];
    const backgroundColorWrites: Array<{ theme: string; color: string }> = [];
    const titleBarOverlayWrites: JsonObject[] = [];
    const preferenceWrites: Array<{ key: string; value: string }> = [];
    const sessionDeleteCalls: string[] = [];
    const sessionFavoriteToggleCalls: string[] = [];
    const gitStageAndCommitCalls: Array<{ sessionId: string; message: string }> = [];
    const invokeCalls = new Map<string, Array<{ channel: string; args: unknown[] }>>();
    let sessionsGetCount = 0;
    let terminalAckedBytes = 0;

    Object.defineProperty(window, '__paneTestPerf', {
      configurable: true,
      value: mockOptions.testPerf === true,
    });

    const subscribe = (channel: string, callback: MockEventCallback) => {
      const callbacks = listeners.get(channel) ?? new Set<MockEventCallback>();
      callbacks.add(callback);
      listeners.set(channel, callbacks);
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          listeners.delete(channel);
        }
      };
    };

    const emit = (channel: string, ...args: MockEventValue[]) => {
      const callbacks = listeners.get(channel);
      if (!callbacks) {
        return;
      }

      for (const callback of callbacks) {
        callback(...args);
      }
    };

    const syncRemoteDaemonConfig = () => {
      configState.remoteDaemon = clone(remoteDaemonConfig);
    };

    const setRemoteConnectionState = (updates: Partial<typeof remoteConnectionState>) => {
      Object.assign(remoteConnectionState, updates);
      emit('remote-daemon:connection-state-changed', clone(remoteConnectionState));
    };

    const setRemoteHostState = (updates: Partial<typeof remoteHostState>) => {
      Object.assign(remoteHostState, updates, { updatedAt: new Date().toISOString() });
      emit('remote-daemon:host-state-changed', clone(remoteHostState));
    };

    const namespace = <Overrides extends object>(overrides: Overrides) =>
      new Proxy(overrides, {
        get(target, prop: string | symbol) {
          if (prop in target) {
            return Object.getOwnPropertyDescriptor(target, prop)?.value;
          }
          return () => success();
        },
      });

    const events = new Proxy({}, {
      get: (_target, prop: string | symbol) => {
        if (prop === 'onPermissionRequest') {
          return (callback: MockEventCallback) => subscribe('permission:request', callback);
        }
        if (prop === 'onPermissionResolved') {
          return (callback: MockEventCallback) => subscribe('permission:resolved', callback);
        }
        if (prop === 'onRemoteDaemonResyncRequested') {
          return (callback: () => void) => subscribe('remote-daemon:resync-required', callback);
        }
        if (prop === 'onGitStatusUpdated') {
          return (callback: MockEventCallback) => subscribe('git-status-updated', callback);
        }
        if (prop === 'onGitStatusUpdatedBatch') {
          return (callback: MockEventCallback) => subscribe('git-status-updated-batch', callback);
        }
        if (prop === 'onTerminalOutput') {
          return (callback: MockEventCallback) => subscribe('terminal-output', callback);
        }
        if (prop === 'onTerminalFontUpdated') {
          return (callback: MockEventCallback) => subscribe('config:terminal-font-updated', callback);
        }
        if (prop === 'onNativeAppearanceUpdated') {
          return (callback: MockEventCallback) => subscribe('window:appearance-native-updated', callback);
        }
        if (prop === 'onWindowFocusChanged') {
          return (callback: MockEventCallback) => subscribe('window:focus-changed', callback);
        }
        if (prop === 'onSessionUpdated') {
          return (callback: MockEventCallback) => subscribe('session:updated', callback);
        }
        if (prop === 'onSessionDeleted') {
          return (callback: MockEventCallback) => subscribe('session:deleted', callback);
        }
        if (prop === 'onSessionCreationFailed') {
          return (callback: MockEventCallback) => subscribe('session:creation-failed', callback);
        }
        if (prop === 'onPanelCreated') {
          return (callback: MockEventCallback) => subscribe('panel:created', callback);
        }
        if (prop === 'onPanelUpdated') {
          return (callback: MockEventCallback) => subscribe('panel:updated', callback);
        }
        if (prop === 'onPanelDeleted') {
          return (callback: MockEventCallback) => subscribe('panel:deleted', callback);
        }
        if (prop === 'onConfigUpdated') {
          return (callback: MockEventCallback) => subscribe('config:updated', callback);
        }
        if (prop === 'onPanelCreated') {
          return (callback: MockEventCallback) => subscribe('panel:created', callback);
        }
        return () => unsubscribe;
      },
    });

    const invoke = (channel: string, ...args: unknown[]) => {
      const calls = invokeCalls.get(channel) ?? [];
      calls.push({ channel, args });
      if (calls.length > 500) calls.shift();
      invokeCalls.set(channel, calls);
      if (channel === 'terminal:ack') terminalAckedBytes += Number(args[1]);

      const key = args[0] === undefined ? undefined : String(args[0]);
      const value = args[1] === undefined ? undefined : String(args[1]);
      if (channel === 'panels:get-layout') {
        return success(clone(mockOptions.initialLayout ?? null));
      }
      if (channel === 'panels:update') {
        // This body runs inside the page (addInitScript), so no imported helpers are available.
        // SAFETY: The test bridge receives JSON panel updates from panelApi; exclude scalar/array arguments.
        const updates = args[1] instanceof Object && !Array.isArray(args[1]) ? args[1] as JsonObject : undefined;
        if (key && updates) {
          panelUpdates.push({ panelId: key, updates: clone(updates) });
          const panel = mockPanels.find((candidate) => candidate.id === key);
          if (panel) Object.assign(panel, clone(updates));
        }
        return success();
      }
      if (channel === 'git:get-github-remote') {
        return success(mockOptions.githubRemoteUrl ?? null);
      }
      if (channel === 'panels:shouldAutoCreate') {
        // Fixtures seed their own panels; the app must not grow a terminal.
        // The caller reads the bare boolean, not an IPC envelope.
        return Promise.resolve(false);
      }
      if (channel === 'panels:checkInitialized') {
        return Promise.resolve(Boolean(key && mockOptions.initialTerminalStates?.[key]));
      }
      if (channel === 'terminal:getState') {
        return Promise.resolve(key ? clone(mockOptions.initialTerminalStates?.[key] ?? null) : null);
      }
      if (channel === 'preferences:get') {
        return success(key ? preferences[key] ?? 'true' : 'true');
      }
      if (channel === 'preferences:set') {
        if (nextPreferenceSetError) {
          const error = nextPreferenceSetError;
          nextPreferenceSetError = null;
          return Promise.resolve({ success: false, error });
        }
        if (key) {
          const stored = value ?? '';
          preferences[key] = stored;
          preferenceWrites.push({ key, value: stored });
        }
        return success();
      }
      if (channel === 'preferences:get-all') {
        return success(clone(preferences));
      }
      if (channel === 'archive:get-progress') {
        return success(null);
      }
      return success();
    };

    const electronAPI = {
      invoke,
      events,
      window: {
        isFocused: () => Promise.resolve(mockOptions.initialWindowFocused !== false),
      },
      getPlatform: () => Promise.resolve(mockOptions.platform ?? 'linux'),
      windowControlsOverlayEnabled: mockOptions.windowControlsOverlayEnabled === true,
      appearanceSnapshot: mockOptions.appearanceSnapshot === false ? undefined : clone(mockOptions.appearance.seeded),
      setTitleBarOverlay: (colors: JsonObject) => {
        titleBarOverlayWrites.push(clone(colors));
        return success();
      },
      setBackgroundColor: (payload: { theme: string; color: string }) => {
        backgroundColorWrites.push(clone(payload));
        if (nextBackgroundColorWriteError) {
          const error = nextBackgroundColorWriteError;
          nextBackgroundColorWriteError = null;
          return Promise.resolve({ success: false, error });
        }
        return success();
      },
      getVersionInfo: () => success({
        version: 'test',
        current: 'test',
        latest: 'test',
        hasUpdate: false,
      }),
      isPackaged: () => Promise.resolve(false),
      checkForUpdates: () => success({ hasUpdate: false }),
      openExternal: (url: string) => {
        openedExternalUrls.push(url);
        if (mockOptions.openExternalOutcome === 'failure') {
          return Promise.resolve({ success: false, error: 'No browser is available.' });
        }
        // Matches preload's Promise<IPCResponse> contract; callers await this result.
        return success();
      },
      feedback: namespace({
        submit: (request: SubmitFeedbackRequest) => {
          feedbackSubmissions.push(clone(request));
          if (mockOptions.feedbackOutcome === 'failure') {
            return Promise.resolve({
              success: false,
              error: 'GitHub CLI is not authenticated.',
              data: { fallbackUrl: 'https://github.com/greenfield-inc/Pane/issues/new?title=Prefilled' },
            });
          }
          return success({ issueUrl: 'https://github.com/greenfield-inc/Pane/issues/9001' });
        },
      }),
      analytics: namespace({
        getIdentity: () => success(clone(mockOptions.analyticsIdentity ?? defaultAnalyticsIdentity)),
        onMainEvent: (callback: MockEventCallback) => {
          const remove = subscribe('analytics:main-event', callback);
          for (const event of mockOptions.mainAnalyticsEvents ?? []) {
            callback(clone(event));
          }
          return remove;
        },
        syncDistinctId: () => undefined,
        redeemAttribution: () => success(undefined),
      }),
      agentUsage: namespace({
        get: async (force = false) => {
          if (force && mockOptions.forcedAgentUsageError) {
            return { success: false, error: mockOptions.forcedAgentUsageError };
          }
          return success(clone(mockOptions.initialAgentUsage
            ?? {
            providers: [{
              id: 'codex',
              name: 'Codex',
              status: 'unavailable',
              plan: null,
              limits: [],
              fetchedAt: new Date(0).toISOString(),
              error: 'Codex usage is unavailable in this test',
            }],
            fetchedAt: new Date(0).toISOString(),
          }));
        },
      }),
      export: namespace({
        saveImage: () => success(null),
        shareImage: () => success({ method: 'clipboard' }),
      }),
      usage: namespace({
        getReport: () => success(clone(mockOptions.initialUsageReport ?? {
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 0,
            messageCount: 0,
            estimatedCostUsd: 0,
            costIncomplete: false,
            cacheSavingsUsd: 0,
          },
          series: [],
          byModel: [],
          byProject: [],
          byPane: {
            panes: [],
            unattributed: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 0,
              messageCount: 0,
              estimatedCostUsd: 0,
              costIncomplete: false,
              cacheSavingsUsd: 0,
              uncachedCostUsd: 0,
              uncachedInputTokens: 0,
              cacheHitRate: 0,
              byModel: [],
            },
          },
          rateLimits: [],
          index: {
            lastScanStartedMs: null,
            lastScanFinishedMs: null,
            filesTracked: 0,
            eventsIndexed: 0,
            missingRoots: [],
            scanning: false,
            filesScanned: 0,
            filesTotal: 0,
            lastError: null,
          },
          pricingAsOf: '2026-08-10',
        })),
        getStatus: () => success({
          lastScanStartedMs: null,
          lastScanFinishedMs: null,
          filesTracked: 0,
          eventsIndexed: 0,
          missingRoots: [],
          scanning: false,
          filesScanned: 0,
          filesTotal: 0,
          lastError: null,
        }),
        rescan: () => success({
          lastScanStartedMs: null,
          lastScanFinishedMs: null,
          filesTracked: 0,
          eventsIndexed: 0,
          missingRoots: [],
          scanning: false,
          filesScanned: 0,
          filesTotal: 0,
          lastError: null,
        }),
      }),
      leaderboard: namespace({
        getStatus: () => success(clone(mockOptions.initialLeaderboardStatus ?? {
          optIn: false,
          lastRank: null,
          lastDisplayName: null,
          lastSubmittedAtMs: null,
          doNotTrack: false,
        })),
        join: () => success({ rank: 1, displayName: '@testuser', verified: true, total: 1, installs: 1 }),
        leave: () => success(undefined),
        sendNow: () => success({ rank: 1, displayName: '@testuser', verified: true, total: 1, installs: 1 }),
        fetch: () => success(clone(mockOptions.initialLeaderboard ?? {
          windowDays: 30,
          total: 0,
          entries: [],
          generatedAtMs: Date.now(),
        })),
      }),
      config: namespace({
        get: async () => {
          configGetCount += 1;
          if (mockOptions.configReadDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, mockOptions.configReadDelayMs));
          }
          if (remainingConfigGetFailures > 0) {
            remainingConfigGetFailures -= 1;
            return { success: false, error: 'Mock config read failed' };
          }
          return success(clone(configState));
        },
        update: (updates: JsonObject) => {
          if (nextConfigUpdateError) {
            const error = nextConfigUpdateError;
            nextConfigUpdateError = null;
            return Promise.resolve({ success: false, error });
          }
          if ('systemLightTheme' in updates && !mockOptions.appearance.lightThemes.includes(String(updates.systemLightTheme))) {
            return Promise.resolve({ success: false, error: 'systemLightTheme must be a light palette' });
          }
          if ('systemDarkTheme' in updates && mockOptions.appearance.lightThemes.includes(String(updates.systemDarkTheme))) {
            return Promise.resolve({ success: false, error: 'systemDarkTheme must be a dark palette' });
          }
          Object.assign(configState, updates);
          configUpdates.push(clone(updates));
          const response = success(clone(configState));
          if ('terminalFontFamily' in updates || 'terminalFontSize' in updates) {
            queueMicrotask(() => emit('config:terminal-font-updated', {
              terminalFontFamily: configState.terminalFontFamily,
              terminalFontSize: configState.terminalFontSize,
            }));
          }
          return response;
        },
        getAvailableShells: () => success(clone(mockOptions.availableShells ?? [])),
        getMonospaceFonts: () => success([]),
        getSessionPreferences: () => success({}),
      }),
      folders: namespace({
        getByProject: () => success([]),
      }),
      git: namespace({
        detectBranch: () => success('main'),
      }),
      dialog: namespace({
        openDirectory: () => success('/tmp/pane-worktrees'),
      }),
      onboarding: namespace({
        detectEnvironment: () => success({}),
        getGitHubAuthCommand: () => success({ command: '', reason: 'ready' }),
        openGitHubAuthTerminal: () => success({ command: '', reason: 'ready', copied: false, openedTerminal: false, platform: process.platform }),
        startGitHubAuthTerminal: () => success({ terminalId: 'mock-github-auth-terminal', command: '', reason: 'ready', cols: 80, rows: 18 }),
        writeGitHubAuthTerminal: () => success(),
        resizeGitHubAuthTerminal: () => success(),
        killGitHubAuthTerminal: () => success(),
        onGitHubAuthTerminalOutput: (callback: MockEventCallback) => subscribe('onboarding:github-auth-pty-output', callback),
        onGitHubAuthTerminalExit: (callback: MockEventCallback) => subscribe('onboarding:github-auth-pty-exit', callback),
        setupDefaultRepo: () => success({}),
        supportProject: () => success({}),
      }),
      paneChat: namespace({
        getOrCreate: () => success(createPaneChatState()),
        setAgent: async (agent: 'claude' | 'codex' | 'cursor') => {
          if (mockOptions.paneChatAgentChangeDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, mockOptions.paneChatAgentChangeDelayMs));
          }
          configState.defaultOrchestratorAgent = agent === 'codex' || agent === 'cursor' ? agent : 'claude';
          return success(createPaneChatState());
        },
      }),
      panels: namespace({
        getSessionPanels: (sessionId: string) => success(
          clone(mockPanels.filter((panel) => panel.sessionId === sessionId)),
        ),
        createPanel: (sessionId: string, type: string, title: string, initialState?: JsonObject) => {
          const now = new Date().toISOString();
          const panel = {
            id: `mock-panel-${mockPanels.length + 1}`,
            sessionId,
            type,
            title,
            state: { isActive: false, customState: initialState?.customState ?? initialState ?? {} },
            metadata: { createdAt: now, lastActiveAt: now, position: mockPanels.length },
          };
          mockPanels.push(panel);
          panelCreates.push(clone(panel));
          // The main process broadcasts every created panel; SessionView relies on it
          // to place panels created outside its own create path into the layout.
          setTimeout(() => emit('panel:created', clone(panel)), 0);
          return success(clone(panel));
        },
        setActivePanel: (sessionId: string, panelId: string) => {
          panelActivations.push({ sessionId, panelId });
          return success();
        },
        shouldAutoCreate: () => success(false),
      }),
      permissions: namespace({
        getPending: () => success([...pendingPermissions]),
        respond: (requestId: string, response: PanePermissionResponse) => {
          const index = pendingPermissions.findIndex((request) => request.id === requestId);
          if (index >= 0) {
            const [request] = pendingPermissions.splice(index, 1);
            emit('permission:resolved', { request, response });
          }
          return success();
        },
      }),
      projects: namespace({
        getAll: () => success(clone(mockProjects.map((project) => ({
          ...project,
          active: mockActiveProjectId === null
            ? false
            : project.id === mockActiveProjectId,
        })))),
        getActive: () => success(clone(
          mockProjects.find((project) => project.id === mockActiveProjectId) ?? null,
        )),
        activate: (projectId: string) => {
          mockActiveProjectId = Number(projectId);
          return success();
        },
        detectBranch: (path: string) => success(
          mockOptions.detectedBranchByPath
            && Object.prototype.hasOwnProperty.call(mockOptions.detectedBranchByPath, path)
            ? mockOptions.detectedBranchByPath[path]
            : (mockOptions.detectedBranch === undefined ? 'main' : mockOptions.detectedBranch),
        ),
        listBranches: () => success([
          { name: 'origin/main', isCurrent: false, hasWorktree: false, isRemote: true },
          { name: 'main', isCurrent: true, hasWorktree: false, isRemote: false },
        ]),
        update: (projectId: string, updates: JsonObject) => {
          lastProjectUpdate = { projectId, updates: clone(updates) };
          mockProjects = mockProjects.map((project) => (
            String(project.id) === projectId
              ? { ...project, ...clone(updates), updated_at: new Date().toISOString() }
              : project
          ));
          return success(mockProjects.find((project) => String(project.id) === projectId) ?? null);
        },
        detectConfig: () => success(null),
        refreshGitStatus: () => success(),
      }),
      prompts: namespace({
        getAll: () => success([]),
      }),
      ptyHost: namespace({
        ack: () => Promise.resolve(),
        onExit: subscribe,
      }),
      resourceMonitor: namespace({
        getSnapshot: () => success(null),
        startActive: () => success(),
        stopActive: () => success(),
      }),
      sessions: namespace({
        getOrCreateMainRepoSession: async (projectId: number) => {
          const delayMs = mockOptions.mainRepoSessionDelayByProjectId?.[projectId] ?? 0;
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          const error = mockOptions.mainRepoSessionErrorByProjectId?.[projectId];
          if (error) throw new Error(error);
          return success(clone(
            mockSessions.find((session) => session.projectId === projectId && session.isMainRepo === true) ?? null,
          ));
        },
        delete: (sessionId: string) => {
          sessionDeleteCalls.push(sessionId);
          return success();
        },
        permanentDelete: () => success(),
        permanentDeleteArchived: () => success({ deletedCount: 0 }),
        toggleFavorite: (sessionId: string) => {
          sessionFavoriteToggleCalls.push(sessionId);
          return success();
        },
        getAll: () => {
          sessionsGetCount += 1;
          return success(clone(mockSessions));
        },
        getAllWithProjects: () => success(clone(mockSessions)),
        getArchivedWithProjects: () => success([]),
        getResumable: () => success([]),
        getExecutions: () => success(clone(mockOptions.initialExecutions ?? [])),
        getGitCommands: () => success(clone(mockOptions.gitCommands ?? null)),
        getDiffManifest: async (sessionId: string, scope: DiffScope) => {
          const key = scopeMockKey(scope);
          diffManifestCalls.push({ sessionId, scope: clone(scope) });
          const delay = requestOption(mockOptions.diffManifestDelayMs, sessionId, key) ?? 0;
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          if (mockOptions.testPerf === true) performance.mark('pane-diff-manifest-received');
          const failure = requestOption(mockOptions.diffManifestErrors, sessionId, key);
          if (failure) return { success: false as const, error: failure };
          const explicit = requestOption(mockOptions.diffManifests, sessionId, key);
          if (explicit) return success(clone(explicit));
          return success({
            scope,
            files: [],
            resolvedBase: { kind: 'comparison-base' as const, ref: 'main', hash: '1111111111111111111111111111111111111111' },
            resolvedTarget: { kind: 'working-tree' as const },
            stats: { additions: 0, deletions: 0, filesChanged: 0 },
          });
        },
        getFileDiff: async (sessionId: string, scope: DiffScope, request: { path: string }) => {
          const key = `${scopeMockKey(scope)}:${request.path}`;
          fileDiffCalls.push({ sessionId, scope: clone(scope), path: request.path });
          const delay = requestOption(mockOptions.fileDiffDelayMs, sessionId, key) ?? 0;
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          const failure = requestOption(mockOptions.fileDiffErrors, sessionId, key);
          if (failure) return { success: false as const, error: failure };
          const explicit = requestOption(mockOptions.fileDiffs, sessionId, key);
          if (explicit) return success(clone(explicit));
          return success({ file: { path: request.path, kind: 'modified' as const, additions: null, deletions: null, isBinary: false }, patch: '', status: 'no-longer-changed' as const });
        },
        gitStageAndCommit: (sessionId: string, message: string) => {
          gitStageAndCommitCalls.push({ sessionId, message });
          return success();
        },
      }),
      remoteDaemon: namespace({
        getConfig: () => success(clone(remoteDaemonConfig)),
        getConnectionState: () => success(clone(remoteConnectionState)),
        getHostState: () => success(clone(remoteHostState)),
        setupHost: (input: {
          dataDirectoryMode?: 'current' | 'isolated';
          paneDir?: string;
          label?: string;
          listenPort?: number;
          preferTunnel?: 'tailscale' | 'ssh' | 'manual' | 'auto';
        } = {}) => {
          const id = `remote-${nextRemoteConnectionId++}`;
          const label = input.label ?? 'Remote host';
          const listenPort = input.listenPort ?? 42137;
          const tunnelKind = input.preferTunnel === 'ssh' || input.preferTunnel === 'manual'
            ? input.preferTunnel
            : 'tailscale';
          const token = `token-${id}`;
          const client = {
            id,
            label,
            createdAt: new Date().toISOString(),
            tokenHash: `hash-${token}`,
          };
          remoteDaemonConfig.host.config = {
            ...remoteDaemonConfig.host.config,
            enabled: true,
            listenPort,
          };
          remoteDaemonConfig.host.clients.push(client);
          syncRemoteDaemonConfig();
          setRemoteHostState({
            enabled: true,
            status: 'live',
            listenHost: remoteDaemonConfig.host.config.listenHost,
            listenPort,
            lastError: null,
          });
          return success({
            dataDirectoryMode: input.dataDirectoryMode ?? 'current',
            paneDir: input.paneDir ?? '~/.pane',
            configPath: `${input.paneDir ?? '~/.pane'}/config.json`,
            label,
            listenPort,
            channel: 'stable',
            connectionCode: 'pane-remote://mock-remote-code',
            tunnel: {
              kind: tunnelKind,
              selected: true,
              note: 'Mock remote setup',
            },
            fallbackTunnelCommands: [],
            service: {
              strategy: 'manual',
              installed: false,
              started: false,
              message: 'Mock setup',
            },
            manualDaemonCommand: 'pane --daemon-headless',
            wroteConfig: true,
          });
        },
        getInteractiveSetupCommand: () => success({
          command: 'node scripts/pane-remote-setup.js --interactive-tailscale-setup',
        }),
        createConnectionPair: (input: { label?: string; baseUrl?: string }) => {
          const id = `remote-${nextRemoteConnectionId++}`;
          const label = input.label ?? 'Remote host';
          const baseUrl = input.baseUrl ?? 'http://127.0.0.1:42137';
          const token = `token-${id}`;
          const client = {
            id,
            label,
            createdAt: new Date().toISOString(),
            tokenHash: `hash-${token}`,
          };
          const profile = {
            id,
            label,
            baseUrl,
            token,
            transport: 'http+sse',
          };
          remoteDaemonConfig.host.clients.push(client);
          remoteDaemonConfig.client.profiles.push(profile);
          syncRemoteDaemonConfig();
          return success({ client, profile, token });
        },
        updateHostConfig: (updates: Partial<RemoteDaemonHostConfig>) => {
          remoteDaemonConfig.host.config = {
            ...remoteDaemonConfig.host.config,
            ...updates,
          };
          syncRemoteDaemonConfig();
          setRemoteHostState({
            enabled: Boolean(remoteDaemonConfig.host.config.enabled),
            status: remoteDaemonConfig.host.config.enabled ? 'live' : 'inactive',
            listenHost: remoteDaemonConfig.host.config.enabled ? remoteDaemonConfig.host.config.listenHost : null,
            listenPort: remoteDaemonConfig.host.config.enabled ? remoteDaemonConfig.host.config.listenPort : null,
            lastError: null,
            connectedClients: [],
          });
          return success(clone(remoteDaemonConfig.host.config));
        },
        upsertClientRecord: (record: RemoteDaemonClientRecord) => {
          const existingIndex = remoteDaemonConfig.host.clients.findIndex((client) => client.id === record.id);
          if (existingIndex >= 0) {
            remoteDaemonConfig.host.clients[existingIndex] = record;
          } else {
            remoteDaemonConfig.host.clients.push(record);
          }
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.host.clients));
        },
        deleteClientRecord: (clientId: string) => {
          remoteDaemonConfig.host.clients = remoteDaemonConfig.host.clients.filter((client) => client.id !== clientId);
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.host.clients));
        },
        upsertConnectionProfile: (profile: RemotePaneConnectionProfile) => {
          const existingIndex = remoteDaemonConfig.client.profiles.findIndex((existing) => existing.id === profile.id);
          if (existingIndex >= 0) {
            remoteDaemonConfig.client.profiles[existingIndex] = profile;
          } else {
            remoteDaemonConfig.client.profiles.push(profile);
          }
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.client.profiles));
        },
        deleteConnectionProfile: (profileId: string) => {
          remoteDaemonConfig.client.profiles = remoteDaemonConfig.client.profiles.filter((profile) => profile.id !== profileId);
          if (remoteDaemonConfig.client.activeProfileId === profileId) {
            remoteDaemonConfig.client.activeProfileId = null;
            remoteDaemonConfig.client.mode = 'local';
            setRemoteConnectionState({
              mode: 'local',
              status: 'local',
              activeProfileId: null,
              activeProfileLabel: null,
              activeBaseUrl: null,
              lastError: null,
            });
          }
          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.client));
        },
        updateClientState: (updates: { activeProfileId?: string | null; mode?: 'local' | 'remote' }) => {
          if (updates.activeProfileId !== undefined) {
            remoteDaemonConfig.client.activeProfileId = updates.activeProfileId;
          }
          if (updates.mode) {
            remoteDaemonConfig.client.mode = updates.mode;
          }

          if (remoteDaemonConfig.client.mode === 'remote' && remoteDaemonConfig.client.activeProfileId) {
            const activeProfile = remoteDaemonConfig.client.profiles.find(
              (profile) => profile.id === remoteDaemonConfig.client.activeProfileId
            );
            setRemoteConnectionState({
              mode: 'remote',
              status: activeProfile ? 'connected' : 'error',
              activeProfileId: remoteDaemonConfig.client.activeProfileId,
              activeProfileLabel: activeProfile?.label ?? null,
              activeBaseUrl: activeProfile?.baseUrl ?? null,
              lastError: activeProfile ? null : 'Missing remote profile',
            });
          } else {
            setRemoteConnectionState({
              mode: 'local',
              status: 'local',
              activeProfileId: remoteDaemonConfig.client.activeProfileId,
              activeProfileLabel: null,
              activeBaseUrl: null,
              lastError: null,
            });
          }

          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.client));
        },
        onConnectionStateChanged: (callback: MockEventCallback) =>
          subscribe('remote-daemon:connection-state-changed', callback),
        onHostStateChanged: (callback: MockEventCallback) =>
          subscribe('remote-daemon:host-state-changed', callback),
      }),
      uiState: namespace({
        getExpanded: () => success(clone(uiState)),
        saveExpanded: () => success(),
        saveExpandedProjects: (projectIds: number[]) => {
          uiState.expandedProjects = clone(projectIds);
          return success();
        },
        saveExpandedFolders: () => success(),
        saveSessionSortAscending: (ascending: boolean) => {
          uiState.sessionSortAscending = ascending;
          return success();
        },
        saveSidebarSectionExpanded: (section: 'pinned' | 'repositories', expanded: boolean) => {
          if (section === 'pinned') uiState.pinnedSectionExpanded = expanded;
          else uiState.repositoriesSectionExpanded = expanded;
          return success();
        },
      }),
    };

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        invoke,
        on: (channel: string, callback: MockEventCallback) => {
          subscribe(channel, callback);
        },
        off: () => undefined,
      },
    });

    Object.defineProperty(window, '__paneTestElectronMock', {
      configurable: true,
      value: {
        getConfig() {
          return clone(configState);
        },
        getPreferences() {
          return clone(preferences);
        },
        getConfigUpdates() {
          return clone(configUpdates);
        },
        getBackgroundColorWrites() {
          return clone(backgroundColorWrites);
        },
        getTitleBarOverlayWrites() {
          return clone(titleBarOverlayWrites);
        },
        getInvokeCalls(channel: string) {
          return clone(invokeCalls.get(channel) ?? []);
        },
        getConsoleLogCalls() {
          return clone((invokeCalls.get('console:log') ?? []).map((call) => call.args[0]));
        },
        emitNativeAppearanceUpdated(prefersDark: boolean) {
          emit('window:appearance-native-updated', { prefersDark });
        },
        emitWindowFocusChanged(focused: boolean) {
          emit('window:focus-changed', focused);
        },
        emitSessionCreationFailed(name: string, error: string) {
          emit('session:creation-failed', { name, error });
        },
        getListenerCount(channel: string) {
          return listeners.get(channel)?.size ?? 0;
        },
        getFeedbackSubmissions() {
          return clone(feedbackSubmissions);
        },
        getOpenedExternalUrls() {
          return clone(openedExternalUrls);
        },
        getPanelCreates() {
          return clone(panelCreates);
        },
        getPanelUpdates() {
          return clone(panelUpdates);
        },
        getPanelActivations() {
          return clone(panelActivations);
        },
        getPanels() {
          return clone(mockPanels);
        },
        getPreferenceWrites() {
          return clone(preferenceWrites);
        },
        failNextConfigUpdate(error: string) {
          nextConfigUpdateError = error;
        },
        failNextPreferenceSet(error: string) {
          nextPreferenceSetError = error;
        },
        failNextBackgroundColorWrite(error: string) {
          nextBackgroundColorWriteError = error;
        },
        setConfigGetFailures(count: number) {
          remainingConfigGetFailures = count;
        },
        emitPermissionRequest(request: PanePermissionRequest) {
          pendingPermissions.push(request);
          emit('permission:request', request);
        },
        emitRemoteDaemonResyncRequested() {
          emit('remote-daemon:resync-required');
        },
        getConfigReadCount() {
          return configGetCount;
        },
        setSessions(sessions: JsonObject[]) {
          mockSessions = clone(sessions);
        },
        setProjects(projects: JsonObject[], activeProjectId: number | null = null) {
          mockProjects = clone(projects);
          mockActiveProjectId = activeProjectId;
        },
        setPanels(panels: JsonObject[]) {
          mockPanels = clone(panels);
        },
        emitPanelCreated(panel: JsonObject) {
          if (!mockPanels.some(existing => existing.id === panel.id)) {
            mockPanels.push(clone(panel));
          }
          emit('panel:created', clone(panel));
        },
        emitGitStatusUpdated(sessionId: string, gitStatus: JsonObject) {
          emit('git-status-updated', { sessionId, gitStatus: clone(gitStatus) });
        },
        emitGitStatusUpdatedBatch(updates: Array<{ sessionId: string; status: JsonObject }>) {
          emit('git-status-updated-batch', clone(updates));
        },
        emitTerminalOutput(sessionId: string, data: string) {
          emit('terminal-output', { sessionId, type: 'stdout', data });
        },
        emitPanelTerminalOutput(sessionId: string, panelId: string, output: string) {
          emit('terminal-output', { sessionId, panelId, output });
        },
        getTerminalAckedBytes() {
          return terminalAckedBytes;
        },
        emitSessionUpdated(session: JsonObject) {
          emit('session:updated', clone(session));
        },
        emitSessionDeleted(sessionId: string) {
          emit('session:deleted', { id: sessionId });
        },
        emitPanelUpdated(panel: JsonObject) {
          emit('panel:updated', clone(panel));
        },
        emitPanelDeleted(panelId: string, sessionId: string) {
          emit('panel:deleted', { panelId, sessionId });
        },
        getSessionsReadCount() {
          return sessionsGetCount;
        },
        getSessionDeleteCalls() {
          return clone(sessionDeleteCalls);
        },
        getSessionFavoriteToggleCalls() {
          return clone(sessionFavoriteToggleCalls);
        },
        getGitStageAndCommitCalls() {
          return clone(gitStageAndCommitCalls);
        },
        getDiffManifestCalls() {
          return clone(diffManifestCalls);
        },
        getFileDiffCalls() {
          return clone(fileDiffCalls);
        },
        getProjectUpdates() {
          return lastProjectUpdate ? [clone(lastProjectUpdate)] : [];
        },
      },
    });
  }, {
    ...options,
    appearance: {
      defaults: DEFAULT_APPEARANCE,
      lightThemes: [...LIGHT_THEMES],
      seeded: normalizeAppearance(options.initialConfig ?? {}).appearance,
    },
  });
}
