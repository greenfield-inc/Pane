import { createRoot } from 'react-dom/client';
import { ResourcesView } from '../../frontend/src/components/machineHealth/ResourcesView';
import { useNavigationStore } from '../../frontend/src/stores/navigationStore';
import type { MachineCommand, MachineState } from '../../shared/types/machineConnections';
import type { CleanupRun, MachineHealthSnapshot, StorageInventory } from '../../shared/types/machineHealth';
import '../../frontend/src/index.css';

// The Resources page on canned machines: ?machine=local|devbox, ?theme=dark, ?leak=1 (a leaking dev server).
// The build-box runs an older Pane (no machine health channels) and travel-laptop is offline.
// Every machine health command lands in window.qaRuns.
declare global { interface Window { qaRuns: Array<{ machineId: string; command: MachineCommand }> } }
window.qaRuns = [];
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? ['dark', 'dusk', 'dusk-oled'] : ['light', 'folio'];
document.documentElement.classList.add(...theme);
document.documentElement.style.colorScheme = theme[0];

const GB = 1024 ** 3;
const now = Date.now();
const machines: MachineState[] = [
  { id: 'local', label: 'Studio-Mac', kind: 'local', status: 'online', offlineSince: null },
  { id: 'devbox', label: 'devbox', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'build-box', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null },
  { id: 'travel-laptop', label: 'travel-laptop', kind: 'remote', status: 'offline', offlineSince: now - 3_600_000 },
];

function snapshot(machine: 'local' | 'devbox'): MachineHealthSnapshot {
  const mac = machine === 'local';
  const proc = (pid: number, name: string, sessionId: string, rssMB: number, panelId: string | null = 'tab') =>
    ({ pid, started: 'Sun Nov 15 12:00:00 2026', name, sessionId, panelId, rssMB, cpuPercent: 3, escaped: false });
  return {
    sampledAt: now, platform: mac ? 'darwin' : 'win32', hostname: mac ? 'Studio-Mac' : 'devbox', cpuPercent: mac ? 38 : 12,
    disk: { level: mac ? 'critical' : 'ok', volumes: [{ path: '/', roles: ['pane-data', 'worktrees', 'temp'], totalBytes: 926 * GB, freeBytes: (mac ? 13 : 212) * GB, level: mac ? 'critical' : 'ok' }] },
    memory: { level: mac ? 'warning' : 'ok', source: mac ? 'macos-pressure' : 'available', detail: '', totalBytes: (mac ? 32 : 64) * GB, freeBytes: (mac ? 1.1 : 30) * GB, swapUsedBytes: mac ? 3 * GB : null },
    app: { rssMB: 2600, cpuPercent: 4 },
    panes: [
      { sessionId: 's1', name: 'glassly-port', rssMB: 1200, cpuPercent: 4, processes: [proc(11, 'claude', 's1', 900), proc(12, 'node', 's1', 300)] },
      { sessionId: 's2', name: 'homepage-alpine', rssMB: 2400, cpuPercent: 9, processes: [proc(21, 'vite', 's2', 2400, null)] },
      { sessionId: 's3', name: 'remote-access-bench', rssMB: 1100, cpuPercent: 1, processes: [proc(31, 'codex', 's3', 1100)] },
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

function outdated(): never {
  throw new Error('Error invoking remote method \'machines:read\': Error [ERR_UNKNOWN_CHANNEL]: No Pane daemon command registered for channel "resource-monitor:machine-health".');
}

const api = {
  machines: {
    list: async () => machines,
    onEvent: () => () => {},
    read: async (machineId: string, channel: string) => {
      if (machineId === 'build-box') outdated();
      if (machineId === 'travel-laptop') throw new Error('Error invoking remote method \'machines:read\': Error [ERR_MACHINE_OFFLINE]: travel-laptop is offline.');
      const machine = machineId === 'devbox' ? 'devbox' : 'local';
      const data = channel === 'resource-monitor:machine-health' ? snapshot(machine)
        : channel === 'resource-monitor:machine-inventory' ? inventory
          : channel === 'resource-monitor:machine-finished-panes' ? finished
            : channel === 'resource-monitor:machine-relief' ? { idle: { paneIds: ['a', 'b'], memoryMB: 2250 }, leftBehind: [{ pid: 77, started: 's', name: 'fake-runpane.js', sessionId: 's1', panelId: null, rssMB: 40, cpuPercent: 0, escaped: true }] }
              : history;
      return { machineId, data };
    },
    run: async (machineId: string, command: MachineCommand) => { window.qaRuns.push({ machineId, command }); return { machineId, data: null }; },
  },
  invoke: async () => null,
};
Object.assign(window, { electronAPI: api });
useNavigationStore.setState({ activeView: 'resources', resourcesMachineId: params.get('machine') ?? 'local' });

createRoot(document.getElementById('root')!).render(
  <div className="flex h-screen bg-surface-primary"><ResourcesView /></div>,
);
