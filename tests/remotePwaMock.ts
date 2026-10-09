import type { Page } from '@playwright/test';
import type { OrchestrationSessionRecord } from '../shared/types/orchestrationSession';
import { PANE_CHAT_AGENT_LABELS } from '../shared/types/paneChat';
import type { JsonValue } from '../shared/validation/boundaryDecoder';
import type { ListeningPortsSnapshot } from '../shared/types/listeningPorts';

// Test harness for the Remote Pane PWA — the browser-served surface at
// `/remote.html`, which talks to a remote Pane daemon over HTTP+SSE rather than
// to Electron. Nothing here touches `window.electronAPI`; see
// `tests/electronApiMock.ts` for the desktop equivalent.

export interface RemotePwaMockOptions {
  /** Panes the mock host reports, in sidebar order. */
  sessionNames?: string[];
  /** Panels the selected pane reports, in host order. */
  panelTitles?: string[];
  /** Each panel's type, by index into panelTitles; terminal when absent. */
  panelTypes?: string[];
  /** Host-defined terminal shortcuts offered in the mobile input bar. */
  shortcuts?: Array<{ id: string; key: string; label: string; text: string }>;
  /** Index of the panel the host reports as active. */
  activePanelIndex?: number;
  /** Orchestration Sessions the mock host reports. */
  orchestrationSessionNames?: string[];
  /** Browser panels after the terminals, by title and saved URL ('' for a new tab). */
  browserPanels?: Array<{ title: string; url: string }>;
  /** What `ports:list` answers. */
  ports?: ListeningPortsSnapshot;
  /** Worktree files by relative path, served through `file:*`; adds the Explorer tab last. Binary files are `null`. */
  files?: Record<string, string | null>;
  /** Agent statuses the host already reports when the PWA connects. */
  agentStatuses?: RemotePwaMockHost['agentStatuses'];
}

/**
 * The mock host's mutable state. Tests change it to stand in for work done on
 * the host (desktop, CLI or another device) while the PWA is not listening.
 */
export interface RemotePwaMockHost {
  panes: MockPane[];
  archivedPanes: MockPane[];
  sessions: OrchestrationSessionRecord[];
  /** The selected pane's worktree; `file:write` changes it. */
  files: Record<string, string | null>;
  /** The host's last-used tab per Pane, as `panels:set-active` and host activations leave it. */
  activePanelIds: Record<string, string>;
  /** Extra panels in each Session's workspace Pane (keyed by Session id), after its agent chats. */
  sessionTools: Record<string, Array<{ id: string; title: string }>>;
  /** While set, the host holds its reply on that channel until the promise settles. */
  held: Record<string, Promise<void>>;
  /** The `panels:agent-statuses` baseline: what the host's agents are doing now. */
  agentStatuses: Array<{ sessionId: string; panelId: string; state: 'blocked' | 'working' | 'idle' | 'unknown' }>;
}

const PROFILE = {
  id: 'anim-host',
  label: 'MacBook Pro',
  baseUrl: 'http://anim-pane.test/remote/browser',
  token: 'anim-token-12345678',
  transport: 'http+sse',
} as const;

// Enough scrollback that the terminal reads as a working shell in the clips and
// the scroll joystick has something to move over.
const TERMINAL_SCROLLBACK = [
  '\x1b[32m➜\x1b[0m  \x1b[36mpane\x1b[0m git:(\x1b[31manimations-for-the-pane-web-app\x1b[0m) pnpm lint\r\n',
  '\r\n',
  '> pane@2.4.66 lint /Users/dev/pane\r\n',
  '> node scripts/lint.mjs\r\n',
  '\r\n',
  '  \x1b[32m✓\x1b[0m oxlint      \x1b[90m412 files\x1b[0m\r\n',
  '  \x1b[32m✓\x1b[0m eslint      \x1b[90m88 files\x1b[0m\r\n',
  '  \x1b[32m✓\x1b[0m knip        \x1b[90mno unused exports\x1b[0m\r\n',
  '  \x1b[32m✓\x1b[0m boundaries  \x1b[90mconformant\x1b[0m\r\n',
  '\r\n',
  '\x1b[32m➜\x1b[0m  \x1b[36mpane\x1b[0m git:(\x1b[31manimations-for-the-pane-web-app\x1b[0m) ',
].map((data) => ({
  sessionId: 'anim-remote-0',
  type: 'stdout' as const,
  data,
  timestamp: new Date(0).toISOString(),
}));

const baseSession = {
  prompt: 'evidence fixture',
  status: 'running',
  createdAt: new Date(0).toISOString(),
  lastActivity: new Date(0).toISOString(),
  output: [],
  jsonMessages: [],
  isRunning: true,
  permissionMode: 'ignore',
  projectId: 1,
  isFavorite: false,
  toolType: 'none',
  archived: false,
};

type MockPane = typeof baseSession & { id: string; name: string; worktreePath: string; displayOrder: number };

function buildFixtures(options: RemotePwaMockOptions) {
  const sessionNames = options.sessionNames ?? [
    'scrub Sentry request bodies',
    'server-side funnel events',
    'sms opt-in consent at signup',
  ];
  const panelTitles = options.panelTitles ?? ['claude', 'shell'];

  const sessions: MockPane[] = sessionNames.map((name, index) => ({
    ...baseSession,
    id: `anim-remote-${index}`,
    name,
    worktreePath: `/Users/dev/pane/worktrees/${index}`,
    displayOrder: index,
  }));

  const project = {
    id: 1,
    name: 'dcouple/pane',
    path: '/Users/dev/pane',
    active: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    sessions,
  };

  // Every Pane has the same tabs; the first Pane keeps the historic ids.
  const panel = (paneId: string, type: string, title: string, index: number, customState?: { currentUrl: string }) => ({
    id: paneId === sessions[0].id ? `anim-panel-${index}` : `${paneId}-panel-${index}`,
    sessionId: paneId,
    type,
    title,
    state: { isActive: index === 0, hasBeenViewed: index === 0, customState },
    metadata: {
      createdAt: new Date(0).toISOString(),
      lastActiveAt: new Date(0).toISOString(),
      position: index,
    },
  });
  const panelsFor = (paneId: string) => {
    const panels = [
      ...panelTitles.map((title, index) => panel(paneId, options.panelTypes?.[index] ?? 'terminal', title, index)),
      ...(options.browserPanels ?? []).map((browser, index) => (
        panel(paneId, 'browser', browser.title, panelTitles.length + index, { currentUrl: browser.url })
      )),
    ];
    if (options.files) panels.push(panel(paneId, 'explorer', 'Explorer', panels.length));
    return panels;
  };

  const affordances = {
    terminalShortcuts: options.shortcuts ?? [
      { id: 's1', key: 'r', label: 'Run the test suite', text: 'pnpm test', enabled: true },
      { id: 's2', key: 'l', label: 'Lint and typecheck', text: 'pnpm lint && pnpm typecheck', enabled: true },
      { id: 's3', key: 'g', label: 'Status', text: 'git status --short', enabled: true },
    ],
    customCommands: [
      { name: 'Codex', command: 'codex' },
    ],
    sessionAgents: { agents: ['claude', 'codex'], defaultAgent: 'codex' },
    voiceTranscription: {
      availableModes: [],
      defaultMode: 'streaming',
      configured: {
        cleanup: false, recorded: false, streaming: false,
        fal: false, deepgram: false, openRouter: false,
      },
      modes: {
        streaming: { label: 'Live', priceLabel: '', latencyLabel: '', recommended: true },
        recorded: { label: 'Batch', priceLabel: '', latencyLabel: '', recommended: false },
      },
    },
  };

  const panelsByPane = Object.fromEntries(sessions.map(pane => [pane.id, panelsFor(pane.id)]));
  const host: RemotePwaMockHost = {
    panes: sessions,
    archivedPanes: [],
    sessions: (options.orchestrationSessionNames ?? []).map(buildOrchestrationSession),
    files: { ...options.files },
    activePanelIds: Object.fromEntries(sessions.map(pane => [pane.id, panelsByPane[pane.id][options.activePanelIndex ?? 0].id])),
    sessionTools: {},
    held: {},
    agentStatuses: options.agentStatuses ?? [],
  };

  const ports = options.ports ?? { host: 'MacBook Pro', ports: [] };
  return { project, panelsByPane, panel, affordances, host, ports };
}

function buildOrchestrationSession(name: string, index: number): OrchestrationSessionRecord {
  const id = `__orchestration_session_mock-${index}__`;
  return {
    id,
    name,
    archived: false,
    isPinned: false,
    agent: 'claude',
    internalSessionId: `${id}terminal__`,
    panelIds: { claude: `${id}claude`, codex: `${id}codex`, cursor: `${id}cursor` },
    goal: '',
    context: '',
    decisions: [],
    blockers: [],
    nextAction: '',
    evidence: [],
    outputs: [],
    associations: [],
    activity: [],
    revision: 1,
    createdAt: new Date(index * 1000).toISOString(),
    updatedAt: new Date(index * 1000).toISOString(),
  };
}

function sessionPanel(session: OrchestrationSessionRecord, id: string, title: string, position: number) {
  return {
    id,
    sessionId: session.internalSessionId,
    type: 'terminal',
    title,
    state: { isActive: position === 0, hasBeenViewed: true },
    metadata: { createdAt: session.createdAt, lastActiveAt: session.createdAt, position },
  };
}

/**
 * A Session's workspace Pane in host order: its agent chat, its tools, and the
 * chats of agents it no longer uses (which the PWA hides) between them.
 */
function sessionWorkspace(session: OrchestrationSessionRecord, tools: Array<{ id: string; title: string }> = []) {
  const chat = sessionPanel(session, session.panelIds[session.agent], PANE_CHAT_AGENT_LABELS[session.agent], 0);
  if (tools.length === 0) return [chat];
  const otherAgent = session.agent === 'codex' ? 'claude' : 'codex';
  const [first, ...rest] = tools.map((tool, index) => sessionPanel(session, tool.id, tool.title, index + 1));
  return [chat, first, sessionPanel(session, session.panelIds[otherAgent], PANE_CHAT_AGENT_LABELS[otherAgent], tools.length + 1), ...rest];
}

/** The agent chat a mock Session opens on, shaped like the host's Session view. */
function orchestrationSessionView(session: OrchestrationSessionRecord) {
  const panel = sessionPanel(session, session.panelIds[session.agent], PANE_CHAT_AGENT_LABELS[session.agent], 0);
  return {
    session,
    internalSession: {
      ...baseSession,
      id: session.internalSessionId,
      name: session.name,
      worktreePath: `/Users/dev/.pane/sessions/${session.id}`,
      isHidden: true,
    },
    panel,
    agent: session.agent,
    cwd: `/Users/dev/.pane/sessions/${session.id}`,
    guidePath: '/Users/dev/.pane/guide.md',
    started: true,
  };
}

/**
 * Runs in the page before the PWA loads. The saved profile is seeded into
 * localStorage so the connection screen offers a one-click Connect.
 */
function installClientMocks(profile: typeof PROFILE): void {
  window.localStorage.setItem('pane.remotePwa.savedProfiles', JSON.stringify([profile]));

  // The PWA opens an EventSource for host push events. It stays quiet unless a
  // test sends an event (`emitRemoteHostEvent`), and it has to be able to
  // *drop*, because losing the host is the defining event of using Pane from a
  // phone and the status bar's motion is about saying so.
  class MockEventSource {
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor(readonly url: string) {
      // Handed to the registrar rather than aliased into a local, so the
      // newest stream is reachable without keeping a `self` around.
      register(this);
      // While the host is held down, the client's retries connect to nothing —
      // which is what keeps `reconnecting` on screen for as long as a caller
      // needs rather than for one backoff interval.
      if (!held) {
        window.setTimeout(() => this.onopen?.(new Event('open')), 0);
      }
    }
    readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    addEventListener(name: string, listener: (event: MessageEvent) => void): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    removeEventListener(): void {}
    close(): void {}
  }

  let live: MockEventSource | undefined;
  let held = false;
  const register = (source: MockEventSource) => { live = source; };

  Object.defineProperty(window, 'EventSource', { configurable: true, value: MockEventSource });

  // Drops the stream the way a phone leaving wifi does, and keeps it down. The
  // client's own backoff walks the status to `reconnecting` and keeps retrying
  // into the void until the host is brought back.
  Object.defineProperty(window, '__paneRemoteDropConnection', {
    configurable: true,
    value: () => {
      held = true;
      live?.onerror?.(new Event('error'));
    },
  });

  // Delivers one host event on the live stream, as the daemon's SSE does.
  Object.defineProperty(window, '__paneRemoteEmit', {
    configurable: true,
    value: (channel: string, args: unknown[]) => {
      const data = JSON.stringify({ channel, args, timestamp: new Date().toISOString() });
      for (const listener of live?.listeners.get('daemon-event') ?? []) listener(new MessageEvent('daemon-event', { data }));
    },
  });

  // Lets the next retry through, and opens the one already waiting so the
  // recovery does not have to sit out another backoff interval.
  Object.defineProperty(window, '__paneRemoteRestoreConnection', {
    configurable: true,
    value: () => {
      held = false;
      live?.onopen?.(new Event('open'));
    },
  });
}

/**
 * Stands up a fake remote Pane host and drives the PWA to its connected state.
 * The saved profile is seeded into localStorage, so the PWA reconnects to it on
 * open rather than needing a pasted code.
 */
export async function openConnectedRemotePwa(
  page: Page,
  options: RemotePwaMockOptions = {},
): Promise<RemotePwaMockHost> {
  const fixtures = buildFixtures(options);
  hostFixtures.set(fixtures.host, fixtures);

  await page.addInitScript(installClientMocks, PROFILE);

  await installRemoteHostRoute(page, fixtures);

  await page.goto('/remote.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('tablist', { name: 'Remote tool panels' }).waitFor();
  return fixtures.host;
}

/**
 * Drops the host's event stream, the way a phone leaving wifi does, and holds it
 * down. The client's own backoff walks the status to `reconnecting` and stays
 * there — deliberately, because a host that came straight back would leave the
 * reconnecting state on screen for a single backoff interval, which is not long
 * enough to assert against or to record.
 *
 * Pair with `restoreRemoteConnection` to complete the round trip.
 */
export async function dropRemoteConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const drop = window.__paneRemoteDropConnection;
    if (!drop) throw new Error('Remote PWA mock is not installed on this page.');
    drop();
  });
}

const hostFixtures = new WeakMap<RemotePwaMockHost, ReturnType<typeof buildFixtures>>();

/**
 * Connects another client (its own browser context, so its own storage) to a
 * host already opened with `openConnectedRemotePwa`. Both clients share the
 * host's state.
 */
export async function connectAnotherRemoteClient(page: Page, host: RemotePwaMockHost): Promise<void> {
  const fixtures = hostFixtures.get(host);
  if (!fixtures) throw new Error('Open the host with openConnectedRemotePwa first.');
  await page.addInitScript(installClientMocks, PROFILE);
  await installRemoteHostRoute(page, fixtures);
  await page.goto('/remote.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByRole('tablist', { name: 'Remote tool panels' }).waitFor();
}

/** Sends one host event to this client, the way the daemon's event stream does. */
export async function emitRemoteHostEvent(page: Page, channel: string, ...args: JsonValue[]): Promise<void> {
  await page.evaluate(({ channel, args }) => {
    const emit = window.__paneRemoteEmit;
    if (!emit) throw new Error('Remote PWA mock is not installed on this page.');
    emit(channel, args);
  }, { channel, args });
}

/** Brings the held host back, settling the status to `connected`. */
export async function restoreRemoteConnection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const restore = window.__paneRemoteRestoreConnection;
    if (!restore) throw new Error('Remote PWA mock is not installed on this page.');
    restore();
  });
}

/** Sends a host event, such as `panel:agentStatus`, to the connected PWA. */
export async function emitRemoteEvent(page: Page, channel: string, payload: JsonValue): Promise<void> {
  await emitRemoteHostEvent(page, channel, payload);
}

declare global {
  interface Window {
    /** Installed by `openConnectedRemotePwa`; see `dropRemoteConnection`. */
    __paneRemoteDropConnection?: () => void;
    /** Installed by `openConnectedRemotePwa`; see `restoreRemoteConnection`. */
    __paneRemoteRestoreConnection?: () => void;
    /** Installed by `openConnectedRemotePwa`; see `emitRemoteHostEvent`. */
    __paneRemoteEmit?: (channel: string, args: unknown[]) => void;
  }
}

/** Serves the daemon's invoke endpoint for the channels the PWA calls. */
async function installRemoteHostRoute(
  page: Page,
  fixtures: ReturnType<typeof buildFixtures>,
): Promise<void> {
  await page.route('http://anim-pane.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }

    // SAFETY: the test route receives the remote invoke envelope emitted by this fixture.
    const body = JSON.parse(request.postData() ?? '{}') as { channel?: string; args?: JsonValue[] };
    const { host } = fixtures;
    const args = body.args ?? [];
    // SAFETY: the PWA sends a `{ sessionId }` selector first on every orchestration channel.
    const sessionId = (args[0] as { sessionId?: string } | null)?.sessionId;
    const session = host.sessions.find(candidate => candidate.id === sessionId);
    const ownerSession = host.sessions.find(candidate => candidate.internalSessionId === args[0]);
    let result: JsonValue | ListeningPortsSnapshot = null;
    if (body.channel) await host.held[body.channel];

    switch (body.channel) {
      case 'sessions:get-all-with-projects':
        result = [{ ...fixtures.project, sessions: host.panes }];
        break;
      case 'sessions:get-archived-with-projects':
        result = host.archivedPanes.length > 0 ? [{ ...fixtures.project, sessions: host.archivedPanes }] : [];
        break;
      case 'sessions:delete':
        host.archivedPanes.push(...host.panes.filter(pane => pane.id === args[0]));
        host.panes = host.panes.filter(pane => pane.id !== args[0]);
        break;
      case 'sessions:toggle-favorite':
        for (const pane of host.panes) {
          if (pane.id !== args[0]) continue;
          pane.isFavorite = !pane.isFavorite;
          result = { isFavorite: pane.isFavorite, favoritePinnedAt: new Date().toISOString() };
        }
        break;
      case 'sessions:restore':
        host.panes.push(...host.archivedPanes.filter(pane => pane.id === args[0]));
        host.archivedPanes = host.archivedPanes.filter(pane => pane.id !== args[0]);
        break;
      case 'panels:agent-statuses':
        result = { success: true, data: host.agentStatuses };
        break;
      case 'panels:list':
        result = ownerSession ? sessionWorkspace(ownerSession, host.sessionTools[ownerSession.id]) : fixtures.panelsByPane[String(args[0])] ?? [];
        break;
      case 'panels:getActive':
        result = ownerSession
          ? orchestrationSessionView(ownerSession).panel
          : fixtures.panelsByPane[String(args[0])]?.find(panel => panel.id === host.activePanelIds[String(args[0])]) ?? null;
        break;
      case 'panels:set-active':
        host.activePanelIds[String(args[0])] = String(args[1]);
        result = { success: true };
        break;
      case 'orchestration-sessions:list':
        result = { success: true, data: { sessions: host.sessions } };
        break;
      case 'orchestration-sessions:get':
        result = session
          ? { success: true, data: orchestrationSessionView(session) }
          : { success: false, error: 'Session not found' };
        break;
      case 'orchestration-sessions:create': {
        // SAFETY: the create sheet sends an OrchestrationSessionCreateInput.
        const input = args[0] as { name: string; agent?: 'claude' | 'codex' | 'cursor'; isPinned?: boolean };
        const created = { ...buildOrchestrationSession(input.name, host.sessions.length + 10), agent: input.agent ?? 'claude', isPinned: input.isPinned ?? false };
        host.sessions.push(created);
        result = { success: true, data: orchestrationSessionView(created) };
        break;
      }
      case 'orchestration-sessions:update': {
        if (!session) {
          result = { success: false, error: 'Session not found' };
          break;
        }
        // SAFETY: the PWA sends an OrchestrationSessionUpdateInput second.
        Object.assign(session, args[1] as Partial<OrchestrationSessionRecord>, { updatedAt: new Date().toISOString() });
        result = { success: true, data: session };
        break;
      }
      case 'remote:pwa-affordances':
        result = fixtures.affordances;
        break;
      case 'projects:list-branches':
        result = [
          { name: 'origin/main', isCurrent: false, hasWorktree: false, isRemote: true },
          { name: 'main', isCurrent: true, hasWorktree: false, isRemote: false },
          { name: 'animations-for-the-pane-web-app', isCurrent: true, hasWorktree: true, isRemote: false },
        ];
        break;
      case 'projects:detect-branch':
        result = 'main';
        break;
      case 'ports:list':
        result = fixtures.ports;
        break;
      case 'panels:create': {
        // SAFETY: the PWA sends a CreatePanelRequest first.
        const request = args[0] as { sessionId: string; type: string; title: string };
        const existing = fixtures.panelsByPane[request.sessionId] ?? [];
        result = fixtures.panel(request.sessionId, request.type, request.title, existing.length, request.type === 'browser' ? { currentUrl: '' } : undefined);
        break;
      }
      case 'file:list': {
        // SAFETY: the PWA sends a FileListRequest first.
        const folder = (args[0] as { path?: string }).path ?? '';
        result = { success: true, files: listMockFolder(host.files, folder) };
        break;
      }
      case 'file:read': {
        // SAFETY: the PWA sends a FileReadRequest first.
        const content = host.files[(args[0] as { filePath: string }).filePath];
        result = content === undefined ? { success: false, error: 'ENOENT' }
          : content === null ? { success: false, binary: true, error: 'Binary files cannot be edited as text' }
          : { success: true, content };
        break;
      }
      case 'file:write': {
        // SAFETY: the PWA sends a FileWriteRequest first.
        const request = args[0] as { filePath: string; content: string };
        host.files[request.filePath] = request.content;
        result = { success: true };
        break;
      }
      case 'panels:checkInitialized':
        result = true;
        break;
      case 'panels:get-output':
        result = TERMINAL_SCROLLBACK;
        break;
      default:
        // Panel mutations and terminal writes acknowledge without doing work;
        // no clip depends on the host acting on them.
        result = null;
        break;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, result }),
    });
  });
}

/** One folder of the mock worktree, folders first, the way `file:list` answers. */
function listMockFolder(files: Record<string, string | null>, folder: string) {
  const prefix = folder ? `${folder}/` : '';
  const entries = new Map<string, { name: string; path: string; isDirectory: boolean; size?: number }>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split('/');
    entries.set(name, rest.length
      ? { name, path: `${prefix}${name}`, isDirectory: true }
      : { name, path, isDirectory: false, size: content?.length ?? 1024 });
  }
  return [...entries.values()].sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
}
