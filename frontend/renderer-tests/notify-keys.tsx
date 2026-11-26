import { createRoot } from 'react-dom/client';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyCommand, type NotifyItem, type NotifySnapshot } from '../../shared/types/notify';
import { ThemeProvider } from '../src/contexts/ThemeProvider';
import { NotifyCard } from '../src/components/notify/NotifyCard';
import { NotifyRound } from '../src/components/notify/NotifyRound';
import '../src/index.css';

// The strip card and Answer all (T-113): the real components, with each command they send recorded.
const commands: NotifyCommand[] = [];
const record = (command: NotifyCommand) => { commands.push(command); };
const defaultMethod = () => Promise.resolve({ success: true, data: null });
const unsubscribe = () => undefined;
const api = { appearanceSnapshot: undefined, events: new Proxy({}, { get: () => () => unsubscribe }), notify: { run: async (command: NotifyCommand) => { record(command); } } };
// SAFETY: The fixture implements the Electron methods these surfaces call; any other method
// resolves a benign empty reply.
Object.defineProperty(window, 'electronAPI', { configurable: true, value: new Proxy(api, { get: (target, key) => (key in target ? target[key as keyof typeof target] : defaultMethod) }) });
// SAFETY: tests/renderer/notify-keys.renderer.ts declares this hook's shape.
Object.assign(window, { notifyKeysTest: { commands: () => commands } });

const params = new URLSearchParams(location.search);
const item: NotifyItem = {
  id: 'q21', ui: 'options', title: 'Q-21: Which store should the session cache use?', context: 'The cache holds a few thousand keys per machine.',
  choices: [
    { label: 'Postgres table', detail: 'One more table, no new service.' },
    { label: 'Redis', detail: 'Fast, but one more thing to run.', recommended: true },
    { label: 'In memory', detail: 'Lost on restart.' },
  ],
  source: { name: 'cache-refactor', agent: 'Claude' }, state: 'waiting', createdAt: Date.now() - 120_000,
};
const snapshot: NotifySnapshot = {
  settings: DEFAULT_NOTIFY_SETTINGS, items: [item], queue: [item.id], hidden: [], strip: null, stripSurface: null, pausedUntil: null,
  shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
};

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-8">
      {params.get('surface') === 'round'
        ? <NotifyRound snapshot={snapshot} onCommand={record} />
        : <NotifyCard item={item} view="question" form="strip" showDetails={params.has('details')} onCommand={record} />}
    </div>
  </ThemeProvider>,
);
