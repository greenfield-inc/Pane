import { Profiler } from 'react';
import { DEFAULT_APPEARANCE } from '../../shared/types/appearance';
import { ThemeProvider } from '../src/contexts/ThemeProvider';
import { useIPCEvents } from '../src/hooks/useIPCEvents';
import { createRoot } from 'react-dom/client';
import { OrchestrationSessionNav } from '../src/components/OrchestrationSessionNav';
import { ProjectSessionList } from '../src/components/ProjectSessionList';
import { SessionView } from '../src/components/SessionView';
import { WindowTitleBar } from '../src/components/WindowTitleBar';
import { AIAgentsSettings } from '../src/components/settings/categories/AIAgentsSettings';
import { useSettingsPersistence } from '../src/components/settings/useSettingsPersistence';
import { useSessionStore } from '../src/stores/sessionStore';
import { useOrchestrationSessionStore } from '../src/stores/orchestrationSessionStore';
import { useConfigStore } from '../src/stores/configStore';
import { useNavigationStore } from '../src/stores/navigationStore';
import { useSessionWorkspaceLayoutStore } from '../src/stores/sessionWorkspaceLayoutStore';
import { createDefaultRemoteDaemonConfig } from '../../shared/types/remoteDaemon';
import type { OrchestrationSessionCreateInput, OrchestrationSessionRecord, OrchestrationSessionView } from '../../shared/types/orchestrationSession';
import type { Session } from '../src/types/session';
import type { AppConfig, UpdateConfigRequest } from '../src/types/config';
import '../src/index.css';

// Only the Electron transport boundary is faked. Clicks, stores and rendering
// use the production components. Requests resolve when the test tells them to.
type TransportReply = { success: boolean; error?: string; data?: object | null };
let runtime = 'outgoing';
type RuntimeEvent = { hostChanged: boolean } | { paneId: string };
const handlers = new Map<PropertyKey, Set<(event: RuntimeEvent) => void>>();
const pending: Array<{ kind: string; id: string; runtime: string; resolve: (value: TransportReply) => void }> = [];
const wait = (kind: string, id: string) => new Promise<TransportReply>(resolve => pending.push({ kind, id, runtime, resolve }));
const panes: Session[] = ['a', 'b'].map(id => ({ id, name: `Pane ${id.toUpperCase()}`, projectId: 1, status: 'stopped', worktreePath: `/test/${id}`, prompt: '', output: [], jsonMessages: [], createdAt: '2026-01-01', lastActivity: '2026-01-01' }));
const records: OrchestrationSessionRecord[] = ['a', 'b'].map(id => ({ id, name: `Session ${id.toUpperCase()}`, internalSessionId: `internal-${id}`, agent: 'codex', panelIds: { claude: `claude-${id}`, codex: `codex-${id}`, cursor: `cursor-${id}`, opencode: `opencode-${id}` }, goal: `Goal ${id}`, context: `Context ${id}`, decisions: [], nextAction: '', evidence: [], outputs: [], associations: [{ paneId: id, panelIds: [], attachedAt: '2026-01-01' }], blockers: [], activity: [], revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }));
const transportCalls: Array<{ method: string; payload?: unknown; data?: unknown }> = [];
// sessionStorage is mock service storage, not application persistence. It survives
// page reload in this test's fresh browser context, never touching a user profile.
const savedMockConfig = sessionStorage.getItem('selection-mock-config');
// SAFETY: Only this fixture writes the complete mock config to this private key.
let mockConfig = savedMockConfig ? JSON.parse(savedMockConfig) as AppConfig : { appearance: DEFAULT_APPEARANCE, theme: 'dark', remoteDaemon: createDefaultRemoteDaemonConfig(), analytics: { enabled: false }, customCommands: [], defaultOrchestratorAgent: 'claude' } as AppConfig;
function sessionView(id: string): OrchestrationSessionView<Session> {
  const session = records.find(record => record.id === id);
  if (!session) throw new Error(`Unknown mock Session ${id}`);
  const agent = session.agent;
  return { session, internalSession: { ...(panes.find(pane => pane.id === id) ?? panes[0]), id: session.internalSessionId, isHidden: true }, panel: { id: session.panelIds[agent], sessionId: session.internalSessionId, type: 'terminal', title: `Agent ${id}`, state: { isActive: true, customState: { agentType: agent, isInitialized: false } }, metadata: { position: 0, createdAt: '2026-01-01', lastActiveAt: '2026-01-01' } }, agent, cwd: '/test', guidePath: '/test/guide', started: false };
}
const list = (id = 'a') => ({ success: true, data: { sessions: [...records], selectedSessionId: id } });
const defaultMethod = () => Promise.resolve({ success: true, data: null });
const methods = new Proxy({}, { get: () => defaultMethod });
function runtimeConfig(): AppConfig {
  const config = useConfigStore.getState().config;
  if (!config) throw new Error('Fixture config not initialized');
  const remoteDaemon = config.remoteDaemon ?? createDefaultRemoteDaemonConfig();
  return { ...config, remoteDaemon: { ...remoteDaemon, client: { ...remoteDaemon.client,
    profiles: [{ id: 'outgoing', label: 'Outgoing', token: 'test', baseUrl: 'https://outgoing.example', transport: 'http+sse' }, { id: 'incoming', label: 'Incoming', token: 'test', baseUrl: 'https://incoming.example', transport: 'http+sse' }], mode: 'remote', activeProfileId: runtime } } };
}
let runtimeRefreshes = 0;
window.addEventListener('project-sessions-refresh', () => { runtimeRefreshes += 1; });
const api = {
  invoke: (channel: string, id: string) => channel === 'panels:shouldAutoCreate' ? Promise.resolve(false) : channel === 'panels:get-layout' ? wait('layout', id) : defaultMethod(),
  events: new Proxy({}, { get: (_target, key) => (listener: (event: RuntimeEvent) => void) => { const listeners = handlers.get(key) ?? new Set(); listeners.add(listener); handlers.set(key, listeners); return () => { listeners.delete(listener); }; } }),
  orchestrationSessions: { create: (input: OrchestrationSessionCreateInput) => {
    records.push({ ...records[0], id: 'created', internalSessionId: 'internal-created', name: input.name, agent: input.agent ?? 'claude', panelIds: { claude: 'claude-created', codex: 'codex-created', cursor: 'cursor-created', opencode: 'opencode-created' }, associations: [] });
    const data = sessionView('created');
    transportCalls.push({ method: 'orchestrationSessions.create', payload: input, data });
    return Promise.resolve({ success: true, data });
  }, runtimes: () => Promise.resolve({ success: true, data: { distributions: [] } }), update: (selector: { sessionId: string }) => wait('update', selector.sessionId), list: () => location.search.includes('events') ? wait('list', 'a') : Promise.resolve(list()), select: (selector: { sessionId: string }) => { transportCalls.push({ method: 'orchestrationSessions.select', payload: selector }); return wait('select', selector.sessionId); }, get: (selector: { sessionId: string }) => wait('get', selector.sessionId), overview: (selector: { sessionId: string }) => Promise.resolve({ success: true, data: { session: records.find(record => record.id === selector.sessionId), status: { state: 'idle' }, panes: [], activity: [], refreshedAt: '2026-01-01' } }) },
  terminal: methods,
  panels: { ...methods, getSessionPanels: (id: string) => wait('panels', id), setActivePanel: defaultMethod },
  config: { get: () => {
    const data = location.search.includes('lists') ? runtimeConfig() : mockConfig;
    transportCalls.push({ method: 'config.get', data });
    return Promise.resolve({ success: true, data });
  }, update: (updates: UpdateConfigRequest) => {
    mockConfig = { ...mockConfig, ...updates };
    sessionStorage.setItem('selection-mock-config', JSON.stringify(mockConfig));
    transportCalls.push({ method: 'config.update', payload: updates, data: mockConfig });
    return Promise.resolve({ success: true, data: mockConfig });
  } },
  uiState: { ...methods, getExpanded: () => wait('expanded', 'host'), getNavigationMemory: (hostId: string | null) => location.search.includes('lists') ? wait('memory', hostId ?? 'local') : defaultMethod(), saveNavigationMemory: defaultMethod, getSessionWorkspaceLayout: () => location.search.includes('hydrate') ? wait('workspace', 'host') : Promise.resolve({ success: true, data: location.search.includes('tiles') ? { version: 1, root: { type: 'split', id: 'split', direction: 'row', sizes: [0.5, 0.5], children: [{ type: 'session', id: 'tile-a', sessionId: 'a' }, { type: 'session', id: 'tile-b', sessionId: 'b' }] }, focusedTileId: 'tile-a' } : null }), saveSessionWorkspaceLayout: defaultMethod, saveExpandedProjects: defaultMethod, getPaneLayout: defaultMethod, savePaneLayout: defaultMethod },
  sessions: { getConversationMessageCount: () => Promise.resolve({ success: true, data: 0 }), getGitCommands: () => Promise.resolve({ success: true, data: [] }), getOutput: () => Promise.resolve({ success: true, data: [] }), getJsonMessages: defaultMethod, getStatistics: defaultMethod, hasChangesToRebase: () => Promise.resolve({ success: true, data: false }), hasStash: () => Promise.resolve({ success: true, data: false }), get: (id: string) => wait('pane', id), getAll: () => location.search.includes('lists') ? wait('runtime-list', runtime) : Promise.resolve({ success: true, data: location.search.includes('runtime') ? [] : panes }), markViewed: defaultMethod },
  projects: { resolveRunScript: defaultMethod, resolveSetupScript: defaultMethod, getAll: () => Promise.resolve({ success: true, data: [{ id: 1, name: 'Test', path: '/test' }] }), get: () => Promise.resolve({ success: true, data: { id: 1, name: 'Test', path: '/test' } }) },
  appearanceSnapshot: undefined,
  getPlatform: () => Promise.resolve('linux'),
  setBackgroundColor: defaultMethod,
  setTitleBarOverlay: defaultMethod,
};
// SAFETY: This fixture implements the Electron methods consumed by the mounted
// production components; unused methods resolve benign transport responses.
Object.defineProperty(window, 'electronAPI', { configurable: true, value: new Proxy(api, { get: (target, key) => {
  if (key in target) {
    // SAFETY: Membership above establishes key as an API fixture property.
    return target[key as keyof typeof target];
  }
  return defaultMethod;
} }) });
// SAFETY: The mounted views read only these config fields in this fixture.
useConfigStore.setState({ config: location.search.includes('settings') ? null : mockConfig });
Object.defineProperty(window, 'electron', { configurable: true, value: { invoke: () => Promise.resolve({ success: true, data: {} }) } });
useSessionStore.setState({ sessions: location.search.includes('runtime') ? [] : panes, isLoaded: true, activeSessionId: null });
useOrchestrationSessionStore.setState({ sessions: [...records], selectedSessionId: 'a', availability: 'ready' });
useSessionWorkspaceLayoutStore.setState({ layout: null, loaded: false });
// Sessions start collapsed; these races click Panes under them, so start them expanded.
useNavigationStore.setState({ activeView: 'sessions', expandedSessions: new Set(records.map(record => record.id)) });

Object.assign(window, { selectionTest: {
  transportCalls: () => transportCalls,
  pending: () => pending.map(({ kind, id }) => ({ kind, id })),
  resolve: (kind: string, id: string, error?: string) => {
    const index = (kind === 'workspace' || kind === 'list') ? pending.map(item => item.kind === kind && item.id === id).lastIndexOf(true) : pending.findIndex(item => item.kind === kind && item.id === id);
    if (index < 0) throw new Error(`No ${kind} ${id} request`);
    const [request] = pending.splice(index, 1);
    request.resolve(error ? { success: false, error } : kind === 'memory' ? { success: true, data: { view: 'sessions', paneId: 'a', projectId: null } } : kind === 'runtime-list' ? { success: true, data: [{ ...panes[request.runtime === 'outgoing' && location.search.includes('no-collision') ? 1 : 0], name: `${request.runtime} Pane A` }] } : kind === 'pane' ? { success: true, data: { ...panes[0], name: `${request.runtime} Pane A` } } : kind === 'select' ? list(id) : kind === 'get' ? { success: true, data: sessionView(id) } : kind === 'list' ? list('a') : kind === 'workspace' ? { success: true, data: { version: 1, root: { type: 'session', id: 'tile-a', sessionId: 'a' }, focusedTileId: 'tile-a' } } : kind === 'panels' ? { success: true, data: [] } : { success: true, data: null });
  },
  emit: (kind: 'host' | 'pane' | 'resync') => {
    if (kind === 'host') { runtime = 'incoming'; handlers.get('onRemoteDaemonResyncRequested')?.forEach(listener => listener({ hostChanged: true })); }
    else if (kind === 'resync') handlers.get('onRemoteDaemonResyncRequested')?.forEach(listener => listener({ hostChanged: false }));
    else handlers.get('onPaneFocusRequested')?.forEach(listener => listener({ paneId: 'a' }));
  },
  runtimeRefreshes: () => runtimeRefreshes,
  state: () => ({ error: useOrchestrationSessionStore.getState().error, selectionError: useOrchestrationSessionStore.getState().selectionError, route: useNavigationStore.getState().activeView, session: useOrchestrationSessionStore.getState().selectedSessionId, pane: useSessionStore.getState().activeSessionId }),
} });
function RuntimeEvents() { useIPCEvents(); return null; }
type CommitSnapshot = { selected?: string; contents: Array<string | null>; focused: string | null };
const commits: CommitSnapshot[] = [];
const captureCommit = () => { commits.push({ selected: useOrchestrationSessionStore.getState().selectedSessionId, contents: Array.from(document.querySelectorAll('.pane-chat-shell')).map(node => node.getAttribute('data-session-content-id')), focused: document.querySelector('[data-session-focused="true"]')?.getAttribute('data-session-tile') ?? null }); };
Object.assign(window.selectionTest, { commits: () => commits, resetCommits: () => { commits.length = 0; } });
const noop = () => {};
function SettingsFixture() {
  const persistence = useSettingsPersistence(true);
  return persistence.config ? <AIAgentsSettings persistence={persistence} onDirtyChange={noop} /> : <p role="status">Loading mock settings</p>;
}
createRoot(document.getElementById('root')!).render(<Profiler id="selection" onRender={captureCommit}><ThemeProvider>{location.search.includes('settings') ? <SettingsFixture /> : <>{location.search.includes('runtime') && <RuntimeEvents />}<WindowTitleBar projects={[{ id: 1, name: 'Test', path: '/test', active: true, created_at: '2026-01-01', updated_at: '2026-01-01' }]} sidebarWidth={250} sidebarCollapsed={false} /><div style={{ display: 'flex', height: 700 }}><aside style={{ width: 250 }}>{location.search.includes('compact') ? <OrchestrationSessionNav compact /> : <ProjectSessionList projects={[]} onProjectsChange={noop} onProjectsRefresh={noop} sessionSortAscending pinnedSectionExpanded repositoriesSectionExpanded onPinnedSectionExpandedChange={noop} onRepositoriesSectionExpandedChange={noop} sshHostsSectionExpanded onSshHostsSectionExpandedChange={noop} sessionsSectionExpanded onSessionsSectionExpandedChange={noop} />}</aside><SessionView /></div></>}</ThemeProvider></Profiler>);
