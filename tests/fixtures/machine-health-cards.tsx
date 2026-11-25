import { createRoot } from 'react-dom/client';
import { HealthCardBody } from '../../frontend/src/components/machineHealth/HealthCardBody';
import { HealthCardPopups } from '../../frontend/src/components/machineHealth/HealthCardPopups';
import { useNavigationStore } from '../../frontend/src/stores/navigationStore';
import { useNotifyStore } from '../../frontend/src/stores/notifyStore';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyCommand } from '../../shared/types/notify';
import type { HealthNotifyItem } from '../../frontend/src/components/machineHealth/healthCardActions';
import type { MachineHealthCard } from '../../shared/types/machineHealth';
import '../../frontend/src/index.css';

// One machine health card body: ?kind=memory|disk|leak|finished|leftovers (memory comes only from an older linked Pane), ?theme=dark, ?remote=1 (raised by a
// linked machine). Answers land in window.qaAnswers and Ask an agent in window.qaAsked.
// ?popup=warning|critical: the in-window popups over a sample window, with Notify commands in window.qaCommands,
// window.qaResolve(id) ending a card, and window.qaView() naming the view Open Resources went to.
declare global { interface Window { qaAnswers: string[]; qaAsked: number; qaCommands: NotifyCommand[]; qaResolve: (id: string) => void; qaAdd: (id: string) => void; qaView: () => string } }
window.qaAnswers = [];
window.qaAsked = 0;
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? ['dark', 'dusk', 'dusk-oled'] : ['light', 'folio'];
document.documentElement.classList.add(...theme);
document.documentElement.style.colorScheme = theme[0];

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const remote = params.has('remote');
const host = remote ? 'build-box' : 'This Mac';
const kind = params.get('kind') ?? 'memory';

interface FixtureCard { title: string; context: string; choices: string[]; card: MachineHealthCard }
const cards = {
  memory: {
    title: 'Memory is tight',
    context: 'Using 30.9 GB of 32 GB, plus 3.0 GB of swap. Agents and dev servers may slow down.',
    choices: ['Pause idle Panes', 'Not now'],
    card: {
      kind: 'memory', level: 'warning', hostname: host, usedBytes: 30.9 * GB, totalBytes: 32 * GB, swapUsedBytes: 3 * GB,
      rows: [
        { label: 'claude', detail: 'glassly-port', bytes: 3.7 * GB },
        { label: 'Pane', detail: 'the app', bytes: 2.6 * GB },
        { label: 'vite', detail: 'homepage-alpine', bytes: 2.4 * GB },
        { label: 'next-server', detail: 'forms-scanner', bytes: 980 * MB },
        { label: 'fake-runpane.js', detail: 'release-2.4.223', bytes: 512 * MB },
      ],
      pauseOffer: { paneCount: 14, memoryMB: 2250, hours: 2 },
      agentPrompt: 'This Mac is short of memory.',
    },
  },
  disk: {
    title: 'Disk space is low',
    context: '13 GB free. Open Resources to see what uses the disk.',
    choices: ['Not now'],
    card: {
      kind: 'disk', level: 'warning', hostname: host, freeBytes: 13 * GB, totalBytes: 926 * GB,
      rows: [],
      agentPrompt: 'This Mac is low on disk.',
    },
  },
  leak: {
    title: 'vite in homepage-alpine keeps using more memory',
    context: 'It runs in the tab dev server. It grew 1.2 GB in 30 min and kept climbing. It now uses 2.3 GB.',
    choices: ['Restart it', 'Stop it', 'Ignore for this process'],
    card: {
      kind: 'leak', level: 'warning', hostname: host,
      rows: [{ label: 'vite', detail: 'homepage-alpine · dev server', bytes: 2.4 * GB }],
      leak: { pid: 4242, started: 'Sun Nov 15 12:00:00 2026', growthMB: 1229, windowMs: 1_800_000, series: [1180, 1390, 1600, 1810, 2050, 2240, 2400], canRestart: true },
      agentPrompt: 'vite grew 1.2 GB.',
    },
  },
  finished: {
    title: 'Archive 6 finished Panes',
    context: 'Their work is done. Archiving keeps each branch, and you can restore them.',
    choices: ['Archive 6 Panes', 'Not now'],
    card: {
      kind: 'finished', level: 'warning', hostname: host, freesBytes: 17.3 * GB,
      rows: [
        { label: 'Spanner schema diff fix', detail: 'bloom-mono', bytes: 6.2 * GB, note: 'PR #808 merged' },
        { label: 'STOP line option', detail: 'bloom-mono', bytes: 5.1 * GB, note: 'PR #1335 merged' },
        { label: 'Cloud: service and fleet API contracts', detail: 'Pane', bytes: 3.1 * GB, note: 'PR #1256 merged' },
        { label: 'release-2.4.223', detail: 'Pane', bytes: 2.9 * GB, note: 'It is pinned.', skipped: true },
        { label: 'ademark-hillclimb', detail: 'Pane', bytes: 1.1 * GB, note: 'Folder missing' },
        { label: 'onboarding-copy', detail: 'Pane', bytes: 0, note: 'Idle 21 days' },
        { label: 'glassly-port', detail: 'glassly', bytes: 0, note: 'PR #41 closed' },
      ],
      agentPrompt: 'Pane found finished Panes.',
    },
  },
  leftovers: {
    title: '2 processes were left behind',
    context: "They were started in a Pane terminal and still run after their Pane was archived or paused. Stop them, or keep them and Pane won't ask about them again.",
    choices: ['Stop them', 'Keep them'],
    card: {
      kind: 'leftovers', level: 'warning', hostname: host,
      rows: [
        { label: 'postgres', detail: 'billing-migration, archived', bytes: 210 * MB, note: 'pid 5120', command: 'postgres -D /Users/me/pg/data -p 5433' },
        { label: 'tmux', detail: 'release-2.4.223, paused', bytes: 6 * MB, note: 'pid 6031', command: 'tmux new -s qa' },
      ],
      agentPrompt: 'Processes started in Pane terminals still run.',
    },
  },
} satisfies Record<string, FixtureCard>;

const chosen: FixtureCard = kind === 'disk' ? cards.disk : kind === 'leak' ? cards.leak : kind === 'finished' ? cards.finished : kind === 'leftovers' ? cards.leftovers : cards.memory;
const item: HealthNotifyItem = {
  id: 'h1', ui: 'options', title: chosen.title, context: chosen.context,
  choices: chosen.choices.map((label, index) => ({ label, recommended: index === 0 })),
  source: { name: 'Pane', agent: 'Pane' }, state: 'waiting', createdAt: Date.now(), machineHealth: chosen.card,
};
if (remote) {
  item.machineId = 'm-build';
  item.machine = 'build-box';
}

const popup = params.get('popup');
if (popup) {
  const toItem = (id: string, fixture: FixtureCard, createdAt: number, level: 'warning' | 'critical' = 'warning'): HealthNotifyItem => ({
    id, ui: 'options', title: fixture.title, context: fixture.context, choices: fixture.choices.map(label => ({ label })),
    source: { name: 'Pane', agent: 'Pane' }, state: 'waiting', createdAt, machineHealth: { ...fixture.card, level },
  });
  const criticalDisk: FixtureCard = { ...cards.disk, title: 'Disk is almost full', context: '3.1 GB free. Open Resources to see what uses the disk.' };
  const items = popup === 'critical'
    ? [toItem('m1', cards.memory, 0), toItem('f1', cards.finished, 1), toItem('d1', criticalDisk, 2, 'critical')]
    : [toItem('d1', cards.disk, 1), toItem('f1', cards.finished, 2), toItem('m1', cards.memory, 3)];
  window.qaCommands = [];
  Object.assign(window, { electronAPI: { notify: { run: async (command: NotifyCommand) => { window.qaCommands.push(command); } } } });
  // A short hide time keeps the test quick; the app uses Notify's setting the same way.
  const snapshot = { settings: { ...DEFAULT_NOTIFY_SETTINGS, updatesHideAfterSeconds: 2 }, items, queue: items.map(item => item.id), hidden: [], strip: null, stripSurface: null, pausedUntil: null,
    shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' as const }, thisMachine: null };
  useNotifyStore.setState({ snapshot });
  const current = () => useNotifyStore.getState().snapshot ?? snapshot;
  window.qaResolve = id => useNotifyStore.setState({ snapshot: { ...current(), items: current().items.filter(item => item.id !== id), queue: current().queue.filter(other => other !== id) } });
  window.qaAdd = id => useNotifyStore.setState({ snapshot: { ...current(), items: [...current().items, toItem(id, cards.leak, Date.now())], queue: [...current().queue, id] } });
  window.qaView = () => useNavigationStore.getState().activeView;
}

createRoot(document.getElementById('root')!).render(
  popup ? (
    <div className="bg-bg-primary" style={{ minHeight: '100vh', padding: 32 }}>
      <input aria-label="Composer" className="rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-text-primary" placeholder="Typing here" />
      <HealthCardPopups suppressed={false} />
    </div>
  ) : <div className="bg-bg-primary" style={{ padding: 32, minHeight: '100vh' }}>
    <div className="rounded-2xl border border-border-primary bg-surface-primary p-6 shadow-xl" style={{ width: 720 }}>
      <HealthCardBody
        item={item}
        machineName={remote ? 'build-box' : undefined}
        onAnswer={choice => { window.qaAnswers.push(choice); }}
        onAskAgent={() => { window.qaAsked += 1; }}
        onReview={params.has('review') ? () => {} : undefined}
      />
    </div>
  </div>
);
