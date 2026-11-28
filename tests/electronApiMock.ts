import type { Page } from '@playwright/test';
import type { AgentFarmProfileList } from '../shared/types/agentFarmProfiles';
import type { ParsedYaml, ProfilePhotos, ProfilePlugin, ProfileTreeNode, ProfilesOverview } from '../shared/types/profileEditor';
import type { ProfileSyncStatus } from '../shared/types/profileSync';
import type { ArchiveProgressSnapshot } from '../shared/types/archiveProgress';
import type { PaneChatAgent } from '../shared/types/paneChat';
import type { PanePermissionRequest, PanePermissionResponse } from '../shared/types/permissions';
import type {
  RemoteDaemonClientRecord,
  RemoteDaemonConnectedClient,
  RemoteDaemonConfig,
  RemoteDaemonHostConfig,
  RemotePaneConnectionProfile,
  RemotePaneConnectionState,
} from '../shared/types/remoteDaemon';
import type { SubmitFeedbackRequest } from '../shared/types/feedback';
import type { Loop, LoopInput, LoopSchedulePreview } from '../shared/types/loop';
import type { TailnetMachineList, WorkspaceAccessSummary } from '../shared/types/workspaceAccess';
import type { GlassesAccessState, GlassesRevokeEverywhereResult } from '../shared/types/glasses';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import { DEFAULT_APPEARANCE, normalizeAppearance, type AppearanceConfig } from '../shared/types/appearance';
import type { DiffManifest, DiffScope, FileDiffResult } from '../shared/types/gitDiff';
import type { SetupExportSummary, SetupFile, SetupImportPreview, SetupSectionId } from '../shared/types/setupTransfer';
import type { NotifyCommand, NotifySnapshot, NotifyWindowSize } from '../shared/types/notify';
import type { PaneSecretsOverview, SecretLeaseStartRequest } from '../shared/types/paneSecrets';
import type { MachineCommand, MachineConnectionsEvent, MachineState } from '../shared/types/machineConnections';
import type { RelayPairingInfo, RelayStatus } from '../shared/types/relay';
import type { ComputerRoute, ComputerRoutesReport, RemoteComputer } from '../shared/types/remoteComputers';
import type { AutopilotDocument } from '../shared/types/autopilot';
import type { TodoAction, TodoActivity, TodoAttachment, TodoCreateInput, TodoDetail, TodoSnooze, TodoStatus, TodosSnapshot } from '../shared/types/todos';

type MockEventValue = JsonValue | object | undefined;
type MockEventCallback = (...args: MockEventValue[]) => void;

type AnalyticsMainEvent = {
  eventName: string;
  properties?: JsonObject;
};

/** The to-dos `electronAPI.todos` serves: the list, each to-do's page by number, and the files its tabs read. */
export interface TodosMockOptions {
  snapshot: TodosSnapshot;
  details: Record<number, TodoDetail>;
  /** todos:create answers with this fixture to-do (its `details` entry), as if it had just been made. Absent: create is refused. */
  createdNumber?: number;
  /** autopilot.readDoc answers by path; any other path reads as the text `Contents of <path>`. */
  docs?: Record<string, AutopilotDocument>;
  /** readDoc answers an image path (png, jpg, gif, webp, svg) not in `docs` as this image (round 8, T-5). */
  imageDataUrl?: string;
  /**
   * Comments and attaches also add the rows main would (round 8, T-5): a comment becomes your message, an attach
   * "You attached <kind>: <label>", so the thread shows what was sent. Off: the thread stays as the fixture has it.
   */
  recordActivity?: boolean;
}

/** One `todos:act` the page sent, as getInvokeCalls('todos:act') returns it. */
interface TodoActCall {
  channel: 'todos:act';
  args: [TodoAction];
}

/** One `todos:create` the New to-do dialog sent (round 9): the mock records it and still refuses it. */
interface TodoCreateCall {
  channel: 'todos:create';
  args: [TodoCreateInput];
}

/** The to-do hooks on `window.__paneTestElectronMock`, for a spec's `declare global`. */
export interface TodosMockHooks {
  getInvokeCalls(channel: 'todos:act'): TodoActCall[];
  getInvokeCalls(channel: 'todos:create'): TodoCreateCall[];
  /** While on, a reply (a comment with `replyTo`) fails as main refuses a bad target; returns the words the page shows. */
  setTodoReplyRefusal(on: boolean): string;
  /** Stands in for main after a change elsewhere (an answer moves a to-do on): a new list, then todos:changed. */
  setTodosSnapshot(snapshot: TodosSnapshot): void;
  /**
   * Stands in for main switching this window to saved computer `computerId` (All machines, T-37): config names
   * it, its to-dos replace these without a todos:changed, then the host-change resync.
   */
  switchTodosHost(computerId: string, todos: Pick<TodosMockOptions, 'snapshot' | 'details'>): void;
  /** The approvals' commands sent so far (an answer, a close). */
  getNotifyCommands(): NotifyCommand[];
  /** Stands in for main: a new approvals snapshot. */
  emitNotifySnapshot(snapshot: NotifySnapshot): void;
}

/** What the mock keeps in sessionStorage, so a reload keeps what attach and detach changed. */
interface TodosMockState {
  snapshot: TodosSnapshot;
  details: Record<number, TodoDetail>;
  nextAttachmentId: number;
}

export type ElectronApiMockOptions = {
  analyticsConsentShown?: boolean;
  analyticsIdentity?: JsonObject;
  initialConfig?: JsonObject;
  initialWindowFocused?: boolean;
  uncleanShutdown?: boolean;
  initialPreferences?: Record<string, string>;
  platform?: 'darwin' | 'linux' | 'win32';
  /** Whether main handed the title bar to the page (Window Controls Overlay). */
  windowControlsOverlayEnabled?: boolean;
  appearanceSnapshot?: boolean;
  /** The chat this launch reopens: main's answer, and the outline it draws in the first frame (index.html). */
  launchChat?: { paneId: string; panelId: string; dockTerminal?: boolean };
  availableShells?: Array<Record<string, string>>;
  configReadDelayMs?: number;
  configGetFailures?: number;
  notificationsSupported?: boolean;
  mainAnalyticsEvents?: AnalyticsMainEvent[];
  initialProjects?: JsonObject[];
  /** autopilot:snapshot answer; absent: no Autopilot API, as in a build without it. */
  autopilotSnapshot?: JsonObject;
  initialSessions?: JsonObject[];
  /** The host runs an older Pane with no Pane order commands: they fail as the remote client says. */
  paneOrderUnsupported?: boolean;
  initialLoops?: Loop[];
  /** remote-daemon:list-tailnet-machines answer. */
  tailnetMachines?: TailnetMachineList;
  /** Remote connections end in `error` with this message instead of connecting. */
  remoteConnectError?: string;
  initialArchiveProgress?: ArchiveProgressSnapshot;
  archiveRetryError?: string;
  /** git:identity answer; git:set-identity marks it configured. */
  gitIdentity?: { configured: boolean; name: string; email: string };
  /** Delay before git:identity answers with the identity as it was when called. */
  gitIdentityDelayMs?: number;
  /** git:commit answers, in order; success once they run out. */
  gitCommitResults?: Array<{ success: boolean; error?: string; details?: string; code?: string }>;
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
  /** Hold these file diff reads (`<sessionId>:<path>` or `<path>`, as fileDiffs keys them) until releaseFileDiffs(). */
  holdFileDiffs?: string[];
  diffManifestErrors?: Record<string, string>;
  fileDiffErrors?: Record<string, string>;
  testPerf?: boolean;
  gitCommands?: JsonObject;
  /** Seeded split layout for the session under test (panels:get-layout). */
  initialLayout?: JsonObject | null;
  /**
   * Keep this desktop's own per-Pane layouts (uiState pane layouts) as the
   * real ui-state store does, across reloads. Off by default: every visit then
   * opens on the host's layout, as on a desktop that has never shown the Pane.
   */
  rememberPaneLayouts?: boolean;
  initialCombinedDiff?: JsonObject | null;
  initialMissionControlAgents?: JsonObject[];
  initialTerminalStates?: Record<string, JsonObject>;
  initialAgentUsage?: JsonObject;
  initialUsageReport?: JsonObject;
  initialLeaderboardStatus?: JsonObject;
  initialLeaderboard?: JsonObject;
  forcedAgentUsageError?: string;
  detectedBranch?: string | null;
  detectedBranchByPath?: Record<string, string | null>;
  mainRepoSessionDelayByProjectId?: Record<number, number>;
  /** Hold these projects' main-repository Session lookups until releaseMainRepoSessions(). */
  holdMainRepoSessionProjectIds?: number[];
  mainRepoSessionErrorByProjectId?: Record<number, string>;
  activeProjectId?: number | null;
  paneChatAgentChangeDelayMs?: number;
  /** Host aliases the mocked SSH config lists. */
  sshHosts?: string[];
  /** Hold each SSH tab-list read, as it was when asked, until releaseSshPanelReads(). */
  holdSshPanelReads?: boolean;
  /** How many SSH Session reads fail before the Session loads. */
  sshSessionReadFailures?: number;
  /** Hold each SSH open until releaseSshOpens() answers it. */
  holdSshOpens?: boolean;
  feedbackOutcome?: 'success' | 'failure';
  openExternalOutcome?: 'success' | 'failure';
  /** What the native right-click menu (app:show-context-menu) answers: the chosen item's id, or null for dismissed. */
  contextMenuChoice?: string | null;
  /** Overrides this machine's workspace status (remote-daemon:get-workspace-access). */
  workspaceAccess?: Partial<WorkspaceAccessSummary>;
  glasses?: GlassesAccessState;
  /** What "Revoke on all my computers" reports; it also revokes the device here. */
  glassesRevokeEverywhere?: GlassesRevokeEverywhereResult;
  /** "Revoke on all my computers" revokes the device here, then fails with this PaneError text. */
  glassesRevokeEverywhereError?: string;
  /** Devices connected to this computer's host right now. */
  hostConnectedClients?: RemoteDaemonConnectedClient[];
  /** setup:choose-import fails with this PaneError text instead of previewing. */
  setupImportError?: string;
  /** chat-tab:profiles, this computer's Agent Farm profiles (T-63). Absent: none, and no chatTab API without a chat panel. */
  agentFarmProfiles?: AgentFarmProfileList;
  /**
   * window.electronAPI.profiles, the Profiles tab (T-63 PR 5): the plugins, each file's content by
   * `plugin/path`, and photos. `saveError` makes every save fail with that PaneError text, as a
   * plugin Agent Farm rejects does. Absent: no Profiles API, so no Profiles row.
   */
  profileEditor?: { overview: ProfilesOverview; files: Record<string, string>; photos?: ProfilePhotos; saveError?: string; sync?: ProfileSyncStatus };
  /** Each chat tab's conversation, by panel id (plain text turns). Absent: no messages. */
  chatMessages?: Record<string, Array<{ id: string; role: 'user' | 'assistant'; text: string }>>;
  /** Serves window.electronAPI.notify with this queue snapshot; absent, the API is too. */
  notifySnapshot?: NotifySnapshot;
  /** window.electronAPI.paneSecrets: what Settings → Secrets lists. Absent parts: nothing saved, in the keychain, no leases, this computer alone, no vault. */
  paneSecrets?: Partial<PaneSecretsOverview>;
  /** window.electronAPI.machines: every machine and each machine's read answers by channel. Absent: this computer alone, with empty lists. */
  machineConnections?: { machines: MachineState[]; reads: Record<string, Record<string, JsonValue>> };
  /** machines:latency answers by machine, in ms, over the route its machine state names; `pending` never answers. Absent: null (no answer). */
  machineLatency?: Record<string, number | null | 'pending'>;
  /** machines:run answers by machine, then command type. Absent: `{ success: true }`. */
  machineRunAnswers?: Record<string, Record<string, JsonValue>>;
  /** Phone access (QR pairing). Absent: off; turning it on reaches `ready` at once with 10-minute codes. */
  relay?: {
    /** The phase turning it on reaches, with this lastError for `error`. */
    phaseWhenOn?: RelayStatus['phase'];
    lastError?: string;
    /** Turning it on meets the CA's certificate limit until this time (ISO), as `RelayStatus.certificateLimit`. */
    certificateLimitUntil?: string;
    /** How long each pairing code lasts. */
    /** How long making a code takes. */
    codeDelayMs?: number;
    codeTtlMs?: number;
    /** What the "everywhere" commands report. */
    everywhere?: { removed: string[]; notReached: string[] };
    /** This computer's relay certificate from the start. */
    certificate?: RelayStatus['certificate'];
  };
  /** Client records this computer's host holds: phones, linked computers, glasses. */
  hostClients?: RemoteDaemonClientRecord[];
  /** Saved computers with their routes, listed before the ones saved during the test. */
  computers?: RemoteComputer[];
  /**
   * Serves window.electronAPI.todos from these to-dos; absent, the API is too. Every todos:act is recorded
   * (getInvokeCalls('todos:act')), attach and detach change the fixture, and todos:changed follows each act.
   * Without autopilotSnapshot it also serves a quiet Autopilot API whose readDoc answers from `docs`.
   */
  todos?: TodosMockOptions;
  /** What dialog.openFile picks; absent: nothing (null). */
  openFilePath?: string;
};

/**
 * Opens the desktop app and waits until it reports ready. `page.goto` returns before the app's code
 * has loaded; on a cold Vite server the app can start seconds later. The app reports ready after its
 * first loaded frame, when its event listeners are subscribed and its first data is on screen, so a
 * test's own waits count from a running app. The mock drops events emitted before that.
 */
export async function gotoApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => {
    // SAFETY: installElectronApiMock defines this test-only bridge before the page loads.
    const mock = (window as typeof window & {
      __paneTestElectronMock?: { isRendererReady: () => boolean };
    }).__paneTestElectronMock;
    return mock?.isRendererReady() ?? false;
  }, undefined, { timeout: 30_000 });
}

export async function installElectronApiMock(page: Page, options: ElectronApiMockOptions = {}) {
  type SerializedOptions = ElectronApiMockOptions & {
    appearance: { defaults: AppearanceConfig; seeded: AppearanceConfig };
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
    const panelCreates: JsonObject[] = [];
    const chatSends: Array<{ panelId: string; request: JsonObject }> = [];
    const diffManifestCalls: Array<{ sessionId: string; scope: DiffScope }> = [];
    const fileDiffCalls: Array<{ sessionId: string; scope: DiffScope; path: string }> = [];
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
      sidebar_attention_inbox: 'false',
      sidebar_all_machines: 'false',
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
        clients: clone(mockOptions.hostClients ?? []),
      },
      client: {
        computers: clone(mockOptions.computers ?? []),
        profiles: [],
        activeProfileId: null,
        mode: 'local',
      },
    };
    const workspaceAccess: WorkspaceAccessSummary = {
      visibility: 'owner',
      passwordProtected: false,
      state: 'on',
      machineName: 'devbox',
      url: 'https://devbox.tail1234.ts.net:8443',
      ...mockOptions.workspaceAccess,
    };
    const glassesState: GlassesAccessState = clone(mockOptions.glasses ?? { devices: [], allowedOrigins: [], refusedOrigins: [] });
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
      connectedClients: clone(mockOptions.hostConnectedClients ?? []),
      executableHealth: {
        processImage: { status: 'unknown' as const, runtimePath: null, installedPath: null, evidence: 'Executable identity has not been checked yet.' },
        restart: { status: 'unknown' as const, evidence: 'Remote daemon launcher readiness has not been checked yet.' },
        checkedAt: '1970-01-01T00:00:00.000Z',
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    };
    const relayOptions = mockOptions.relay ?? {};
    const relayStatus: RelayStatus = {
      enabled: false, phase: 'off', id: null, domain: null, address: null, relay: null, region: null,
      localAddresses: [], certificate: relayOptions.certificate ?? null, lastError: null, certificateLimit: null,
    };
    let relayCodes = 0;
    const turnRelayOn = () => {
      const limitUntil = relayOptions.certificateLimitUntil;
      const phase = limitUntil ? 'error' : relayOptions.phaseWhenOn ?? 'ready';
      Object.assign(relayStatus, {
        enabled: true,
        phase,
        id: 'k7q2m9',
        domain: 'pane.example',
        address: 'https://k7q2m9.pane.example',
        relay: 'us.relay.pane.example',
        lastError: phase === 'error' ? relayOptions.lastError ?? (limitUntil ? "Let's Encrypt is turning away new computers" : null) : null,
        certificateLimit: limitUntil ? { until: limitUntil } : null,
      });
      remoteDaemonConfig.relay = { ...remoteDaemonConfig.relay, enabled: true };
    };
    const configState: JsonObject = {
      remoteDaemon: clone(remoteDaemonConfig),
      defaultOrchestratorAgent: 'claude',
      // Pause defaults, as configManager seeds them: resume-on-open off, auto-pause on at 48 hours.
      resumePausedOnOpen: false,
      autoPauseEnabled: true,
      autoPauseAfterHours: 48,
      ...clone(mockOptions.appearance.defaults),
      ...clone(mockOptions.initialConfig ?? {}),
      ...clone(mockOptions.appearance.seeded),
    };
    // To-dos is off by default (T-39); a spec that serves to-dos has it on unless its initialConfig says otherwise.
    if (mockOptions.todos && mockOptions.initialConfig?.todosEnabled === undefined) configState.todosEnabled = true;
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
    const mockArchivedSessions: JsonObject[] = [];
    let mockLoops = clone(mockOptions.initialLoops ?? []);
    /** A plausible loops:preview answer for the form's preset shapes. */
    const previewLoopCron = (cron: string): LoopSchedulePreview => {
      const fields = cron.trim().split(/\s+/);
      if (fields.length !== 5) return { ok: false, error: 'A cron has five fields' };
      const [minute, hour, , , weekday] = fields;
      if (!/^\d+$/.test(minute)) return { ok: false, error: 'Loops run at most once an hour' };
      // Main's wording (`describeSchedule`): "Daily at 3:00 AM".
      const at = (h: string) => `${Number(h) % 12 || 12}:${minute.padStart(2, '0')} ${Number(h) < 12 ? 'AM' : 'PM'}`;
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const step = /^\*\/(\d+)$/.exec(hour);
      const scheduleText = hour === '*' ? 'Hourly, on the hour'
        : step ? `Every ${step[1]} hours`
        : weekday === '1-5' ? `Every weekday (Monday to Friday) at ${at(hour)}`
        : weekday !== '*' ? `Weekly on ${days[Number(weekday) % 7] ?? weekday} at ${at(hour)}`
        : `Daily at ${at(hour)}`;
      // Daily shapes repeat at their time each day; hourly ones on the hour.
      const next = new Date();
      next.setSeconds(0, 0);
      next.setMinutes(Number(minute));
      const everyMs = /^\d+$/.test(hour) ? 86_400_000 : 3_600_000;
      if (everyMs === 86_400_000) next.setHours(Number(hour));
      while (next.getTime() <= Date.now()) next.setTime(next.getTime() + everyMs);
      const nextRunsAtMs = [0, 1, 2].map((index) => next.getTime() + index * everyMs);
      return { ok: true, scheduleText, nextRunAtMs: nextRunsAtMs[0], nextRunsAtMs };
    };
    let mockPanels = clone(mockOptions.initialPanels ?? []);
    let nextPanelId = mockPanels.length + 1;
    const heldSshPanelReads: Array<() => void> = [];
    const heldMainRepoSessions: Array<() => void> = [];
    const heldFileDiffs: Array<() => void> = [];
    const openSshHost = (alias: string, newTab: boolean) => {
      const sessionId = '__ssh_hosts_session__';
      const existing = newTab ? undefined : mockPanels.find(panel => sshHostOf(panel) === alias);
      if (existing) {
        setActiveMockPanel(sessionId, existing.id);
        return success({ sessionId, panelId: existing.id });
      }
      const now = new Date().toISOString();
      const panel = {
        id: `mock-panel-${nextPanelId++}`,
        sessionId,
        type: 'terminal',
        title: alias,
        state: { isActive: false, customState: { initialCommand: `ssh ${alias}`, sshHost: alias } },
        metadata: { createdAt: now, lastActiveAt: now, position: mockPanels.length },
      };
      mockPanels.push(panel);
      setActiveMockPanel(sessionId, panel.id);
      emit('panel:created', clone(panel));
      return success({ sessionId, panelId: panel.id });
    };
    const heldSshOpens: Array<(error?: string) => void> = [];
    const heldExpandedReads: Array<() => void> = [];
    let holdNextExpandedRead = false;
    let sshSessionReadFailures = mockOptions.sshSessionReadFailures ?? 0;
    const sshHostOf = (panel: { sessionId?: string; state?: unknown }) => {
      if (panel.sessionId !== '__ssh_hosts_session__') return undefined;
      // SAFETY: SSH view tabs are terminal panels whose custom state is TerminalPanelState.
      return (panel.state as { customState?: { sshHost?: string } } | undefined)?.customState?.sshHost;
    };
    const mockLayouts = new Map<string, unknown>();
    const setActiveMockPanel = (sessionId: string, panelId: string | null) => {
      for (const panel of mockPanels) {
        // SAFETY: Panel fixtures and createPanel below supply ToolPanel-shaped state objects.
        const state = panel.state as JsonObject | undefined;
        if (panel.sessionId === sessionId && state) {
          state.isActive = panel.id === panelId;
        }
      }
    };
    // Per-host navigation memory, keyed the way main keys it: '' is this computer.
    const navigationMemories = new Map<string, JsonObject>();
    // Per-host Session tiling, keyed the same way. Kept in localStorage so a
    // reload reads back what the previous page wrote, as the real per-host
    // ui-state store does.
    const sessionWorkspaceLayoutKey = '__pane_test_session_workspace_layouts__';
    const readSessionWorkspaceLayouts = (): Record<string, JsonObject> => {
      const raw = window.localStorage.getItem(sessionWorkspaceLayoutKey);
      if (!raw) return {};
      try {
        // SAFETY: only this mock writes that key, with the record below.
        return JSON.parse(raw) as Record<string, JsonObject>;
      } catch {
        return {};
      }
    };
    const writeSessionWorkspaceLayouts = (layouts: Record<string, JsonObject>): void => {
      window.localStorage.setItem(sessionWorkspaceLayoutKey, JSON.stringify(layouts));
    };
    // This desktop's per-host, per-Pane layouts, kept like the tiling above.
    const paneLayoutKey = '__pane_test_pane_layouts__';
    const readPaneLayouts = (): Record<string, JsonObject> => {
      const raw = window.localStorage.getItem(paneLayoutKey);
      if (!raw) return {};
      try {
        // SAFETY: only this mock writes that key, with the record below.
        return JSON.parse(raw) as Record<string, JsonObject>;
      } catch {
        return {};
      }
    };
    // Opened Sessions, kept per host like main keeps them ('' is this computer).
    // In localStorage so a reload reads back what the previous page saved.
    const expandedSessionsKey = '__pane_test_expanded_sessions__';
    const readExpandedSessions = (): Record<string, string[]> => {
      const raw = window.localStorage.getItem(expandedSessionsKey);
      if (!raw) return {};
      try {
        // SAFETY: only this mock writes that key, with the record below.
        return JSON.parse(raw) as Record<string, string[]>;
      } catch {
        return {};
      }
    };
    const paneLayoutId = (hostId: string | null, paneId: string) => `${hostId ?? ''}/${paneId}`;
    const uiState = {
      expandedProjects: [] satisfies number[],
      expandedFolders: [] satisfies string[],
      sessionSortAscending: false,
      pinnedSectionExpanded: true,
      repositoriesSectionExpanded: true,
      sessionsSectionExpanded: true,
      expandedSessions: [] satisfies string[],
      archivedSectionExpanded: false,
      expandedArchivedProjects: [] satisfies number[],
      ...clone(mockOptions.initialUiState ?? {}),
    };
    let mockActiveProjectId = mockOptions.activeProjectId === undefined
      ? Number(mockProjects.find((project) => project.active === true)?.id ?? null) || null
      : mockOptions.activeProjectId;
    let lastProjectUpdate: { projectId: string; updates: JsonObject } | null = null;
    let configGetCount = 0;
    // The app reports ready after its first loaded frame, when its event listeners are subscribed.
    let rendererReady = false;
    let nextConfigUpdateError: string | null = null;
    let nextPreferenceSetError: string | null = null;
    let nextBackgroundColorWriteError: string | null = null;
    let remainingConfigGetFailures = mockOptions.configGetFailures ?? 0;
    const configUpdates: JsonObject[] = [];
    const backgroundColorWrites: Array<{ theme: string; color: string }> = [];
    const titleBarOverlayWrites: JsonObject[] = [];
    const preferenceWrites: Array<{ key: string; value: string }> = [];
    const sessionDeleteCalls: string[] = [];
    const sessionRestoreCalls: string[] = [];
    const sessionFavoriteToggleCalls: string[] = [];
    const paneOrderCalls: JsonValue[] = [];
    let newPanePlacement: 'top' | 'bottom' | null = null;
    const hostOutdated = (channel: string) => Promise.reject(new Error(`Error invoking remote method '${channel}': Error: build-box runs an older Pane that does not have this command (${channel}). Nothing was changed. Next: Update Pane on build-box (run \`runpane update\` there), then try again.`));
    const paneTime = (pane: JsonObject) => Date.parse(String(pane.createdAt ?? '')) || 0;
    /** The host's order: highest displayOrder first, then newest. */
    const projectPanes = (projectId: number) => mockSessions
      .filter((pane) => pane.projectId === projectId && pane.archived !== true && pane.isMainRepo !== true)
      .sort((a, b) => {
        const ao = Number(a.displayOrder ?? Number.NaN);
        const bo = Number(b.displayOrder ?? Number.NaN);
        return Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo ? bo - ao : paneTime(b) - paneTime(a);
      });
    const savePaneOrder = (ordered: JsonObject[]) => {
      ordered.forEach((pane, index) => {
        const displayOrder = ordered.length - 1 - index;
        if (pane.displayOrder === displayOrder) return;
        pane.displayOrder = displayOrder;
        emit('session:updated', clone(pane));
      });
    };
    const gitStageAndCommitCalls: Array<{ sessionId: string; message: string }> = [];
    let gitIdentity = mockOptions.gitIdentity ? clone(mockOptions.gitIdentity) : null;
    const gitCommitResults = clone(mockOptions.gitCommitResults ?? []);
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

    let archiveProgress = mockOptions.initialArchiveProgress ?? null;

    const emit = (channel: string, ...args: MockEventValue[]) => {
      const callbacks = listeners.get(channel);
      if (!callbacks) {
        return;
      }

      for (const callback of callbacks) {
        callback(...args);
      }
    };

    // The seeded computers, then one computer per connection saved during the test (main converts the same way).
    const seededComputers: RemoteComputer[] = clone(mockOptions.computers ?? []);
    const computerOfProfile = (profile: RemotePaneConnectionProfile): RemoteComputer => {
      const kind = profile.relay ? 'relay' : profile.tailnetMachine ? 'tailscale' : 'public';
      const route: ComputerRoute = {
        id: `${kind}:${profile.baseUrl}`,
        kind,
        source: profile.relay ? 'link' : profile.tailnetMachine ? 'found' : 'manual',
        baseUrl: profile.baseUrl,
        token: profile.token,
      };
      if (profile.tailnetMachine) route.tailnetMachine = profile.tailnetMachine;
      if (profile.tailnetDomain) route.tailnetDomain = profile.tailnetDomain;
      if (profile.relay) route.relay = { computerId: profile.relay.computerId, fingerprint: profile.relay.fingerprint };
      return { id: profile.id, label: profile.label, routes: [route] };
    };
    const syncRemoteDaemonConfig = () => {
      const seededIds = new Set(seededComputers.map((computer) => computer.id));
      remoteDaemonConfig.client.computers = [
        ...seededComputers,
        ...remoteDaemonConfig.client.profiles.filter((profile) => !seededIds.has(profile.id)).map(computerOfProfile),
      ];
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
        if (prop === 'onPaneFocusRequested') {
          return (callback: MockEventCallback) => subscribe('pane:focus-requested', callback);
        }
        if (prop === 'onPaneOpenLink') {
          return (callback: MockEventCallback) => subscribe('pane:open-link', callback);
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
        if (prop === 'onTerminalCliReady') {
          return (callback: MockEventCallback) => subscribe('terminal:cliReady', callback);
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
        if (prop === 'onSessionCreated') {
          return (callback: MockEventCallback) => subscribe('session:created', callback);
        }
        if (prop === 'onLoopsChanged') {
          return (callback: MockEventCallback) => subscribe('loops:changed', callback);
        }
        if (prop === 'onSessionsLoaded') {
          return (callback: MockEventCallback) => subscribe('sessions:loaded', callback);
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
        if (prop === 'onPanelActivationRequested') {
          return (callback: MockEventCallback) => subscribe('panel:activeChanged', callback);
        }
        if (prop === 'onPanelDeleted') {
          return (callback: MockEventCallback) => subscribe('panel:deleted', callback);
        }
        if (prop === 'onPanelAgentStatus') {
          return (callback: MockEventCallback) => subscribe('panel:agent-status', callback);
        }
        if (prop === 'onArchiveProgress') {
          return (callback: MockEventCallback) => subscribe('archive:progress', callback);
        }
        if (prop === 'onRelayStatusChanged') {
          return (callback: MockEventCallback) => subscribe('relay:status-changed', callback);
        }
        if (prop === 'onConfigUpdated') {
          return (callback: MockEventCallback) => subscribe('config:updated', callback);
        }
        if (prop === 'onRelayPaired') {
          return (callback: MockEventCallback) => subscribe('relay:paired', callback);
        }
        if (prop === 'onRestartToUpdateState') {
          return (callback: MockEventCallback) => subscribe('updater:restart-state', callback);
        }
        if (prop === 'onTodosChanged') {
          return (callback: MockEventCallback) => subscribe('todos:changed', callback);
        }
        if (prop === 'onStartLinkRequest') {
          return (callback: MockEventCallback) => subscribe('pane:start-link-request', callback);
        }
        return () => unsubscribe;
      },
    });

    const persistPreference = (key: string, value: string): { success: true } | { success: false; error: string } => {
      if (nextPreferenceSetError) {
        const error = nextPreferenceSetError;
        nextPreferenceSetError = null;
        return { success: false, error };
      }
      if (key) {
        preferences[key] = value;
        preferenceWrites.push({ key, value });
      }
      return { success: true };
    };

    const trackCall = (channel: string, args: unknown[]) => {
      const calls = invokeCalls.get(channel) ?? [];
      calls.push({ channel, args });
      if (calls.length > 500) calls.shift();
      invokeCalls.set(channel, calls);
    };

    // Settings › Import & Export: this computer's setup and one file to import.
    const setupSummary: SetupExportSummary = {
      rows: [
        { id: 'agentPresets', count: 2, leftOut: [], agents: ['Claude Code', 'Codex'] },
        { id: 'customCommands', count: 2, leftOut: [{ section: 'customCommands', name: 'deploy-prod' }] },
        { id: 'runScripts', count: 4, leftOut: [] },
        { id: 'skills', count: 2, leftOut: [], skills: { homeSkill: true, registerMcp: true } },
        { id: 'terminalShortcuts', count: 4, leftOut: [] },
        { id: 'worktreeFileSync', count: 3, leftOut: [] },
        { id: 'appearance', count: 1, leftOut: [], appearance: { mode: 'fixed', theme: 'dark', light: 'light-rounded', dark: 'dark' } },
        { id: 'preferences', count: 14, leftOut: [] },
      ],
    };
    const setupPreview: SetupImportPreview = {
      fileName: 'pane-setup-2026-10-26.json',
      appVersion: '2.4.202',
      platform: 'darwin',
      otherPlatform: false,
      file: {
        kind: 'pane-setup',
        version: 1,
        exportedAt: '2026-10-26T22:40:00Z',
        appVersion: '2.4.202',
        platform: 'darwin',
        sections: { customCommands: [{ name: 'lint-fix', command: 'pnpm lint --fix' }] },
      },
      sections: [
        {
          id: 'customCommands', changes: 2, added: 1, replaced: 1, keyInUse: 0,
          items: [
            { kind: 'new', name: 'lint-fix', text: 'pnpm lint --fix' },
            { kind: 'replaces', name: 'review', text: 'claude "/review --strict"', was: 'claude "/review"' },
          ],
          apply: {
            config: {
              customCommands: [
                { name: 'lint-fix', command: 'pnpm lint --fix' },
                { name: 'review', command: 'claude "/review --strict"' },
              ],
            },
          },
        },
        {
          id: 'runScripts', changes: 1, added: 1, replaced: 0, keyInUse: 0, repositories: { matched: 1, total: 2 },
          items: [
            { kind: 'new', name: 'acme-web', field: 'Run Commands', text: 'pnpm dev' },
            { kind: 'skipped', name: 'marketing-site', reason: 'not in Pane on this computer', cause: 'missing' },
          ],
          apply: { projects: [{ id: 1, name: 'acme-web', updates: { run_script: 'pnpm dev' } }] },
        },
        { id: 'terminalShortcuts', changes: 0, added: 0, replaced: 0, keyInUse: 0, items: [], apply: {} },
        {
          id: 'preferences', changes: 1, added: 0, replaced: 0, keyInUse: 0, items: [],
          apply: { preferences: { sidebar_pane_row_layout: 'two-row' } },
        },
      ],
    };

    const uploads = new Map<string, { fileName: string; received: number }>();
    const invoke = (channel: string, ...args: unknown[]) => {
      trackCall(channel, args);
      if (channel === 'terminal:ack') terminalAckedBytes += Number(args[1]);

      const key = args[0] === undefined ? undefined : String(args[0]);
      const value = args[1] === undefined ? undefined : String(args[1]);
      if (channel === 'terminal:get-shell-settings') {
        // Raw result, like the host: Windows shells only on a Windows host.
        return Promise.resolve({
          shells: mockOptions.platform === 'win32' ? clone(mockOptions.availableShells ?? []) : [],
          preferredShell: configState.preferredShell ?? 'auto',
        });
      }
      if (channel === 'terminal:set-preferred-shell') {
        configState.preferredShell = String(args[0]);
        return Promise.resolve(undefined);
      }
      // The host's chunked upload (terminal and chat files): bytes are counted, and a commit lands the file under its name.
      if (channel === 'terminal:upload-start') {
        // SAFETY: the shared upload loop sends an UploadStart object.
        const start = args[0] as { uploadId: string; fileName: string; size: number };
        const upload = uploads.get(start.uploadId) ?? { fileName: start.fileName, received: 0 };
        uploads.set(start.uploadId, upload);
        return Promise.resolve({ receivedBytes: upload.received });
      }
      if (channel === 'terminal:upload-chunk') {
        const upload = uploads.get(String(args[0]));
        if (!upload) return Promise.reject(new Error('Upload not found. Start it again.'));
        if (Number(args[1]) === upload.received) upload.received += atob(String(args[2])).length;
        return Promise.resolve({ receivedBytes: upload.received });
      }
      if (channel === 'terminal:upload-commit') {
        const upload = uploads.get(String(args[0]));
        if (!upload) return Promise.reject(new Error('Upload not found. Start it again.'));
        return Promise.resolve({ filePath: `/tmp/pane-uploads/${upload.fileName}` });
      }
      if (channel === 'terminal:upload-cancel') {
        uploads.delete(String(args[0]));
        return Promise.resolve(undefined);
      }
      if (channel === 'app:show-context-menu') {
        return Promise.resolve(mockOptions.contextMenuChoice ?? null);
      }
      if (channel === 'ports:list') {
        return Promise.resolve({ host: 'mock-host', ports: [] });
      }
      if (channel === 'relay:status') return Promise.resolve(clone(relayStatus));
      if (channel === 'relay:set-enabled') {
        if (args[0] === true) turnRelayOn();
        else Object.assign(relayStatus, { enabled: false, phase: 'off' });
        queueMicrotask(() => emit('relay:status-changed', clone(relayStatus)));
        return Promise.resolve(clone(relayStatus));
      }
      if (channel === 'relay:pairing-code') {
        if (relayStatus.phase !== 'ready') return Promise.reject(new Error("Error invoking remote method 'relay:pairing-code': Error [ERR_RELAY_NOT_READY]: This computer isn't ready to pair yet."));
        relayCodes += 1;
        const code: RelayPairingInfo = {
          // The level is in the address, so a spec can tell which code is on screen.
          url: `https://pane.example/pair#s=${JSON.stringify(args[0] ?? null).includes('"read"') ? 'read-' : ''}secret-${relayCodes}&c=k7q2m9&n=devbox`,
          expiresAt: new Date(Date.now() + (relayOptions.codeTtlMs ?? 10 * 60_000)).toISOString(),
        };
        return new Promise((resolve) => { window.setTimeout(() => resolve(code), relayOptions.codeDelayMs ?? 0); });
      }
      if (channel === 'relay:set-address') {
        const address = args[0] == null ? '' : String(args[0]).trim();
        if (address && !/^[a-z0-9.-]+(:\d{1,5})?$/iu.test(address)) {
          return Promise.reject(new Error(`Error invoking remote method 'relay:set-address': Error [ERR_RELAY_ADDRESS_INVALID]: "${address}" is not a relay address. Next: Enter a host name, such as relay.example.com, optionally with :port.`));
        }
        remoteDaemonConfig.relay = { enabled: relayStatus.enabled };
        if (address) remoteDaemonConfig.relay.relayAddress = address;
        syncRemoteDaemonConfig();
        return Promise.resolve(clone(relayStatus));
      }
      if (channel === 'computers:set-public-url') {
        // SAFETY: the renderer sends { url } to this command.
        const { url } = args[0] as { url: string | null };
        if (url !== null && !url.startsWith('https://')) {
          return Promise.reject(new Error(`Error invoking remote method 'computers:set-public-url': Error [ERR_PUBLIC_URL_NOT_HTTPS]: ${url} is not an HTTPS address. Next: Enter the https:// address your proxy serves.`));
        }
        if (url === null) delete remoteDaemonConfig.host.publicUrl;
        else remoteDaemonConfig.host.publicUrl = url;
        syncRemoteDaemonConfig();
        const report: ComputerRoutesReport = { machineId: 'install-devbox', name: 'devbox' };
        if (url) report.publicUrl = url;
        return Promise.resolve(report);
      }
      if (channel === 'computers:set-mine') {
        // SAFETY: the renderer sends { computerId, mine } to this command.
        const { computerId, mine } = args[0] as { computerId: string; mine: boolean | null };
        const computer = seededComputers.find((candidate) => candidate.id === computerId);
        if (!computer) return Promise.reject(new Error(`Error invoking remote method 'computers:set-mine': Error: No saved computer ${computerId}.`));
        if (mine === null) delete computer.mineOverride;
        else computer.mineOverride = mine;
        syncRemoteDaemonConfig();
        return Promise.resolve(clone(computer));
      }
      if (channel === 'computers:reorder-routes') {
        // SAFETY: the renderer sends { computerId, routeIds } to this command.
        const { computerId, routeIds } = args[0] as { computerId: string; routeIds: string[] };
        const computer = seededComputers.find((candidate) => candidate.id === computerId);
        if (!computer) return Promise.reject(new Error(`Error invoking remote method 'computers:reorder-routes': Error: No saved computer ${computerId}.`));
        computer.routes = routeIds.flatMap((routeId) => computer.routes.filter((route) => route.id === routeId));
        syncRemoteDaemonConfig();
        return Promise.resolve(clone(computer));
      }
      if (channel === 'relay:remove-phone-everywhere' || channel === 'relay:unlink-computer-everywhere') {
        // SAFETY: the renderer sends { clientId } or { computerId } to these two commands.
        const target = args[0] as { clientId?: string; computerId?: string };
        remoteDaemonConfig.host.clients = remoteDaemonConfig.host.clients.filter((client) => client.id !== target.clientId && (!target.computerId || client.computerId !== target.computerId));
        // Unlinking a computer drops its relay routes; a computer left with none goes from the list.
        for (const computer of seededComputers) {
          computer.routes = computer.routes.filter((route) => !target.computerId || route.relay?.computerId !== target.computerId);
        }
        seededComputers.splice(0, seededComputers.length, ...seededComputers.filter((computer) => computer.routes.length > 0));
        syncRemoteDaemonConfig();
        return Promise.resolve(clone(relayOptions.everywhere ?? { removed: ['devbox'], notReached: [] }));
      }
      if (channel === 'panels:get-layout') {
        return success(clone(key && mockLayouts.has(key) ? mockLayouts.get(key) : mockOptions.initialLayout ?? null));
      }
      if (channel === 'panels:set-layout') {
        if (key) mockLayouts.set(key, clone(args[1] ?? null));
        return success();
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
      if (channel === 'preferences:set') return Promise.resolve(persistPreference(key ?? '', value ?? ''));
      if (channel === 'preferences:get-all') {
        return success(clone(preferences));
      }
      if (channel === 'archive:get-progress') {
        return success(clone(archiveProgress));
      }
      if (channel === 'archive:retry-cleanup' && mockOptions.archiveRetryError) {
        return Promise.resolve({ success: false, error: mockOptions.archiveRetryError });
      }
      if (channel === 'git:identity' && gitIdentity) {
        const snapshot = clone(gitIdentity);
        return new Promise(resolve => setTimeout(resolve, mockOptions.gitIdentityDelayMs ?? 0))
          .then(() => success(snapshot));
      }
      if (channel === 'git:set-identity' && gitIdentity) {
        gitIdentity = { ...gitIdentity, configured: true };
        return success();
      }
      if (channel === 'git:commit') {
        return Promise.resolve(gitCommitResults.shift() ?? { success: true });
      }
      return success();
    };

    let uncleanShutdownPending = mockOptions.uncleanShutdown === true;
    let notifySnapshot = mockOptions.notifySnapshot ? clone(mockOptions.notifySnapshot) : null;
    // Like main: the snapshot's settings are the saved notify settings over the defaults.
    const applyNotifyConfig = () => {
      if (notifySnapshot && configState.notify && !Array.isArray(configState.notify) && configState.notify instanceof Object) {
        Object.assign(notifySnapshot.settings, configState.notify);
      }
    };
    applyNotifyConfig();
    const notifyCommands: NotifyCommand[] = [];
    const notifyWindowSizes: NotifyWindowSize[] = [];
    const notifyApi = notifySnapshot ? {
      getSnapshot: () => Promise.resolve(clone(notifySnapshot)),
      run: (command: NotifyCommand) => {
        notifyCommands.push(clone(command));
        return Promise.resolve();
      },
      onSnapshot: (callback: MockEventCallback) => subscribe('notify:snapshot', callback),
      onChime: (callback: MockEventCallback) => subscribe('notify:chime', callback),
      onNavigate: (callback: MockEventCallback) => subscribe('notify:navigate', callback),
      resizeWindow: (size: NotifyWindowSize) => { notifyWindowSizes.push(clone(size)); },
      focusWindow: () => Promise.resolve(),
    } : undefined;
    const machineConnections = mockOptions.machineConnections ?? {
      machines: [{ id: 'local', label: 'This computer', kind: 'local' as const, status: 'online' as const, offlineSince: null }],
      reads: {},
    };
    const machineRuns: Array<{ machineId: string; command: MachineCommand }> = [];
    const machineLatencyCalls: string[] = [];
    const machineReads: Array<{ machineId: string; channel: string }> = [];
    const machineListeners = new Set<(event: MachineConnectionsEvent) => void>();
    /** The usage report this computer answers, on `usage.getReport` and as a `machines:read`. */
    const usageReport = () => clone(mockOptions.initialUsageReport ?? {
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
    });
    const machinesApi = {
      list: () => Promise.resolve(clone(machineConnections.machines)),
      read: async (machineId: string, channel: string, args: unknown[] = []) => {
        machineReads.push({ machineId, channel });
        const answers = machineConnections.reads[machineId] ?? {};
        if (channel in answers) return { machineId, data: clone(answers[channel]) };
        // This computer answers with the same command `usage.getReport` runs, so a test that wraps it reaches both.
        if (machineId === 'local' && channel === 'usage:get-report') return { machineId, data: await window.electronAPI.usage.getReport(...args) };
        return { machineId, data: { success: true, data: [] } };
      },
      run: (machineId: string, command: MachineCommand) => {
        machineRuns.push({ machineId, command: clone(command) });
        const answer = mockOptions.machineRunAnswers?.[machineId]?.[command.type];
        return Promise.resolve({ machineId, data: clone(answer ?? { success: true }) });
      },
      retry: () => Promise.resolve(),
      latency: (machineId: string) => {
        machineLatencyCalls.push(machineId);
        const answer = mockOptions.machineLatency?.[machineId] ?? null;
        // Measured over the route main's connection is on, as main answers.
        const routeId = machineConnections.machines.find((machine) => machine.id === machineId)?.routeId ?? null;
        return answer === 'pending' ? new Promise<{ ms: number | null; routeId: string | null }>(() => undefined) : Promise.resolve({ ms: answer, routeId });
      },
      onEvent: (callback: (event: MachineConnectionsEvent) => void) => {
        machineListeners.add(callback);
        return () => { machineListeners.delete(callback); };
      },
    };
    const paneSecrets: PaneSecretsOverview = clone({
      secrets: [],
      references: [],
      storage: { kind: 'keychain' as const, encrypted: true },
      leases: [],
      machines: [{ id: 'local', name: 'This computer', online: true, refusal: null, memoryOnly: false }],
      leaseLengths: {},
      moveVault: null,
      loginUses: [],
      ...mockOptions.paneSecrets,
    });
    /** What Settings asked of paneSecrets; values are never recorded. */
    type PaneSecretCall =
      | { action: 'set' | 'delete' | 'moveToOnePassword'; project: string; name: string; sites?: string[] }
      | { action: 'setReference'; project: string; name: string; reference: string }
      | { action: 'setSites'; project: string; name: string; sites: string[] }
      | { action: 'startLease'; request: SecretLeaseStartRequest }
      | { action: 'endLease'; leaseId: string }
      | { action: 'endAllLeases' | 'listVaults' }
      | { action: 'setLeaseLength'; project: string; lengthMs: number }
      | { action: 'setMoveVault'; vault: string };
    const paneSecretCalls: PaneSecretCall[] = [];
    const sameSecret = (project: string, name: string) => (secret: { project: string; name: string }) => secret.project === project && secret.name === name;
    const addReference = (project: string, name: string, reference: string) => {
      paneSecrets.secrets = paneSecrets.secrets.filter((secret) => !sameSecret(project, name)(secret));
      paneSecrets.references = [
        ...paneSecrets.references.filter((secret) => !sameSecret(project, name)(secret)),
        { project, name, reference, updatedAt: new Date().toISOString(), machine: 'this-mac' },
      ];
    };
    let leaseCount = 0;
    const paneSecretsApi = {
      list: () => Promise.resolve({ success: true, data: clone(paneSecrets) }),
      set: (project: string, name: string, _value: string, sites?: string[]) => {
        paneSecretCalls.push(sites ? { action: 'set', project, name, sites } : { action: 'set', project, name });
        const replaced = paneSecrets.secrets.some(sameSecret(project, name));
        paneSecrets.secrets = [
          ...paneSecrets.secrets.filter((secret) => !sameSecret(project, name)(secret)),
          { project, name, sites, updatedAt: new Date().toISOString(), machine: 'this-mac' },
        ];
        return Promise.resolve({ success: true, data: replaced });
      },
      setSites: (project: string, name: string, sites: string[]) => {
        paneSecretCalls.push({ action: 'setSites', project, name, sites });
        const withSites = <T extends { project: string; name: string }>(secret: T) => (sameSecret(project, name)(secret) ? { ...secret, sites } : secret);
        paneSecrets.secrets = paneSecrets.secrets.map(withSites);
        paneSecrets.references = paneSecrets.references.map(withSites);
        return Promise.resolve({ success: true, data: true });
      },
      delete: (project: string, name: string) => {
        paneSecretCalls.push({ action: 'delete', project, name });
        paneSecrets.secrets = paneSecrets.secrets.filter((secret) => !sameSecret(project, name)(secret));
        paneSecrets.references = paneSecrets.references.filter((secret) => !sameSecret(project, name)(secret));
        return Promise.resolve({ success: true, data: true });
      },
      setReference: (project: string, name: string, reference: string) => {
        paneSecretCalls.push({ action: 'setReference', project, name, reference });
        const replaced = paneSecrets.secrets.some(sameSecret(project, name));
        addReference(project, name, reference);
        return Promise.resolve({ success: true, data: replaced });
      },
      startLease: (request: SecretLeaseStartRequest) => {
        paneSecretCalls.push({ action: 'startLease', request: clone(request) });
        leaseCount += 1;
        const id = `lease-${leaseCount}`;
        const grantedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + (paneSecrets.leaseLengths[request.project] ?? 24 * 60 * 60 * 1000)).toISOString();
        const holders = paneSecrets.machines.filter((machine) => request.machines.includes(machine.id));
        for (const machine of holders) {
          paneSecrets.leases.push({
            id, project: request.project, names: [...request.names], grantedAt, expiresAt, requestedBy: 'you',
            grantedOn: 'this-mac', memoryOnly: machine.memoryOnly, machineId: machine.id, machine: machine.name,
          });
        }
        return Promise.resolve({ success: true, data: { leaseId: id, expiresAt, machines: holders.map((machine) => machine.name), refused: [] } });
      },
      endLease: (leaseId: string) => {
        paneSecretCalls.push({ action: 'endLease', leaseId });
        paneSecrets.leases = paneSecrets.leases.filter((lease) => lease.id !== leaseId);
        return Promise.resolve({ success: true, data: true });
      },
      endAllLeases: () => {
        paneSecretCalls.push({ action: 'endAllLeases' });
        const ended = new Set(paneSecrets.leases.map((lease) => lease.id)).size;
        paneSecrets.leases = [];
        return Promise.resolve({ success: true, data: ended });
      },
      setLeaseLength: (project: string, lengthMs: number) => {
        paneSecretCalls.push({ action: 'setLeaseLength', project, lengthMs });
        paneSecrets.leaseLengths[project] = lengthMs;
        return Promise.resolve({ success: true, data: true });
      },
      setMoveVault: (vault: string) => {
        paneSecretCalls.push({ action: 'setMoveVault', vault });
        paneSecrets.moveVault = vault;
        return Promise.resolve({ success: true, data: true });
      },
      listVaults: () => {
        paneSecretCalls.push({ action: 'listVaults' });
        return Promise.resolve({ success: true, data: ['Private', 'Dev'] });
      },
      moveToOnePassword: (project: string, name: string) => {
        paneSecretCalls.push({ action: 'moveToOnePassword', project, name });
        const reference = `op://${paneSecrets.moveVault ?? 'Private'}/${project}-${name}/credential`;
        addReference(project, name, reference);
        return Promise.resolve({ success: true, data: { reference } });
      },
      onChanged: (callback: () => void) => subscribe('pane-secrets:changed', callback),
    };
    // window.electronAPI.todos (D-409): the fixture's to-dos. attach and detach change them, kept in sessionStorage so a
    // reload keeps them; every act is recorded and todos:changed follows it, as main announces a change.
    const todosStorageKey = 'pane-test-electron-mock-todos';
    const todoReplyRefusal = "That card's tab isn't in this to-do's Session, so the reply wasn't sent. Reply on a card from this to-do.";
    let todoRepliesRefused = false;
    const loadTodosState = (todos: TodosMockOptions): TodosMockState => {
      const stored = window.sessionStorage.getItem(todosStorageKey);
      if (stored) return JSON.parse(stored);
      return { snapshot: clone(todos.snapshot), details: clone(todos.details), nextAttachmentId: 900 };
    };
    const todosState = mockOptions.todos ? loadTodosState(mockOptions.todos) : null;
    const saveTodosState = (state: TodosMockState) => window.sessionStorage.setItem(todosStorageKey, JSON.stringify(state));
    const applyTodoAction = (state: TodosMockState, detail: TodoDetail, action: TodoAction) => {
      const own = detail.attachments[0];
      if (action.kind === 'attach') {
        const attachment: TodoAttachment = {
          id: state.nextAttachmentId++, todoNumber: action.number, target: action.target, addedBy: 'you', source: 'attached', addedAt: Date.now(),
          kind: action.attachmentKind ?? (/^https?:/.test(action.target) ? 'link' : 'doc'),
          label: action.label ?? action.target.split('/').pop() ?? action.target,
        };
        if (own) own.attachments.push(attachment);
        else detail.attachments.push({ attachments: [attachment] });
      }
      if (action.kind === 'detach' && own) own.attachments = own.attachments.filter((attachment) => attachment.id !== action.attachmentId);
      if (action.kind === 'snooze' || action.kind === 'wake') applySnooze(state, detail, action);
      if (mockOptions.todos?.recordActivity) recordTodoActivity(detail, action);
    };
    // Round 9 (T-17): snooze and wake change the to-do as main would: Snoozed until the time (stored stopped), and
    // woken to Working, or to Waiting on you for a reminder; held comments are delivered on waking.
    const applySnooze = (state: TodosMockState, detail: TodoDetail, action: Extract<TodoAction, { kind: 'snooze' | 'wake' }>) => {
      const todo = detail.todo;
      let status: TodoStatus;
      if (action.kind === 'snooze') {
        const from = todo.snooze?.from ?? (todo.state === 'todo' || todo.state === 'stopped' ? todo.state : 'in_progress');
        const snooze: TodoSnooze = {
          until: action.until, zone: action.zone, note: action.note ?? '', action: action.action ?? (todo.sessionId ? 'agents' : 'remind'), by: 'you', from, reminderCardId: null,
        };
        todo.snooze = snooze;
        todo.state = 'stopped';
        status = { status: 'snoozed', reason: `until ${new Date(action.until).toISOString()}` };
      } else {
        const was = todo.snooze;
        delete todo.snooze;
        const reminder = !was || was.action === 'remind' || !todo.sessionId;
        todo.state = reminder ? was?.from ?? 'todo' : 'in_progress';
        status = reminder ? { status: 'waiting', reason: 'reminder' } : { status: 'working', reason: '' };
        for (const row of detail.activity) if (row.kind === 'message' && row.authorKind === 'person' && row.deliveredAt === undefined) row.deliveredAt = Date.now();
      }
      todo.updatedAt = Date.now();
      detail.status = status;
      // oxlint-disable-next-line pane/no-bare-todo-number -- the mock stands in for one machine's to-do API, which main keys by number.
      const listed = state.snapshot.rows.find((row) => row.todo.number === todo.number);
      if (listed) {
        listed.todo = clone(todo);
        listed.status = clone(status);
      }
    };
    // The rows main adds for a comment or an attach, with recordActivity on.
    const recordTodoActivity = (detail: TodoDetail, action: TodoAction) => {
      const id = Math.max(0, ...detail.activity.map((row) => row.id)) + 1;
      const base = { id, todoNumber: detail.todo.number, authorKind: 'person' as const, authorName: 'you', createdAt: Date.now() };
      if (action.kind === 'comment') {
        const row: TodoActivity = { ...base, kind: 'message', body: action.body };
        if (action.replyTo !== undefined) row.replyTo = action.replyTo;
        detail.activity.push(row);
      } else if (action.kind === 'attach') {
        const kind = /\.(png|jpe?g|gif|webp|svg)$/i.test(action.target) ? 'image' : /^https?:/.test(action.target) ? 'link' : 'doc';
        detail.activity.push({ ...base, kind: 'event', body: `You attached ${kind}: ${action.label ?? action.target.split('/').pop() ?? action.target}` });
      }
    };
    const todosApi = todosState ? {
      snapshot: () => success(clone(todosState.snapshot)),
      detail: (number: number) => success(clone(todosState.details[number] ?? null)),
      create: (input: TodoCreateInput) => {
        trackCall('todos:create', [clone(input)]);
        const createdNumber = mockOptions.todos?.createdNumber;
        const made = createdNumber === undefined ? undefined : todosState.details[createdNumber];
        if (made) return Promise.resolve({ success: true, data: clone(made.todo) });
        return Promise.resolve({ success: false, error: 'This mock does not create to-dos.' });
      },
      act: (action: TodoAction) => {
        trackCall('todos:act', [clone(action)]);
        if (todoRepliesRefused && action.kind === 'comment' && action.replyTo !== undefined) {
          return Promise.resolve({ success: false, error: `Error invoking remote method 'todos:act': Error [ERR_TODO_REPLY_TARGET]: ${todoReplyRefusal}` });
        }
        const detail = todosState.details[action.number];
        if (!detail) return Promise.resolve({ success: false, error: `No to-do T-${action.number} in this mock.` });
        applyTodoAction(todosState, detail, action);
        saveTodosState(todosState);
        window.setTimeout(() => emit('todos:changed'), 10);
        return success({ todo: clone(detail.todo) });
      },
    } : undefined;
    const readTodoDoc = (path: string): Promise<AutopilotDocument> =>
      Promise.resolve(clone(mockOptions.todos?.docs?.[path] ?? mockTodoImage(path) ?? { kind: 'text', path, text: `Contents of ${path}` }));
    function mockTodoImage(path: string): AutopilotDocument | undefined {
      const dataUrl = mockOptions.todos?.imageDataUrl;
      return dataUrl && /\.(png|jpe?g|gif|webp|svg)$/i.test(path) ? { kind: 'image', path, dataUrl } : undefined;
    }
    // A to-do's files read through Autopilot's readDoc; the rest of Autopilot never answers, so it stays quiet.
    const quietAutopilotApi = () => new Proxy({ readDoc: readTodoDoc, onChanged: () => unsubscribe }, {
      get(target, prop: string | symbol) {
        if (prop in target) return Object.getOwnPropertyDescriptor(target, prop)?.value;
        return () => new Promise(() => undefined);
      },
    });
    const autopilotSnapshot = mockOptions.autopilotSnapshot;
    // Settings › Autopilot (D-196): the file's text, saved as main would (trimmed; applied at once while it runs).
    let autopilotInstructions = '';
    const autopilotSaves: string[] = [];
    const instructionsView = () => ({
      text: autopilotInstructions,
      path: '/Users/demo/.pane/autopilot/instructions.md',
      builtIn: '# Pane Autopilot\n\nYou are Autopilot: one always-running agent above the person\'s Pane Sessions.\n\n## Never\n- Never answer an approval, a question card or a permission prompt.',
      status: !autopilotInstructions ? 'none' : autopilotSnapshot?.state === 'stopped' ? 'next-start' : 'applied',
    });
    const autopilotApi = autopilotSnapshot ? {
      instructions: () => Promise.resolve(instructionsView()),
      setInstructions: (text: string) => {
        autopilotSaves.push(text);
        autopilotInstructions = text.trim();
        return Promise.resolve(instructionsView());
      },
      snapshot: () => Promise.resolve(clone(autopilotSnapshot)),
      opened: () => Promise.resolve(clone(autopilotSnapshot)),
      onChanged: () => unsubscribe,
      readDoc: readTodoDoc,
    } : todosApi ? quietAutopilotApi() : undefined;
    // window.electronAPI.chatTab, served when a fixture panel is a chat tab: an idle Claude chat with no messages.
    const chatTabApi = mockPanels.some((panel) => panel.type === 'chat') ? (() => {
      const messagesOf = (panelId: string) => (mockOptions.chatMessages?.[panelId] ?? [])
        .map(({ id, role, text }) => ({ id, role, parts: [{ type: 'text', text }] }));
      const view = (panelId: string) => ({
        panelId, agent: 'claude', generation: 1, status: 'idle', canAttachImages: false, controls: [], commands: [], permissions: [], questions: [], queue: [], messageCount: messagesOf(panelId).length,
        transcript: { panelId, generation: 1, revision: 0, start: 0, messages: messagesOf(panelId) },
      });
      const done = () => Promise.resolve();
      return {
        // The chat loads a moment late, as a real one does, so tests exercise the wait for it.
        get: (panelId: string) => new Promise((resolve) => { setTimeout(() => resolve(view(panelId)), 300); }),
        history: () => Promise.resolve([]),
        send: (panelId: string, request: JsonObject) => {
          chatSends.push({ panelId, request: clone(request) });
          return Promise.resolve({ operationId: request.operationId, generation: 1, fingerprint: 'mock', state: 'accepted' });
        },
        receipt: () => Promise.resolve(undefined),
        unqueue: done, sendNow: done, editQueued: done, clear: done, stopTask: done, configure: done, cancel: done,
        permission: done, answer: done, restart: done, resume: done, dismissBanner: done,
        conversations: () => Promise.resolve([]),
        files: () => Promise.resolve([]),
        signIn: (panelId: string) => Promise.resolve({ panelId }),
        onEvent: () => () => undefined,
        onState: () => () => undefined,
      };
    })() : undefined;
    // New Session reads this computer's Agent Farm profiles through chatTab.profiles (T-63).
    const profilesList = mockOptions.agentFarmProfiles;
    const chatTabWithProfiles = profilesList ? { ...chatTabApi, profiles: () => Promise.resolve(clone(profilesList)) } : chatTabApi;
    // The Profiles tab (T-63 PR 5): an in-memory copy of the plugins it edits. Saves mark Pane's own plugins Edited.
    const profilesApi = mockOptions.profileEditor ? (() => {
      const state = clone(mockOptions.profileEditor);
      const photos: { profiles: Record<string, string>; plugins: Record<string, string> } = state.photos ?? { profiles: {}, plugins: {} };
      const pristine = clone(state.files);
      const pristinePlugins = clone(state.overview.plugins);
      const sync: ProfileSyncStatus = state.sync ?? { running: false, lastSyncAt: 1, computers: [] };
      const ok = <T,>(data: T) => Promise.resolve({ success: true, data: clone(data) });
      const pluginOf = (name: string) => state.overview.plugins.find(plugin => plugin.name === name);
      const result = (name: string, path: string) => ok({ plugin: pluginOf(name), path });
      type TreeNode = ProfileTreeNode;
      /** Drops file rows whose file is gone (as main leaves out a skill or reference that isn't there). */
      const prune = (nodes: TreeNode[], files: string[]): TreeNode[] => nodes
        .filter(node => node.kind !== 'file' || files.includes(node.path))
        .map(node => (node.kind === 'file' ? node : { ...node, children: prune(node.children, files) }));
      const syncTrees = (entry: ProfilePlugin) => { for (const profile of entry.profiles) profile.tree = prune(profile.tree, entry.files); };
      /** Adds a row under a top-level folder of a profile's tree (Skills, Subagents, References), making the folder. */
      const addRow = (tree: TreeNode[], profile: string, label: string, node: TreeNode) => {
        let folder = tree.find(item => item.kind === 'folder' && item.label === label);
        if (!folder) {
          folder = { kind: 'folder', id: `${profile}/${label.toLowerCase()}`, label, children: [] };
          const settings = tree.findIndex(item => item.kind === 'folder' && item.label === 'Settings');
          tree.splice(settings < 0 ? tree.length : settings, 0, folder);
        }
        if (folder.kind === 'folder') folder.children.push(node);
      };
      /** A small YAML reader for previews: nested mappings by indentation, `- ` lists, `[a, b]` and `{ a: b }`. */
      const parseYamlText = (source: string): ParsedYaml => {
        const scalar = (text: string): JsonValue => {
          const value = text.trim();
          if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean).map(scalar);
          if (value.startsWith('{') && value.endsWith('}')) {
            const object: Record<string, JsonValue> = {};
            for (const pair of value.slice(1, -1).split(',')) { const at = pair.indexOf(':'); if (at > 0) object[pair.slice(0, at).trim()] = scalar(pair.slice(at + 1)); }
            return object;
          }
          if (value === 'true' || value === 'false') return value === 'true';
          if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
          return value.replace(/^["']|["']$/g, '');
        };
        const lines = source.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));
        if (lines.some(line => (line.match(/\[/g) ?? []).length !== (line.match(/\]/g) ?? []).length)) return { error: 'unexpected end of the stream within a flow collection at line 1, column 1' };
        let index = 0;
        const block = (indent: number): JsonValue => {
          if (index < lines.length && lines[index].trimStart().startsWith('- ')) {
            const list: JsonValue[] = [];
            while (index < lines.length && lines[index].length - lines[index].trimStart().length === indent && lines[index].trimStart().startsWith('- ')) {
              list.push(scalar(lines[index].trimStart().slice(2)));
              index += 1;
            }
            return list;
          }
          const object: Record<string, JsonValue> = {};
          while (index < lines.length) {
            const line = lines[index];
            const depth = line.length - line.trimStart().length;
            if (depth < indent) break;
            const at = line.indexOf(':');
            const key = line.slice(0, at).trim();
            const rest = line.slice(at + 1);
            index += 1;
            if (rest.trim()) object[key] = scalar(rest);
            else if (index < lines.length) {
              const next = lines[index].length - lines[index].trimStart().length;
              object[key] = next > depth || lines[index].trimStart().startsWith('- ') ? block(next) : null;
            } else object[key] = null;
          }
          return object;
        };
        return { data: lines.length ? block(lines[0].length - lines[0].trimStart().length) : null };
      };
      return {
        list: () => ok(state.overview),
        read: (plugin: string, file: string) => {
          const content = state.files[`${plugin}/${file}`];
          return content === undefined ? Promise.resolve({ success: false, error: `${plugin}/${file} doesn't exist. Open the profile again to see its files.` }) : ok(content);
        },
        save: (plugin: string, changes: Array<{ path: string; content: string }>) => {
          if (state.saveError) return Promise.resolve({ success: false, error: state.saveError });
          const entry = pluginOf(plugin);
          for (const change of changes) {
            state.files[`${plugin}/${change.path}`] = change.content;
            if (entry && !entry.files.includes(change.path)) entry.files = [...entry.files, change.path].sort();
          }
          if (entry?.bundled && changes.some(change => change.path !== 'pane.yaml' && !change.path.startsWith('covers/'))) entry.edited = true;
          if (entry) for (const profile of entry.profiles) {
            const cover = [`covers/${profile.name}.html`, `covers/${profile.name}.md`].find(file => entry.files.includes(file));
            if (cover) profile.cover = cover;
          }
          return result(plugin, changes[0]?.path ?? '');
        },
        setDetails: (plugin: string, profile: string, details: { title: string; description: string }) => {
          const summary = pluginOf(plugin)?.profiles.find(item => item.name === profile);
          if (!summary) return Promise.resolve({ success: false, error: `${plugin} has no profile named ${profile}.` });
          if (details.title.trim()) summary.title = details.title.trim(); else delete summary.title;
          // The description is the agent's own: it goes in the identity's front-matter, as main writes it.
          const key = `${plugin}/${summary.entry}`;
          const identity = state.files[key] ?? '---\n---\n';
          const description = details.description.trim();
          if (description) summary.description = description; else delete summary.description;
          const withoutOld = identity.replace(/^description:.*\n/m, '');
          state.files[key] = description ? withoutOld.replace(/^---\n/, `---\ndescription: ${JSON.stringify(description)}\n`) : withoutOld;
          state.files[`${plugin}/pane.yaml`] = `profiles:\n  ${profile}:\n    title: ${details.title}\n`;
          return result(plugin, summary.entry);
        },
        parseYaml: (source: string) => ok(parseYamlText(source)),
        newProfile: (name: string, agent: string) => {
          const entry = `agents/${name}.md`;
          state.files[`${name}/plugin.yaml`] = `name: ${name}\nversion: 0.1.0\ncli_major: 0\n`;
          state.files[`${name}/profiles/${name}.yaml`] = `agent: ${name}\n`;
          state.files[`${name}/${entry}`] = `---\nharness: ${agent}\n---\n\n# ${name}\n\nWho you are and what you do.\n`;
          const files = [entry, 'plugin.yaml', `profiles/${name}.yaml`];
          state.overview.plugins.push({ name, version: '0.1.0', bundled: false, edited: false, files, profiles: [{
            name, ref: `${name}/${name}`, entry, harness: agent, uses: files, listed: true,
            tree: [
              { kind: 'file', id: `${name}/identity`, path: entry, label: `${name}.md`, note: 'identity' },
              { kind: 'folder', id: `${name}/settings`, label: 'Settings', children: [{ kind: 'file', id: `${name}/settings/profiles/${name}.yaml`, path: `profiles/${name}.yaml`, label: `${name}.yaml` }] },
            ],
          }] });
          return result(name, entry);
        },
        newFile: (plugin: string, profile: string, kind: string, name: string) => {
          const entry = pluginOf(plugin);
          const summary = entry?.profiles.find(item => item.name === profile);
          if (!entry || !summary) return Promise.resolve({ success: false, error: `${plugin} has no profile named ${profile}.` });
          const path = kind === 'skill' ? `skills/${name}/SKILL.md` : kind === 'subagent' ? `agents/${name}.md` : `references/${profile}/${name}.md`;
          state.files[`${plugin}/${path}`] = `# ${name}\n`;
          entry.files = [...entry.files, path].sort();
          summary.uses = [...summary.uses, path].sort();
          const id = `${profile}/new/${path}`;
          if (kind === 'skill') addRow(summary.tree, profile, 'Skills', { kind: 'folder', id, label: name, children: [{ kind: 'file', id: `${id}/SKILL.md`, path, label: 'SKILL.md' }] });
          else if (kind === 'subagent') addRow(summary.tree, profile, 'Subagents', { kind: 'subagent', id, alias: name, agent: name, label: name, harness: summary.harness, identity: path, children: [{ kind: 'file', id: `${id}/identity`, path, label: `${name}.md`, note: 'identity' }] });
          else addRow(summary.tree, profile, 'References', { kind: 'file', id, path, label: `${name}.md` });
          if (entry.bundled) entry.edited = true;
          return result(plugin, path);
        },
        restore: (plugin: string) => {
          const entry = pluginOf(plugin);
          if (!entry?.bundled) return Promise.resolve({ success: false, error: `${plugin} doesn't ship with Pane, so there's no Pane version to restore.` });
          for (const key of Object.keys(state.files)) if (key.startsWith(`${plugin}/`)) delete state.files[key];
          for (const [key, value] of Object.entries(pristine)) if (key.startsWith(`${plugin}/`)) state.files[key] = value;
          const shipped = pristinePlugins.find(item => item.name === plugin);
          if (shipped) Object.assign(entry, clone(shipped));
          entry.edited = false;
          return result(plugin, entry.profiles[0]?.entry ?? 'plugin.yaml');
        },
        photos: () => ok(photos),
        /** Not part of Pane's API: a spec changes a file "on disk", as an agent or sync would. Null removes it. */
        writeOnDisk: (plugin: string, path: string, content: string | null) => {
          const entry = pluginOf(plugin);
          if (content === null) {
            delete state.files[`${plugin}/${path}`];
            if (entry) {
              entry.files = entry.files.filter(file => file !== path);
              syncTrees(entry);
            }
            return;
          }
          state.files[`${plugin}/${path}`] = content;
          if (entry && !entry.files.includes(path)) entry.files = [...entry.files, path].sort();
          // A new profiles/<name>.yaml is a new profile, as Agent Farm reads it.
          const profile = /^profiles\/([a-z][a-z0-9_-]*)\.yaml$/.exec(path)?.[1];
          if (entry && profile && !entry.profiles.some(item => item.name === profile)) {
            entry.profiles = [...entry.profiles, { name: profile, ref: `${plugin}/${profile}`, entry: `agents/${profile}.md`, harness: 'claude', uses: [path], listed: true, tree: [] }];
          }
        },
        setPhoto: (ref: string, base64: string) => { photos.profiles[ref] = `data:image/png;base64,${base64}`; return ok(null); },
        removePhoto: (ref: string) => { delete photos.profiles[ref]; return ok(null); },
        // The saved-aside plugin notice (#1740 review F-3): dismiss drops it from the list for good.
        dismissRecovery: (id: string) => {
          if (state.overview.recovered) state.overview.recovered = state.overview.recovered.filter(item => item.id !== id);
          return ok(null);
        },
        openRecovery: () => ok(null),
        // Profile sync (T-63 PR 6): each other computer's state; Sync now reports the online ones up to date.
        syncStatus: () => ok(sync),
        syncNow: () => {
          sync.computers = sync.computers.map(computer => (computer.state === 'offline' ? computer : { ...computer, state: 'up-to-date' as const, waiting: [] }));
          sync.lastSyncAt = Date.now();
          return ok(sync);
        },
        onSyncStatus: () => () => undefined,
        onChanged: () => () => undefined,
      };
    })() : undefined;
    /** Every call the renderer made to the Profiles API, by method; a spec checks none happen with Profiles off. */
    const profilesCalls: string[] = [];
    const record = <Args extends unknown[], Result>(name: string, method: (...args: Args) => Result) => (...args: Args): Result => {
      profilesCalls.push(name);
      return method(...args);
    };
    // writeOnDisk is the spec's own control, not something the renderer calls.
    const recordedProfilesApi = profilesApi && {
      ...profilesApi,
      list: record('list', profilesApi.list),
      read: record('read', profilesApi.read),
      save: record('save', profilesApi.save),
      newProfile: record('newProfile', profilesApi.newProfile),
      newFile: record('newFile', profilesApi.newFile),
      restore: record('restore', profilesApi.restore),
      photos: record('photos', profilesApi.photos),
      setPhoto: record('setPhoto', profilesApi.setPhoto),
      removePhoto: record('removePhoto', profilesApi.removePhoto),
      setDetails: record('setDetails', profilesApi.setDetails),
      parseYaml: record('parseYaml', profilesApi.parseYaml),
      dismissRecovery: record('dismissRecovery', profilesApi.dismissRecovery),
      openRecovery: record('openRecovery', profilesApi.openRecovery),
    };
    const electronAPI = {
      // Absent without the option, so the Profiles row stays hidden in other specs.
      profiles: recordedProfilesApi,
      autopilot: autopilotApi,
      todos: todosApi,
      chatTab: chatTabWithProfiles,
      notify: notifyApi,
      paneSecrets: paneSecretsApi,
      machines: machinesApi,
      preferences: {
        get: async (key: string) => preferences[key] ?? 'true',
        getAll: async () => clone(preferences),
        set: async (key: string, value: string) => {
          const response = persistPreference(key, value);
          if (!response.success) throw new Error(response.error);
        },
      },
      invoke,
      events,
      window: {
        consumeUncleanShutdown: () => {
          const detected = uncleanShutdownPending;
          uncleanShutdownPending = false;
          return Promise.resolve(detected);
        },
        isFocused: () => Promise.resolve(mockOptions.initialWindowFocused !== false),
        reportVisibility: () => {},
        answerStartLink: (answer: JsonObject) => {
          trackCall('pane:start-link-answer', [answer]);
          return Promise.resolve();
        },
        pendingStartLink: () => Promise.resolve(null),
      },
      getPlatform: () => Promise.resolve(mockOptions.platform ?? 'linux'),
      windowControlsOverlayEnabled: mockOptions.windowControlsOverlayEnabled === true,
      appearanceSnapshot: mockOptions.appearanceSnapshot === false ? undefined : clone(mockOptions.appearance.seeded),
      launchChat: mockOptions.launchChat && {
        panelId: mockOptions.launchChat.panelId,
        dockTerminal: mockOptions.launchChat.dockTerminal ?? false,
      },
      setTitleBarOverlay: (colors: JsonObject) => {
        titleBarOverlayWrites.push(clone(colors));
        return success();
      },
      notifyRendererReady: () => {
        rendererReady = true;
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
      // No update is ready, so smoke tests show no pill or toast.
      updater: namespace({
        getRestartState: () => success({
          readyVersion: null,
          availableVersion: null,
          busy: null,
          idleToastDue: false,
          snoozedUntil: null,
          tonight: false,
        }),
        takeRestoreResult: () => success(null),
      }),
      openExternal: (url: string) => {
        openedExternalUrls.push(url);
        if (mockOptions.openExternalOutcome === 'failure') {
          return Promise.resolve({ success: false, error: 'No browser is available.' });
        }
        // Matches preload's Promise<IPCResponse> contract; callers await this result.
        return success();
      },
      openLocalPage: (fileUrl: string) => {
        openedExternalUrls.push(fileUrl);
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
      setup: namespace({
        summary: () => success(clone(setupSummary)),
        export: (sections: SetupSectionId[]) => {
          trackCall('setup:export', [sections]);
          return success({
            fileName: 'pane-setup-2026-10-26.json',
            filePath: '/Users/test/pane-setup-2026-10-26.json',
            leftOut: [{ section: 'customCommands', name: 'deploy-prod' }],
          });
        },
        chooseImport: () => (mockOptions.setupImportError
          ? Promise.resolve({ success: false, error: mockOptions.setupImportError })
          : success(clone(setupPreview))),
        preview: (file: SetupFile, fileName: string) => {
          trackCall('setup:preview', [file, fileName]);
          return success(clone(setupPreview));
        },
      }),
      usage: namespace({
        getReport: (...args: unknown[]) => { trackCall('usage:get-report', args); return success(usageReport()); },
        getStatus: () => { trackCall('usage:get-status', []); return success(clone(mockOptions.initialUsageReport?.index ?? {
          lastScanStartedMs: null,
          lastScanFinishedMs: null,
          filesTracked: 0,
          eventsIndexed: 0,
          missingRoots: [],
          scanning: false,
          filesScanned: 0,
          filesTotal: 0,
          lastError: null,
        })); },
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
        // Deepgram refuses any key starting dg-revoked and takes every other.
        checkDeepgramKey: async (key: string) => (key.startsWith('dg-revoked')
          ? { result: 'rejected', message: 'Saved, but Deepgram rejected this key (HTTP 401). Copy a current key from console.deepgram.com and paste it again.' }
          : { result: 'accepted', message: 'Deepgram accepted this key.' }),
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
          const savedNotify = configState.notify;
          Object.assign(configState, updates);
          configUpdates.push(clone(updates));
          if (updates.notify instanceof Object && !Array.isArray(updates.notify)) {
            // Main merges each notify field into the saved ones and sends a new snapshot.
            const merged: JsonObject = {};
            if (savedNotify instanceof Object && !Array.isArray(savedNotify)) Object.assign(merged, savedNotify);
            configState.notify = Object.assign(merged, updates.notify);
            applyNotifyConfig();
            if (notifySnapshot) queueMicrotask(() => emit('notify:snapshot', clone(notifySnapshot)));
          }
          const response = success(clone(configState));
          if ('terminalFontFamily' in updates || 'terminalFontSize' in updates) {
            queueMicrotask(() => emit('config:terminal-font-updated', {
              terminalFontFamily: configState.terminalFontFamily,
              terminalFontSize: configState.terminalFontSize,
            }));
          }
          return response;
        },
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
        openFile: () => success(mockOptions.openFilePath ?? null),
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
        findRepos: () => success({ repos: [], shells: [], wslDistro: null }),
        findWslRepos: (distro: string) => success({ distro, repos: [], agents: [] }),
        checkFolder: (folder: string) => success({ name: folder.split(/[\\/]/).pop() ?? folder, path: folder }),
        findAgents: () => success([{ id: 'claude', found: true }, { id: 'codex', found: true }]),
        firstSteps: () => {
          const sampleProjectIds = mockProjects.filter(project => project.path === '/tmp/.pane/projects/Pane').map(project => Number(project.id));
          const archivedPaneIds = mockArchivedSessions
            .filter(session => !sampleProjectIds.includes(Number(session.projectId)))
            .map(session => String(session.id))
            .reverse()
            .slice(0, 2);
          return success({ sampleProjectIds, archivedPaneIds });
        },
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
        // No smoke test sees the one-time Pane Chat offer.
        introOffer: () => success({ eligible: false, openingPromptAtLaunch: true }),
      }),
      sshHosts: namespace({
        list: () => {
          const hosts = mockOptions.sshHosts ?? [];
          const open = new Set(mockPanels.map(sshHostOf));
          return success({ hosts, openHosts: [...open].filter((alias): alias is string => !!alias) });
        },
        open: (alias: string, newTab: boolean) => {
          if (!mockOptions.holdSshOpens) return openSshHost(alias, newTab);
          return new Promise(resolve => {
            heldSshOpens.push(error => resolve(error ? { success: false, error } : openSshHost(alias, newTab)));
          });
        },
      }),
      missionControl: namespace({
        listAgents: () => success(clone(mockOptions.initialMissionControlAgents ?? [])),
        snapshots: (request: { panelIds?: string[] }) => success({
          snapshots: (request?.panelIds ?? []).map((panelId) => ({
            panelId,
            text: `snapshot for ${panelId}`,
            lineCount: 1,
            isAlternateScreen: false,
            isLive: true,
            lastActivityAt: null,
          })),
          missing: [],
        }),
      }),
      panels: namespace({
        getSessionPanels: (sessionId: string) => {
          const read = success(clone(mockPanels.filter((panel) => panel.sessionId === sessionId)));
          if (sessionId !== '__ssh_hosts_session__' || !mockOptions.holdSshPanelReads) return read;
          return new Promise(resolve => { heldSshPanelReads.push(() => resolve(read)); });
        },
        deletePanel: (panelId: string) => {
          const deleted = mockPanels.find(panel => panel.id === panelId);
          mockPanels = mockPanels.filter(panel => panel.id !== panelId);
          if (deleted) {
            // SAFETY: The deleted record comes from the same ToolPanel-shaped mock collection.
            const state = deleted.state as JsonObject | undefined;
            if (state?.isActive) {
              const remaining = mockPanels.filter(panel => panel.sessionId === deleted.sessionId);
              const next = remaining.find(panel => panel.type !== 'explorer' && panel.type !== 'diff') ?? remaining[0];
              setActiveMockPanel(String(deleted.sessionId), next ? String(next.id) : null);
            }
            emit('panel:deleted', { panelId, sessionId: deleted.sessionId });
          }
          return success();
        },
        setActivePanel: (sessionId: string, panelId: string) => {
          setActiveMockPanel(sessionId, panelId);
          return success();
        },
        createPanel: (sessionId: string, type: string, title: string, initialState?: JsonObject) => {
          const now = new Date().toISOString();
          const panel = {
            id: `mock-panel-${nextPanelId++}`,
            sessionId,
            type,
            title,
            state: { isActive: false, customState: initialState?.customState ?? initialState ?? {} },
            metadata: { createdAt: now, lastActiveAt: now, position: mockPanels.length },
          };
          mockPanels.push(panel);
          setActiveMockPanel(sessionId, panel.id);
          panelCreates.push(clone(panel));
          emit('panel:created', clone(panel));
          return success(clone(panel));
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
        create: (request: JsonObject) => {
          const now = new Date().toISOString();
          const project = {
            id: mockProjects.reduce((max, existing) => Math.max(max, Number(existing.id)), 0) + 1,
            name: request.name,
            path: request.path,
            active: false,
            created_at: now,
            updated_at: now,
          };
          mockProjects = [...mockProjects, project];
          return success(clone(project));
        },
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
      }),
      loops: namespace({
        list: () => success(clone(mockLoops)),
        save: (input: LoopInput) => {
          const preview = previewLoopCron(input.cron);
          if (!preview.ok) return Promise.resolve({ success: false, error: preview.error });
          const existingIndex = input.id ? mockLoops.findIndex((loop) => loop.id === input.id) : -1;
          const existing = existingIndex >= 0 ? mockLoops[existingIndex] : undefined;
          const loop: Loop = {
            ...input,
            id: existing?.id ?? `loop-${mockLoops.length + 1}`,
            createdAtMs: existing?.createdAtMs ?? Date.now(),
            nextRunAtMs: input.enabled ? preview.nextRunAtMs : null,
            scheduleText: preview.scheduleText,
            runs: existing?.runs ?? [],
          };
          if (existingIndex >= 0) mockLoops[existingIndex] = loop;
          else mockLoops.push(loop);
          return success(clone(loop));
        },
        delete: (id: string) => {
          mockLoops = mockLoops.filter((loop) => loop.id !== id);
          return success();
        },
        setEnabled: (id: string, enabled: boolean) => {
          const loop = mockLoops.find((candidate) => candidate.id === id);
          if (!loop) return Promise.resolve({ success: false, error: 'Loop not found' });
          loop.enabled = enabled;
          const preview = previewLoopCron(loop.cron);
          loop.nextRunAtMs = enabled && preview.ok ? preview.nextRunAtMs : null;
          return success(clone(loop));
        },
        // Starts a run as main does: a new running Pane in the loop's project, named after the loop.
        runNow: (id: string) => {
          const loop = mockLoops.find((candidate) => candidate.id === id);
          if (!loop) return Promise.resolve({ success: false, error: 'Loop not found' });
          const now = new Date();
          const slug = loop.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          const when = `${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${now.toTimeString().slice(0, 5)}`;
          const sessionId = `${loop.id}-run-${loop.runs.length + 1}`;
          const session = {
            id: sessionId,
            name: `${slug} · ${when}`,
            projectId: loop.projectId,
            worktreePath: `/tmp/worktrees/${slug}-${loop.runs.length + 1}`,
            prompt: loop.initialInput ?? '',
            status: 'running',
            createdAt: now.toISOString(),
            lastActivity: now.toISOString(),
            output: [],
            jsonMessages: [],
            permissionMode: 'ignore',
            toolType: 'none',
            archived: false,
            isHidden: false,
            isFavorite: false,
          };
          mockSessions.push(session);
          loop.runs = [{
            id: `${sessionId}-record`,
            loopId: loop.id,
            slotAtMs: now.getTime(),
            trigger: 'manual' as const,
            status: 'started' as const,
            error: null,
            sessionId,
          }, ...loop.runs].slice(0, 10);
          emit('session:created', clone(session));
          emit('loops:changed');
          return success(clone(loop));
        },
        preview: (cron: string) => success(previewLoopCron(cron)),
      }),
      sessions: namespace({
        // Pasted or dropped files (a to-do's composer saves them so): each "saved" under /tmp/pane-images by its name.
        saveImages: (_draftId: string, files: Array<{ name: string }>) => Promise.resolve(files.map((file) => `/tmp/pane-images/${file.name}`)),
        // The SSH view's hidden Session; other ids keep the generic empty answer.
        get: (sessionId: string) => {
          if (sessionId !== '__ssh_hosts_session__') return success();
          if (sshSessionReadFailures-- > 0) return Promise.resolve({ success: false, error: 'Remote Pane did not answer' });
          return success({ ...clone(paneChatSession), id: sessionId, name: 'SSH' });
        },
        getOrCreateMainRepoSession: async (projectId: number) => {
          const delayMs = mockOptions.mainRepoSessionDelayByProjectId?.[projectId] ?? 0;
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          if (mockOptions.holdMainRepoSessionProjectIds?.includes(projectId)) {
            await new Promise<void>(resolve => { heldMainRepoSessions.push(resolve); });
          }
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
        restore: (sessionId: string) => {
          sessionRestoreCalls.push(sessionId);
          return success();
        },
        permanentDelete: () => success(),
        permanentDeleteArchived: () => success({ deletedCount: 0 }),
        toggleFavorite: (sessionId: string) => {
          sessionFavoriteToggleCalls.push(sessionId);
          return success();
        },
        reorderInProject: (projectId: number, paneIds: string[]) => {
          paneOrderCalls.push({ reorderInProject: { projectId, paneIds: clone(paneIds) } });
          if (mockOptions.paneOrderUnsupported) return hostOutdated('sessions:reorder-in-project');
          const panes = projectPanes(projectId);
          const listed = paneIds.filter((id, index) => paneIds.indexOf(id) === index && panes.some((pane) => pane.id === id));
          const queue = listed.map((id) => panes.find((item) => item.id === id) ?? null);
          savePaneOrder(panes.map((pane) => (listed.includes(String(pane.id)) ? queue.shift() ?? pane : pane)));
          return success({ moved: [] });
        },
        sortPanes: (order: 'newest' | 'oldest') => {
          paneOrderCalls.push({ sortPanes: order });
          if (mockOptions.paneOrderUnsupported) return hostOutdated('sessions:sort-panes');
          newPanePlacement = order === 'newest' ? 'top' : 'bottom';
          const projectIds = [...new Set(mockSessions.map((pane) => Number(pane.projectId)))];
          for (const projectId of projectIds) {
            const created = projectPanes(projectId).sort((a, b) => paneTime(b) - paneTime(a));
            savePaneOrder(order === 'newest' ? created : created.reverse());
          }
          return success({ moved: [] });
        },
        getPaneOrder: () => {
          if (mockOptions.paneOrderUnsupported) return hostOutdated('sessions:get-pane-order');
          return success({ newPanes: newPanePlacement ?? 'top', chosen: newPanePlacement !== null });
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
          if (mockOptions.holdFileDiffs?.some(held => held === key || held === `${sessionId}:${key}`)) {
            await new Promise<void>(resolve => { heldFileDiffs.push(resolve); });
          }
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
          // As main does: saving a connection updates the config, which it announces.
          emit('config:updated', clone(configState));
          return success(clone(remoteDaemonConfig.client.profiles));
        },
        deleteConnectionProfile: (profileId: string) => {
          remoteDaemonConfig.client.profiles = remoteDaemonConfig.client.profiles.filter((profile) => profile.id !== profileId);
          const seededAt = seededComputers.findIndex((computer) => computer.id === profileId);
          if (seededAt >= 0) seededComputers.splice(seededAt, 1);
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
          emit('config:updated', clone(configState));
          return success(clone(remoteDaemonConfig.client));
        },
        updateClientState: (updates: { activeProfileId?: string | null; mode?: 'local' | 'remote' }) => {
          if (updates.activeProfileId !== undefined) {
            remoteDaemonConfig.client.activeProfileId = updates.activeProfileId;
          }
          if (updates.mode) {
            remoteDaemonConfig.client.mode = updates.mode;
          }

          syncRemoteDaemonConfig();
          if (remoteDaemonConfig.client.mode === 'remote' && remoteDaemonConfig.client.activeProfileId) {
            const activeComputer = remoteDaemonConfig.client.computers.find(
              (computer) => computer.id === remoteDaemonConfig.client.activeProfileId
            );
            const failure = activeComputer ? mockOptions.remoteConnectError ?? null : 'Missing saved connection';
            setRemoteConnectionState({
              mode: 'remote',
              status: failure ? 'error' : 'connected',
              activeProfileId: remoteDaemonConfig.client.activeProfileId,
              activeProfileLabel: activeComputer?.label ?? null,
              activeBaseUrl: activeComputer?.routes[0]?.baseUrl ?? null,
              activeRouteId: failure ? null : activeComputer?.routes[0]?.id ?? null,
              lastError: failure,
            });
          } else {
            setRemoteConnectionState({
              mode: 'local',
              status: 'local',
              activeProfileId: remoteDaemonConfig.client.activeProfileId,
              activeProfileLabel: null,
              activeBaseUrl: null,
              activeRouteId: null,
              lastError: null,
            });
          }

          syncRemoteDaemonConfig();
          return success(clone(remoteDaemonConfig.client));
        },
        getWorkspaceAccess: () => success(clone(workspaceAccess)),
        getGlasses: () => success(clone(glassesState)),
        revokeGlasses: (id: string) => {
          glassesState.devices = glassesState.devices.filter((device) => device.id !== id);
          return success(clone(glassesState));
        },
        revokeGlassesEverywhere: (phoneId: string) => {
          glassesState.devices = glassesState.devices.filter((device) => device.phoneId !== phoneId);
          if (mockOptions.glassesRevokeEverywhereError) return Promise.resolve({ success: false, error: mockOptions.glassesRevokeEverywhereError });
          return success(clone(mockOptions.glassesRevokeEverywhere ?? { revoked: ['this computer'], notReached: [] }));
        },
        setGlassesOrigin: (update: { origin: string; allowed: boolean }) => {
          glassesState.refusedOrigins = glassesState.refusedOrigins.filter((entry) => entry.origin !== update.origin);
          glassesState.allowedOrigins = glassesState.allowedOrigins.filter((entry) => entry.origin !== update.origin);
          if (update.allowed) glassesState.allowedOrigins.push({ origin: update.origin, source: 'owner' });
          return success(clone(glassesState));
        },
        updateWorkspaceAccess: (update: { visibility?: 'off' | 'owner' | 'tailnet'; password?: string | null }) => {
          if (update.visibility) workspaceAccess.visibility = update.visibility;
          if (update.password !== undefined) workspaceAccess.passwordProtected = update.password !== null;
          return success(clone(workspaceAccess));
        },
        listTailnetMachines: () => {
          const list: TailnetMachineList = clone(mockOptions.tailnetMachines ?? { ok: true, tailnet: 'example.github', domain: 'tail1234.ts.net', machines: [] });
          if (list.ok) {
            for (const machine of list.machines) {
              const computer = remoteDaemonConfig.client.computers.find((candidate) => candidate.routes.some((route) => route.tailnetMachine === machine.name));
              if (computer) machine.profileId = computer.id;
            }
          }
          return success(list);
        },
        saveTailnetMachine: (input: { name: string; password?: string }) => {
          const profile = {
            id: `tailnet-tail1234.ts.net-${input.name}`,
            label: input.name,
            baseUrl: `https://${input.name}.tail1234.ts.net:8443`,
            token: input.password ?? '',
            transport: 'http+sse' as const,
            tailnetMachine: input.name,
            tailnetDomain: 'tail1234.ts.net',
          };
          remoteDaemonConfig.client.profiles = [
            ...remoteDaemonConfig.client.profiles.filter((candidate) => candidate.id !== profile.id),
            profile,
          ];
          syncRemoteDaemonConfig();
          return success(clone(profile));
        },
        onConnectionStateChanged: (callback: MockEventCallback) =>
          subscribe('remote-daemon:connection-state-changed', callback),
        onHostStateChanged: (callback: MockEventCallback) =>
          subscribe('remote-daemon:host-state-changed', callback),
        onSetupProgress: (callback: MockEventCallback) =>
          subscribe('remote-daemon:setup-progress', callback),
        runCheckFix: () => success(clone(remoteConnectionState)),
        dismissCheck: () => {
          setRemoteConnectionState({ check: null });
          return success(clone(remoteConnectionState));
        },
        cancelSwitch: () => success({ cancelled: false }),
      }),
      uiState: namespace({
        getExpanded: () => {
          const storedSessions = readExpandedSessions()[remoteConnectionState.activeProfileId ?? ''];
          const read = success({ ...clone(uiState), expandedSessions: storedSessions ?? clone(uiState.expandedSessions) });
          if (!holdNextExpandedRead) return read;
          holdNextExpandedRead = false;
          return new Promise(resolve => { heldExpandedReads.push(() => resolve(read)); });
        },
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
        saveSidebarSectionExpanded: (section: 'pinned' | 'repositories' | 'sshHosts' | 'sessions' | 'archived', expanded: boolean) => {
          if (section === 'pinned') uiState.pinnedSectionExpanded = expanded;
          else if (section === 'repositories') uiState.repositoriesSectionExpanded = expanded;
          else if (section === 'sessions') uiState.sessionsSectionExpanded = expanded;
          else if (section === 'archived') uiState.archivedSectionExpanded = expanded;
          return success();
        },
        saveExpandedSessions: (sessionIds: string[]) => {
          const stored = readExpandedSessions();
          stored[remoteConnectionState.activeProfileId ?? ''] = clone(sessionIds);
          window.localStorage.setItem(expandedSessionsKey, JSON.stringify(stored));
          return success();
        },
        saveExpandedArchivedProjects: (projectIds: number[]) => {
          uiState.expandedArchivedProjects = clone(projectIds);
          return success();
        },
        getSessionWorkspaceLayout: (hostId: string | null) =>
          success(readSessionWorkspaceLayouts()[hostId ?? ''] ?? null),
        saveSessionWorkspaceLayout: (hostId: string | null, layout: JsonObject | null) => {
            const layouts = readSessionWorkspaceLayouts();
          if (layout === null) delete layouts[hostId ?? ''];
          else layouts[hostId ?? ''] = clone(layout);
          writeSessionWorkspaceLayouts(layouts);
          return success();
        },
        getPaneLayout: (hostId: string | null, paneId: string) =>
          success(mockOptions.rememberPaneLayouts ? readPaneLayouts()[paneLayoutId(hostId, paneId)] ?? null : null),
        savePaneLayout: (hostId: string | null, paneId: string, layout: JsonObject | null) => {
          if (!mockOptions.rememberPaneLayouts) return success();
          const layouts = readPaneLayouts();
          if (layout === null) delete layouts[paneLayoutId(hostId, paneId)];
          else layouts[paneLayoutId(hostId, paneId)] = clone(layout);
          window.localStorage.setItem(paneLayoutKey, JSON.stringify(layouts));
          return success();
        },
        getNavigationMemory: (hostId: string | null) =>
          success(clone(navigationMemories.get(hostId ?? '') ?? null)),
        getLaunchChat: () => success(mockOptions.launchChat ? { paneId: mockOptions.launchChat.paneId, panelId: mockOptions.launchChat.panelId } : null),
        saveNavigationMemory: (hostId: string | null, memory: JsonObject) => {
          navigationMemories.set(hostId ?? '', clone(memory));
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
        getChatSends() {
          return clone(chatSends);
        },
        getAutopilotInstructionSaves() {
          return clone(autopilotSaves);
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
        getProfilesCalls() {
          return clone(profilesCalls);
        },
        writeProfileFile(plugin: string, path: string, content: string | null) {
          profilesApi?.writeOnDisk(plugin, path, content);
        },
        setTodoReplyRefusal(on: boolean) {
          todoRepliesRefused = on;
          return todoReplyRefusal;
        },
        getConsoleLogCalls() {
          return clone((invokeCalls.get('console:log') ?? []).map((call) => call.args[0]));
        },
        /** A phone used the current pairing code: its record lands here and main announces it. */
        emitRelayPaired(clientId: string, label: string) {
          remoteDaemonConfig.host.clients.push({ id: clientId, label, createdAt: new Date().toISOString(), tokenHash: 'hash', phoneId: `install-${clientId}` });
          syncRemoteDaemonConfig();
          emit('relay:paired', { clientId, label });
        },
        /** Another computer or a phone changed this computer's devices; main announces the new config. */
        emitHostClientsChanged(clients: RemoteDaemonClientRecord[]) {
          remoteDaemonConfig.host.clients = clone(clients);
          syncRemoteDaemonConfig();
          emit('config:updated', clone(configState));
        },
        /** Main moving this computer's relay to a new phase. */
        emitRelayStatus(updates: Partial<RelayStatus>) {
          Object.assign(relayStatus, updates);
          emit('relay:status-changed', clone(relayStatus));
        },
        /** Stands in for main pushing a connection change, such as a host that stopped answering. */
        emitRemoteConnectionState(updates: Partial<RemotePaneConnectionState>) {
          setRemoteConnectionState(updates);
        },
        /** Stands in for main asking the window to confirm a `pane://new` link; answers land in getInvokeCalls('pane:start-link-answer'). */
        emitStartLinkRequest(request: JsonObject) {
          emit('pane:start-link-request', clone(request));
        },
        emitNativeAppearanceUpdated(prefersDark: boolean) {
          emit('window:appearance-native-updated', { prefersDark });
        },
        emitWindowFocusChanged(focused: boolean) {
          emit('window:focus-changed', focused);
        },
        /** A pane:// link main resolved to a Session or repo, as it sends it to the renderer. */
        emitPaneOpenLink(target: JsonObject) {
          emit('pane:open-link', clone(target));
        },
        emitSessionCreationFailed(name: string, error: string) {
          emit('session:creation-failed', { name, error });
        },
        setArchiveProgress(progress: ArchiveProgressSnapshot) {
          archiveProgress = progress;
        },
        emitArchiveProgress(progress: ArchiveProgressSnapshot) {
          archiveProgress = progress;
          emit('archive:progress', clone(progress));
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
        /** Every panel the renderer created through `panels.createPanel`, in order. */
        getPanelCreates() {
          return clone(panelCreates);
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
        // Stands in for `runpane panes focus`.
        emitPaneFocusRequested(paneId: string) {
          emit('pane:focus-requested', { paneId });
        },
        // Names the host that host-keyed ui state reads and writes, as main's active profile does.
        /** The connected computer, as main reports it. */
        setConnectionState(updates: Partial<RemotePaneConnectionState>) {
          setRemoteConnectionState(updates);
        },
        setActiveRemoteProfileId(profileId: string | null) {
          remoteConnectionState.activeProfileId = profileId;
        },
        emitRemoteDaemonResyncRequested(event: { hostChanged: boolean } = { hostChanged: false }) {
          emit('remote-daemon:resync-required', event);
        },
        getNavigationMemory(hostId: string | null) {
          return clone(navigationMemories.get(hostId ?? '') ?? null);
        },
        getConfigReadCount() {
          return configGetCount;
        },
        isRendererReady() {
          return rendererReady;
        },
        setSessions(sessions: JsonObject[]) {
          mockSessions = clone(sessions);
        },
        // Stands in for main creating a Pane.
        addSession(session: JsonObject) {
          mockSessions.push(clone(session));
          emit('session:created', clone(session));
        },
        // Stands in for main archiving a Pane: it leaves the active list and the store hears session:deleted.
        archiveSession(sessionId: string) {
          const session = mockSessions.find(candidate => candidate.id === sessionId);
          if (!session) return;
          mockSessions = mockSessions.filter(candidate => candidate.id !== sessionId);
          mockArchivedSessions.push({ ...session, archived: true });
          emit('session:deleted', { id: sessionId });
        },
        // Stands in for main restoring an archived Pane, which reloads the active list.
        restoreSession(sessionId: string) {
          const index = mockArchivedSessions.findIndex(candidate => candidate.id === sessionId);
          if (index < 0) return;
          const [session] = mockArchivedSessions.splice(index, 1);
          mockSessions.push({ ...session, archived: false });
          emit('sessions:loaded', clone(mockSessions));
        },
        setProjects(projects: JsonObject[], activeProjectId: number | null = null) {
          mockProjects = clone(projects);
          mockActiveProjectId = activeProjectId;
        },
        setPanels(panels: JsonObject[]) {
          mockPanels = clone(panels);
        },
        /** Answers every held SSH open: with the open's result, or with this error. */
        releaseSshOpens(error?: string) {
          for (const release of heldSshOpens.splice(0)) release(error);
        },
        /** Holds the next expanded-state read, the first read of a host-change resync. */
        holdNextExpandedRead() {
          holdNextExpandedRead = true;
        },
        releaseExpandedReads() {
          for (const release of heldExpandedReads.splice(0)) release();
        },
        releaseSshPanelReads() {
          for (const release of heldSshPanelReads.splice(0)) release();
        },
        releaseMainRepoSessions() {
          for (const release of heldMainRepoSessions.splice(0)) release();
        },
        releaseFileDiffs() {
          for (const release of heldFileDiffs.splice(0)) release();
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
        emitTerminalCliReady(panelId: string) {
          emit('terminal:cliReady', { panelId });
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
        emitPanelActivation(request: JsonObject) {
          emit('panel:activeChanged', clone(request));
        },
        emitPanelAgentStatus(panelId: string, sessionId: string, state: string, reason?: string) {
          emit('panel:agent-status', { panelId, sessionId, state, reason });
        },
        emitPanelDeleted(panelId: string, sessionId: string) {
          emit('panel:deleted', { panelId, sessionId });
        },
        getSessionsReadCount() {
          return sessionsGetCount;
        },
        getLoops() {
          return clone(mockLoops);
        },
        getSessionDeleteCalls() {
          return clone(sessionDeleteCalls);
        },
        getPaneOrderCalls() {
          return clone(paneOrderCalls);
        },
        getSessionRestoreCalls() {
          return clone(sessionRestoreCalls);
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
        getNotifyCommands() {
          return clone(notifyCommands);
        },
        /** Which secrets Settings set or deleted; values are never recorded. */
        getPaneSecretCalls() {
          return clone(paneSecretCalls);
        },
        getNotifyWindowSizes() {
          return clone(notifyWindowSizes);
        },
        switchTodosHost(computerId: string, todos: Pick<TodosMockOptions, 'snapshot' | 'details'>) {
          remoteDaemonConfig.client.mode = 'remote';
          remoteDaemonConfig.client.activeProfileId = computerId;
          configState.remoteDaemon = clone(remoteDaemonConfig);
          // As main does, the window's machine is now that computer, when it is a saved one (T-51).
          const computer = remoteDaemonConfig.client.computers.find((candidate) => candidate.id === computerId);
          if (computer) {
            setRemoteConnectionState({
              mode: 'remote', status: 'connected', activeProfileId: computerId, activeProfileLabel: computer.label,
              activeBaseUrl: computer.routes[0]?.baseUrl ?? null, activeRouteId: computer.routes[0]?.id ?? null, lastError: null,
            });
          }
          if (todosState) {
            todosState.snapshot = clone(todos.snapshot);
            todosState.details = clone(todos.details);
            saveTodosState(todosState);
          }
          emit('remote-daemon:resync-required', { hostChanged: true });
        },
        setTodosSnapshot(snapshot: TodosSnapshot) {
          if (!todosState) return;
          todosState.snapshot = clone(snapshot);
          saveTodosState(todosState);
          emit('todos:changed');
        },
        emitNotifySnapshot(snapshot: NotifySnapshot) {
          notifySnapshot = clone(snapshot);
          emit('notify:snapshot', clone(snapshot));
        },
        emitNotifyNavigate(target: 'inbox' | 'toggle-inbox' | 'settings' | { approval: string }) {
          emit('notify:navigate', target);
        },
        getMachineRuns() {
          return clone(machineRuns);
        },
        getMachineLatencyCalls() {
          return [...machineLatencyCalls];
        },
        getMachineReads() {
          return clone(machineReads);
        },
        /** Stands in for main: one machine's event, a resync, or a machine list change. */
        emitMachineEvent(event: MachineConnectionsEvent, reads?: Record<string, Record<string, JsonValue>>) {
          if (event.type === 'machines') machineConnections.machines = clone(event.machines);
          for (const [machineId, answers] of Object.entries(reads ?? {})) {
            machineConnections.reads[machineId] = { ...machineConnections.reads[machineId], ...clone(answers) };
          }
          for (const listener of machineListeners) listener(clone(event));
        },
      },
    });
  }, {
    ...options,
    appearance: {
      defaults: DEFAULT_APPEARANCE,
      seeded: normalizeAppearance(options.initialConfig ?? {}).appearance,
    },
  });
}
