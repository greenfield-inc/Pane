import { createRoot } from 'react-dom/client';
import { ResourcesView } from '../../frontend/src/components/machineHealth/ResourcesView';
import { useNavigationStore } from '../../frontend/src/stores/navigationStore';
import { usePanelStore } from '../../frontend/src/stores/panelStore';
import { useConfigStore } from '../../frontend/src/stores/configStore';
import { useActiveMachineStore } from '../../frontend/src/stores/activeMachineStore';
import { useAllMachinesStore } from '../../frontend/src/stores/allMachinesStore';
import { useOrchestrationSessionStore } from '../../frontend/src/stores/orchestrationSessionStore';
import { MachineHealthSettings } from '../../frontend/src/components/settings/categories/MachineHealthSettings';
import { useSettingsPersistence } from '../../frontend/src/components/settings/useSettingsPersistence';
import type { AppConfig, UpdateConfigRequest } from '../../frontend/src/types/config';
import type { MachineCommand, MachineConnectionsEvent, MachineState } from '../../shared/types/machineConnections';
import type { ToolPanel } from '../../shared/types/panels';
import type { CleanupRun, MachineHealthSnapshot, OtherApp, StorageInventory } from '../../shared/types/machineHealth';
import '../../frontend/src/index.css';

// The Resources page on canned machines: ?machine=local|devbox, ?theme=dark, ?leak=1 (a leaking dev server),
// ?housekeeping=off (another Pane owns the data folder, so this one runs no cleanup), ?view=settings (Settings › Machine health),
// ?apps=outdated (the machine's Pane predates the app list),
// ?window=devbox (the window is switched to the devbox). Ask an agent answers with Session qa-session; the Session
// selected lands in window.qaSelected and each machine switch in window.qaSwitches.
// The build-box runs an older Pane (no machine health channels) and travel-laptop is offline.
// Every machine health command lands in window.qaRuns; window.qaSetStatus(id, status) changes a machine's status.
declare global {
  interface Window {
    qaRuns: Array<{ machineId: string; command: MachineCommand }>;
    qaInvokes: Array<{ channel: string; args: unknown[] }>;
    qaSetStatus: (machineId: string, status: MachineState['status']) => void;
    qaConfigUpdates: UpdateConfigRequest[];
    qaSelected: string[];
    qaSwitches: string[];
  }
}
window.qaRuns = [];
window.qaConfigUpdates = [];
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? ['dark', 'dusk', 'dusk-oled'] : ['light', 'folio'];
document.documentElement.classList.add(...theme);
document.documentElement.style.colorScheme = theme[0];

const GB = 1024 ** 3;
const now = Date.now();
let machines: MachineState[] = [
  { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
  { id: 'devbox', label: 'devbox', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'build-box', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'travel-laptop', label: 'travel-laptop', kind: 'remote', status: 'offline', offlineSince: new Date(now - 3_600_000).toISOString() },
];

function snapshot(machine: 'local' | 'devbox'): MachineHealthSnapshot {
  const mac = machine === 'local';
  const proc = (pid: number, name: string, sessionId: string, rssMB: number, panelId: string | null, cpuPercent: number) =>
    ({ pid, started: 'Sun Nov 15 12:00:00 2026', name, sessionId, panelId, rssMB, cpuPercent, escaped: false });
  return {
    sampledAt: now, platform: mac ? 'darwin' : 'win32', hostname: mac ? 'Studio-Mac' : 'devbox', cpuPercent: mac ? 38 : 12,
    disk: { level: mac ? 'critical' : 'ok', volumes: [{ path: '/', roles: ['pane-data', 'worktrees', 'temp'], totalBytes: 926 * GB, freeBytes: (mac ? 13 : 212) * GB, level: mac ? 'critical' : 'ok' }] },
    memory: { level: mac ? 'warning' : 'ok', source: mac ? 'macos-pressure' : 'available', detail: '', totalBytes: (mac ? 32 : 64) * GB, freeBytes: (mac ? 1.1 : 30) * GB, swapUsedBytes: mac ? 3 * GB : null },
    app: { rssMB: 2600, cpuPercent: 4 },
    panes: [
      { sessionId: 's1', name: 'glassly-port', rssMB: 1200, cpuPercent: 4, processes: [proc(11, 'claude', 's1', 900, 'p1', 3), proc(12, 'node', 's1', 300, 'p2', 1), proc(13, '/usr/local/bin/node', 's1', 120, 'p2', 0.4)] },
      { sessionId: 's2', name: 'homepage-alpine', rssMB: 2400, cpuPercent: 9, processes: [proc(21, 'vite', 's2', 2400, null, 9)] },
      { sessionId: 's3', name: 'remote-access-bench', rssMB: 1100, cpuPercent: 1, processes: [proc(31, 'codex', 's3', 1100, 'p3', 1)] },
    ],
    leaks: params.has('leak') && mac ? [{ pid: 21, started: 'Sun Nov 15 12:00:00 2026', name: 'vite', sessionId: 's2', panelId: null, memoryMB: 2400, growthMB: 1229, windowMs: 1_800_000, series: [1180, 1390, 1600, 1810, 2050, 2240, 2400] }] : [],
  };
}

const inventory: StorageInventory = {
  scannedAt: now, durationMs: 41_000,
  buckets: { paneWorktrees: 112 * GB, dependencies: 74 * GB, qaAndScratch: 20 * GB, agentTemp: 41 * GB, paneData: 22 * GB },
  items: [
    { id: 'u', kind: 'update-snapshot', tier: 1, path: '/Users/me/.pane/updates/u-2.4.212', sizeBytes: 9.3 * GB, modifiedAt: now, sessionId: null, reason: 'The rollback copy of an update a newer update replaced.' },
    { id: 't', kind: 'agent-temp', tier: 2, path: '/tmp/claude-501/qa1344.noindex', sizeBytes: 11.8 * GB, modifiedAt: now, sessionId: null, reason: 'Agent temp files nobody touched for 2 days.' },
    { id: 'q', kind: 'paused-scratch', tier: 2, path: '/w/release/.pane/scratch', sizeBytes: 2.7 * GB, modifiedAt: now, sessionId: 's9', reason: 'Scratch of a paused Pane.' },
    { id: 'f', kind: 'foreign-worktree', tier: 3, path: '/Users/me/bloom-mono/worktrees/agent-made', sizeBytes: 4.1 * GB, modifiedAt: now, sessionId: null, reason: 'A worktree or folder Pane did not create.', howToFree: 'git worktree remove "/Users/me/bloom-mono/worktrees/agent-made"' },
  ],
  panes: [
    { sessionId: 's4', name: 'simulators', worktreePath: '/w/simulators', worktreeBytes: 18.6 * GB, dependencyBytes: 2 * GB, buildOutputBytes: 1 * GB, scratchBytes: 14 * GB, agentTempBytes: 0.4 * GB },
    { sessionId: 's3', name: 'remote-access-bench', worktreePath: '/w/rab', worktreeBytes: 14.2 * GB, dependencyBytes: 1 * GB, buildOutputBytes: 0.5 * GB, scratchBytes: 11 * GB, agentTempBytes: 0.2 * GB },
    { sessionId: 's1', name: 'glassly-port', worktreePath: '/w/glassly', worktreeBytes: 3.1 * GB, dependencyBytes: 2.4 * GB, buildOutputBytes: 0.2 * GB, scratchBytes: 0.1 * GB, agentTempBytes: 1.1 * GB },
  ],
};

const finished = [
  { sessionId: 'f1', name: 'Spanner schema diff fix (#808)', projectName: 'bloom-mono', reason: 'pr-merged', prNumber: 808, idleDays: 2, sizeBytes: 6.2 * GB, protection: null },
  { sessionId: 'f2', name: 'release-2.4.223', projectName: 'Pane', reason: 'idle', idleDays: 14, sizeBytes: 2.9 * GB, protection: 'It is pinned.' },
  { sessionId: 'f3', name: 'ademark-hillclimb', projectName: 'Pane', reason: 'folder-missing', idleDays: 3, sizeBytes: 1.1 * GB, protection: null },
];
const history: CleanupRun[] = [{ at: now - 3_600_000, source: 'schedule', removed: [{ id: 'x', kind: 'update-snapshot', path: '/u', sizeBytes: 0.7 * GB }], skipped: [], freedBytes: 0.7 * GB }];

const MACOS = 'Part of macOS. Pane never stops system processes.';
const app = (key: string, name: string, rssMB: number, cpuPercent: number, processCount: number, protectedReason: string | null = null): OtherApp =>
  ({ key, name, rssMB, cpuPercent, processCount, protectedReason, byName: !key.startsWith('/') });
const otherApps = {
  local: [
    app('/Applications/Google Chrome.app', 'Google Chrome', 4300, 12.4, 23),
    app('/Applications/Slack.app', 'Slack', 1250, 1.2, 6),
    app('/Applications/Docker.app', 'Docker', 1100, 3.1, 9),
    app('/System/Library/CoreServices/WindowServer', 'WindowServer', 820, 9.5, 1, MACOS),
    app('/Applications/Visual Studio Code.app', 'Visual Studio Code', 760, 0.6, 11),
    app('/Applications/Spotify.app', 'Spotify', 410, 2.2, 5),
    app('/System/Applications/Utilities/Terminal.app', 'Terminal', 260, 0.3, 1, 'Pane runs inside it, so stopping it would stop Pane.'),
    app('/System/Library/CoreServices/Finder.app', 'Finder', 240, 0.1, 1, MACOS),
    app('/Applications/Figma.app', 'Figma', 230, 0, 4),
    app('/Applications/Notion.app', 'Notion', 210, 0, 4),
    app('postgres', 'postgres', 120, 0.2, 7),
    app('/Applications/1Password.app', '1Password', 110, 0, 3),
    app('node', 'node', 90, 0, 2),
    app('/System/Applications/Notes.app', 'Notes', 60, 0, 1),
  ],
  devbox: [
    app('chrome', 'chrome', 2100, 4, 18),
    app('explorer', 'explorer', 180, 0.4, 1, 'Part of Windows. Pane never stops system processes.'),
    app('code', 'Code', 640, 1, 9),
  ],
} satisfies Record<'local' | 'devbox', OtherApp[]>;
const stoppedApps = new Set<string>();

function outdated(): never {
  throw new Error('Error invoking remote method \'machines:read\': Error [ERR_UNKNOWN_CHANNEL]: No Pane daemon command registered for channel "resource-monitor:machine-health".');
}

const listeners = new Set<(event: MachineConnectionsEvent) => void>();
window.qaSetStatus = (machineId, status) => {
  machines = machines.map(machine => (machine.id === machineId ? { ...machine, status, offlineSince: status === 'offline' ? new Date().toISOString() : null } : machine));
  for (const listener of listeners) listener({ type: 'machines', machines });
};

window.qaInvokes = [];
const api = {
  machines: {
    list: async () => machines,
    onEvent: (listener: (event: MachineConnectionsEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    read: async (machineId: string, channel: string) => {
      if (machineId === 'build-box') outdated();
      if (machineId === 'travel-laptop') throw new Error('Error invoking remote method \'machines:read\': Error [ERR_MACHINE_OFFLINE]: travel-laptop is offline.');
      const machine = machineId === 'devbox' ? 'devbox' : 'local';
      if (channel === 'resource-monitor:machine-apps') {
        if (params.get('apps') === 'outdated') throw new Error('Error invoking remote method \'machines:read\': Error [ERR_UNKNOWN_CHANNEL]: No Pane daemon command registered for channel "resource-monitor:machine-apps".');
        return { machineId, data: otherApps[machine].filter(item => !stoppedApps.has(item.key)).sort((a, b) => b.rssMB - a.rssMB) };
      }
      const data = channel === 'resource-monitor:machine-health' ? snapshot(machine)
        : channel === 'resource-monitor:machine-inventory' ? inventory
          : channel === 'resource-monitor:machine-finished-panes' ? finished
            : channel === 'resource-monitor:machine-relief' ? {
              idle: { paneIds: ['a', 'b'], memoryMB: 2250, hours: machine === 'local' ? 2 : 6 },
              leftBehind: [{ pid: 77, started: 's', name: 'fake-runpane.js', sessionId: 's1', panelId: null, rssMB: 40, cpuPercent: 0, escaped: true }],
              restartable: [21],
              housekeeping: params.get('housekeeping') !== 'off',
            }
              : history;
      return { machineId, data };
    },
    run: async (machineId: string, command: MachineCommand) => {
      window.qaRuns.push({ machineId, command });
      if (command.type === 'machine-health' && command.action === 'stop-app') {
        const request = JSON.stringify(command.request);
        for (const item of [...otherApps.local, ...otherApps.devbox]) if (request.includes(JSON.stringify(item.key))) stoppedApps.add(item.key);
      }
      return { machineId, data: null };
    },
  },
  invoke: async (channel: string, ...args: unknown[]) => {
    window.qaInvokes.push({ channel, args });
    return channel === 'resource-monitor:machine-ask-agent' ? { sessionId: 'qa-session', panelId: 'qa-panel' } : null;
  },
};
Object.assign(window, { electronAPI: api });
const tab = (id: string, sessionId: string, title: string): ToolPanel => ({
  id, sessionId, type: 'terminal', title, state: { isActive: false }, metadata: { createdAt: '', lastActiveAt: '', position: 0 },
});
usePanelStore.setState({ panels: { s1: [tab('p1', 's1', 'Claude'), tab('p2', 's1', 'Terminal 1')], s3: [tab('p3', 's3', 'Codex')] } });
useNavigationStore.setState({ activeView: 'resources', resourcesMachineId: params.get('machine') ?? 'local' });
window.qaSelected = [];
window.qaSwitches = [];
useOrchestrationSessionStore.setState({ select: async ({ sessionId }) => { if (sessionId) window.qaSelected.push(sessionId); } });
if (params.get('window') === 'devbox') useActiveMachineStore.setState({ machine: { id: 'devbox', name: 'devbox', os: 'windows', slot: 1, letters: 'D', local: false } });
useAllMachinesStore.setState({
  switchMachine: async machineId => {
    window.qaSwitches.push(machineId);
    useActiveMachineStore.setState({ machine: null });
    return { ok: true };
  },
});

// SAFETY: these screens read only machineHealth from the config.
useConfigStore.setState({ config: { machineHealth: { autoClearAgentTemp: true, finishedIdleDays: 14 } } as AppConfig });
useConfigStore.setState({
  updateConfig: async updates => {
    window.qaConfigUpdates.push(updates);
    const config = useConfigStore.getState().config;
    // SAFETY: the fixture's config holds only machineHealth; main merges machineHealth field by field the same way.
    const next = { ...config, machineHealth: { ...config?.machineHealth, ...updates.machineHealth } } as AppConfig;
    useConfigStore.setState({ config: next });
    return next;
  },
});

function Settings() {
  const persistence = useSettingsPersistence(false);
  return <div className="w-full overflow-y-auto p-8"><MachineHealthSettings persistence={persistence} /></div>;
}

createRoot(document.getElementById('root')!).render(
  <div className="flex h-screen bg-surface-primary">{params.get('view') === 'settings' ? <Settings /> : <ResourcesView />}</div>,
);
