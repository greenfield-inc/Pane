import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_APPEARANCE } from '../../shared/types/appearance';
import { ThemeProvider } from '../src/contexts/ThemeProvider';
import { useIPCEvents } from '../src/hooks/useIPCEvents';
import { useMachines } from '../src/hooks/useMachines';
import { useRemoteRuntimeState } from '../src/hooks/useRemoteRuntimeState';
import { AllMachinesSidebar } from '../src/components/machines/AllMachinesSidebar';
import { PaneChatView } from '../src/components/PaneChatView';
import { useAllMachinesStore } from '../src/stores/allMachinesStore';
import { useOrchestrationSessionStore } from '../src/stores/orchestrationSessionStore';
import { useNavigationStore } from '../src/stores/navigationStore';
import { useSessionStore } from '../src/stores/sessionStore';
import { useConfigStore } from '../src/stores/configStore';
import { useErrorStore } from '../src/stores/errorStore';
import { NewDialog } from '../src/components/NewDialog';
import { startHostNavigationMemoryWrites } from '../src/utils/hostNavigationMemory';
import { createDefaultRemoteDaemonConfig, createDefaultRemotePaneConnectionState, type RemotePaneConnectionState } from '../../shared/types/remoteDaemon';
import type { OrchestrationSessionRecord } from '../../shared/types/orchestrationSession';
import type { HostNavigationMemory } from '../../shared/types/hostNavigation';
import type { SessionWorkspaceLayout } from '../../shared/types/sessionWorkspaceLayout';
import type { AppConfig } from '../src/types/config';
import '../src/index.css';

// All machines with this computer ("local", named laptop-L) and one remote host R.
// Only the Electron transport is faked, and it follows main's order of events for
// a host switch (remotePaneClient.connectProfile, ipc/remoteDaemon.ts): the host
// turns active at `connecting`, the resync arrives at `commit`, and a write to a
// remote host that is not yet `connected` is refused.
//
// Query parameters set this desktop's stored state before the test clicks:
//   layoutR / layoutL  stored Session layout for R / local: tiles in order, the last one focused
//   pickR / pickL      the host's shared last-used Session (any client's pick)
//   chat               mount PaneChatView, whose Session workspace reads the stored layout
//   new                open the New dialog, which can create a Session on R and then switch there
type HostKey = 'local' | 'R';
const query = new URLSearchParams(location.search);
const record = (id: string): OrchestrationSessionRecord => ({ id, name: id.toUpperCase(), internalSessionId: `internal-${id}`, agent: 'codex', panelIds: { claude: `claude-${id}`, codex: `codex-${id}`, cursor: `cursor-${id}`, opencode: `opencode-${id}` }, goal: '', context: '', decisions: [], nextAction: '', evidence: [], outputs: [], associations: [], blockers: [], activity: [], revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' });
const hostSessions = new Map<HostKey, OrchestrationSessionRecord[]>([
  ['local', ['x', 'y'].map(record)],
  ['R', ['b', 'c', 'd'].map(record)],
]);
const sharedPick = new Map<HostKey, string>([['local', query.get('pickL') ?? 'y'], ['R', query.get('pickR') ?? 'd']]);
function layoutOf(sessionIds: string[]): SessionWorkspaceLayout {
  const tiles = sessionIds.map(id => ({ type: 'session' as const, id: `tile-${id}`, sessionId: id }));
  const root = tiles.length === 1 ? tiles[0] : { type: 'split' as const, id: 'split', direction: 'row' as const, sizes: tiles.map(() => 1 / tiles.length), children: tiles };
  return { version: 1, root, focusedTileId: tiles[tiles.length - 1].id };
}
const storedLayouts = new Map<HostKey, SessionWorkspaceLayout>();
for (const [param, host] of [['layoutR', 'R'], ['layoutL', 'local']] as const) {
  const ids = query.get(param)?.split(',').filter(Boolean);
  if (ids?.length) storedLayouts.set(host, layoutOf(ids));
}
const memories = new Map<HostKey, HostNavigationMemory>();
const hostKey = (hostId: string | null): HostKey => hostId === 'R' ? 'R' : 'local';
const machineStates = [
  { id: 'local', label: 'This computer', kind: 'local' as const, status: 'online' as const, offlineSince: null },
  { id: 'R', label: 'Remote R', kind: 'remote' as const, status: 'online' as const, offlineSince: null },
];
const profiles = [{ id: 'R', label: 'Remote R', token: 't', baseUrl: 'https://r.example', transport: 'http+sse' as const }];

type TransportCall = { method: string; host: HostKey; sessionId?: string; refused?: boolean };
const calls: TransportCall[] = [];
// Every highlighted row and selection the store passes through after a click.
const trail: Array<{ selected: string | null; highlighted: Array<string | null> }> = [];
let connection: RemotePaneConnectionState = createDefaultRemotePaneConnectionState();
type ClientState = { mode: 'local' | 'remote'; activeProfileId: string | null };
type ClientStateUpdate = { activeProfileId?: string | null; mode?: string };
type TransportReply = { success: boolean; error?: string; data?: object | null };
type ResyncEvent = { hostChanged: boolean; restoreId: number };
let committed: ClientState = { mode: 'local', activeProfileId: null };
let connectionListener: ((state: RemotePaneConnectionState) => void) | null = null;
const handlers = new Map<PropertyKey, Set<(event: ResyncEvent) => void>>();
let pendingSwitch: { updates: ClientStateUpdate; resolve: (value: TransportReply) => void } | null = null;
let restores = 0;
window.addEventListener('pane:host-restored', () => { restores += 1; });

/** Main routes a daemon-owned channel by the connection's mode (remotePaneClient.invoke). */
const routed = (): HostKey => connection.mode === 'remote' ? 'R' : 'local';
const publish = (next: RemotePaneConnectionState) => { connection = next; connectionListener?.(next); };
// SAFETY: The mounted views read only these config fields in this fixture.
const config = (): AppConfig => ({ appearance: DEFAULT_APPEARANCE, theme: 'dark', analytics: { enabled: false }, customCommands: [], defaultOrchestratorAgent: 'claude', remoteDaemon: { ...createDefaultRemoteDaemonConfig(), client: { ...createDefaultRemoteDaemonConfig().client, profiles, mode: committed.mode, activeProfileId: committed.activeProfileId } } } as AppConfig);
const ok = <T extends object | null>(data: T): TransportReply => ({ success: true, data });
const defaultMethod = () => Promise.resolve(ok(null));
const methods = new Proxy({}, { get: () => defaultMethod });
const listOf = (host: HostKey) => ({ sessions: hostSessions.get(host) ?? [], selectedSessionId: sharedPick.get(host) });

const api = {
  invoke: (channel: string) => channel === 'panels:shouldAutoCreate' ? Promise.resolve(false) : defaultMethod(),
  events: new Proxy({}, { get: (_target, key) => (listener: (event: ResyncEvent) => void) => { const listeners = handlers.get(key) ?? new Set(); listeners.add(listener); handlers.set(key, listeners); return () => { listeners.delete(listener); }; } }),
  appearanceSnapshot: undefined,
  getPlatform: () => Promise.resolve('darwin'),
  setBackgroundColor: defaultMethod,
  setTitleBarOverlay: defaultMethod,
  config: { get: () => Promise.resolve(ok(config())) },
  remoteDaemon: {
    getConnectionState: () => Promise.resolve(ok(connection)),
    getHostState: defaultMethod,
    onConnectionStateChanged: (listener: (state: RemotePaneConnectionState) => void) => { connectionListener = listener; return () => { connectionListener = null; }; },
    onHostStateChanged: () => () => {},
    listTailnetMachines: () => Promise.resolve({ success: false, error: 'No Tailscale in this fixture' }),
    getWorkspaceAccess: () => Promise.resolve(ok({ machineName: 'laptop-L' })),
    updateClientState: (updates: ClientStateUpdate) => new Promise<TransportReply>(resolve => { pendingSwitch = { updates, resolve }; }),
    restoreComplete: defaultMethod,
    restoreReady: () => undefined,
  },
  uiState: {
    ...methods,
    getSessionWorkspaceLayout: (hostId: string | null) => Promise.resolve(ok(storedLayouts.get(hostKey(hostId)) ?? null)),
    saveSessionWorkspaceLayout: (hostId: string | null, layout: SessionWorkspaceLayout) => { storedLayouts.set(hostKey(hostId), layout); return defaultMethod(); },
    getExpanded: () => Promise.resolve(ok({ expandedProjects: [], expandedSessions: [], expandedArchivedProjects: [] })),
    getNavigationMemory: (hostId: string | null) => Promise.resolve(ok(memories.get(hostKey(hostId)) ?? null)),
    saveNavigationMemory: (hostId: string | null, memory: HostNavigationMemory) => {
      memories.set(hostKey(hostId), memory);
      calls.push({ method: 'saveNavigationMemory', host: hostKey(hostId), sessionId: memory.orchestrationSessionId ?? undefined });
      return defaultMethod();
    },
  },
  sessions: { ...methods, getAll: () => Promise.resolve(ok([])) },
  projects: { ...methods, getAll: () => Promise.resolve(ok([])) },
  orchestrationSessions: {
    ...methods,
    get: () => new Promise(() => undefined),
    overview: () => new Promise(() => undefined),
    list: () => Promise.resolve(ok(listOf(routed()))),
    select: (selector: { sessionId: string }) => {
      const host = routed();
      if (connection.mode === 'remote' && connection.status !== 'connected') {
        calls.push({ method: 'select', host, sessionId: selector.sessionId, refused: true });
        return Promise.reject(new Error('Remote connection interrupted: the action was not sent while the workspace is disconnected.'));
      }
      calls.push({ method: 'select', host, sessionId: selector.sessionId });
      sharedPick.set(host, selector.sessionId);
      return Promise.resolve(ok(listOf(host)));
    },
  },
  machines: {
    list: () => Promise.resolve(machineStates),
    onEvent: () => () => {},
    read: (machineId: string) => Promise.resolve({ machineId, data: ok(listOf(hostKey(machineId))) }),
    /** New creates a Session on R through R's own connection, whatever the app is on. */
    run: (machineId: string, command: { type: string; input?: { name?: string } }) => {
      const host = hostKey(machineId);
      if (command.type !== 'create-session') return Promise.resolve({ machineId, data: { success: false, error: `The fixture does not run ${command.type}` } });
      const created = record('n');
      created.name = command.input?.name ?? 'N';
      hostSessions.set(host, [created, ...(hostSessions.get(host) ?? [])]);
      calls.push({ method: 'create-session', host, sessionId: created.id });
      // R's live feed would list it next; the fixture's snapshot stands in for that feed.
      useAllMachinesStore.setState(state => ({ snapshots: { ...state.snapshots, [host]: snapshot(host) } }));
      return Promise.resolve({ machineId, data: ok({ session: created }) });
    },
  },
  preferences: { ...methods, get: () => Promise.resolve(null) },
};
// SAFETY: The fixture implements the Electron methods the mounted production
// modules call; any other method resolves a benign empty reply.
Object.defineProperty(window, 'electronAPI', { configurable: true, value: new Proxy(api, { get: (target, key) => (key in target ? target[key as keyof typeof target] : defaultMethod) }) });
Object.defineProperty(window, 'electron', { configurable: true, value: { invoke: () => Promise.resolve(ok({})) } });

const main = {
  /** The remote host turns active: remotePaneClient reports `connecting`. */
  connecting: () => {
    const id = pendingSwitch?.updates.activeProfileId;
    if (!id || pendingSwitch?.updates.mode === 'local') throw new Error('No remote switch is pending');
    publish({ ...connection, mode: 'remote', status: 'connecting', activeProfileId: id, activeProfileLabel: profiles.find(profile => profile.id === id)?.label ?? null });
  },
  restoring: () => publish({ ...connection, status: 'restoring' }),
  /** Config commits, the resync is sent, then the switch call replies. A switch to local also resets the connection first. */
  commit: () => {
    const request = pendingSwitch;
    if (!request) throw new Error('No switch is pending');
    if (request.updates.mode === 'local') {
      publish(createDefaultRemotePaneConnectionState());
      committed = { mode: 'local', activeProfileId: null };
    } else {
      committed = { mode: 'remote', activeProfileId: request.updates.activeProfileId ?? null };
    }
    handlers.get('onRemoteDaemonResyncRequested')?.forEach(listener => listener({ hostChanged: true, restoreId: 1 }));
    pendingSwitch = null;
    request.resolve(ok({ ...committed, profiles }));
  },
  connected: () => publish({ ...connection, status: 'connected' }),
};

const highlighted = () => Array.from(document.querySelectorAll('[aria-current="page"]')).map(node => node.getAttribute('aria-label'));
useOrchestrationSessionStore.subscribe(state => {
  const selected = state.selectedSessionId ?? null;
  const last = trail[trail.length - 1];
  if (!last || last.selected !== selected) trail.push({ selected, highlighted: highlighted() });
});

Object.assign(window, { allMachinesTest: {
  main,
  pendingSwitch: () => pendingSwitch?.updates ?? null,
  restores: () => restores,
  calls: () => calls,
  trail: () => trail,
  /** Forgets the trail and transport calls so far, to watch only what follows. */
  reset: () => { trail.length = 0; calls.length = 0; },
  memory: (host: HostKey) => memories.get(host)?.orchestrationSessionId ?? null,
  rememberSession: (host: HostKey, sessionId: string) => { memories.set(host, { view: 'pane-chat', projectId: null, paneId: null, orchestrationSessionId: sessionId }); },
  storedLayout: (host: HostKey) => storedLayouts.get(host) ?? null,
  sharedPick: (host: HostKey) => sharedPick.get(host) ?? null,
  /** What the machine menu does: switch hosts without naming a row to open. */
  switchMachine: (machineId: string) => { void useAllMachinesStore.getState().switchMachine?.(machineId); },
  state: () => ({
    activeMachine: useAllMachinesStore.getState().entries.find(entry => entry.active)?.id ?? null,
    selectedSessionId: useOrchestrationSessionStore.getState().selectedSessionId ?? null,
    selectionError: useOrchestrationSessionStore.getState().selectionError,
    availability: useOrchestrationSessionStore.getState().availability,
    highlighted: highlighted(),
    shownError: useErrorStore.getState().currentError?.error ?? null,
  }),
} });

// Start on this computer, viewing its Session X.
useConfigStore.setState({ config: config() });
useSessionStore.setState({ sessions: [], isLoaded: true, activeSessionId: null });
useOrchestrationSessionStore.setState({ sessions: hostSessions.get('local') ?? [], selectedSessionId: 'x', availability: 'ready' });
useNavigationStore.setState({ activeView: 'pane-chat' });
const snapshot = (host: HostKey) => ({ projects: [], sessions: hostSessions.get(host) ?? [], statuses: [], notify: null, permissions: [] });
useAllMachinesStore.setState({
  enabled: true,
  machines: machineStates,
  snapshots: { local: snapshot('local'), R: snapshot('R') },
});

/** The All machines wiring from Sidebar.tsx, with the same hooks. */
function MachinesHost() {
  const { connectionState } = useRemoteRuntimeState();
  const { machines, select: selectMachine } = useMachines({ connectionState });
  useEffect(() => {
    useAllMachinesStore.setState({
      entries: machines.map(({ id, name, os, slot, letters, active }) => ({ id, name, os, slot, letters, active })),
      menuShown: true,
      switchMachine: async (machineId) => {
        const machine = machines.find(entry => entry.id === machineId);
        return machine ? selectMachine(machine) : { ok: false, error: 'That machine is no longer saved.' };
      },
      askMachinePassword: () => undefined,
    });
  }, [machines, selectMachine]);
  const [newOpen, setNewOpen] = useState(query.has('new'));
  return newOpen ? <NewDialog projects={[]} machines={machines} onSwitchMachine={selectMachine} onClose={() => setNewOpen(false)} /> : null;
}
function RuntimeEvents() { useIPCEvents(); useEffect(() => startHostNavigationMemoryWrites(), []); return null; }
createRoot(document.getElementById('root')!).render(<ThemeProvider><RuntimeEvents /><MachinesHost /><div style={{ display: 'flex', height: 700 }}><aside style={{ width: 300 }}><AllMachinesSidebar onNew={() => undefined} /></aside>{query.has('chat') && <main style={{ flex: 1 }}><PaneChatView /></main>}</div></ThemeProvider>);
