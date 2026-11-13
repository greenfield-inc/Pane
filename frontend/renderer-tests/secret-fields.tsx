import { createRoot } from 'react-dom/client';
import { NotifyCard } from '../src/components/notify/NotifyCard';
import { NotifyRound } from '../src/components/notify/NotifyRound';
import { SecretsSettings } from '../src/components/settings/categories/SecretsSettings';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyCommand, type NotifyItem, type NotifySnapshot } from '../../shared/types/notify';
import '../src/index.css';

// The three places a person types a secret, each recording what it would save.
const saved: string[] = [];
const record = (command: NotifyCommand) => {
  if (command.type === 'answer' && 'text' in command.answer && command.answer.text !== undefined) saved.push(command.answer.text);
};
Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
  paneSecrets: {
    list: async () => ({ success: true, data: { secrets: [], storage: { kind: 'keychain', encrypted: true } } }),
    set: async (_project: string, _name: string, value: string) => { saved.push(value); return { success: true, data: false }; },
  },
} });

const item: NotifyItem = {
  id: 'q-secret',
  ui: 'secret',
  title: 'GitHub App private key',
  secret: { project: 'github', name: 'APP_PRIVATE_KEY' },
  source: { paneId: 'pane-1', panelId: 'panel-1', name: 'auth-refactor', agent: 'Claude' },
  state: 'waiting',
  createdAt: Date.now(),
};
const snapshot: NotifySnapshot = {
  settings: DEFAULT_NOTIFY_SETTINGS, items: [item], queue: [item.id], hidden: [], strip: null, stripSurface: null,
  pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
};

declare global {
  interface Window { secretFieldsTest: { saved: () => string[] } }
}
window.secretFieldsTest = { saved: () => saved };

const surface = new URLSearchParams(location.search).get('surface');
const root = createRoot(document.getElementById('root')!);
if (surface === 'card') root.render(<div className="w-[560px] p-4"><NotifyCard item={item} view="question" form="inbox" onCommand={record} /></div>);
if (surface === 'round') root.render(<div className="p-4"><NotifyRound snapshot={snapshot} onCommand={record} /></div>);
if (surface === 'settings') root.render(<div className="w-[720px] p-4"><SecretsSettings /></div>);
