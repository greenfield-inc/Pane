import { createRoot } from 'react-dom/client';
import { NotifyRound } from '../../frontend/src/components/notify/NotifyRound';
import { NotifyCard } from '../../frontend/src/components/notify/NotifyCard';
import type { NotifyCommand, NotifyItem, NotifySnapshot } from '../../shared/types/notify';
import { DEFAULT_NOTIFY_SETTINGS } from '../../shared/types/notify';
import '../../frontend/src/index.css';

// Notify's round (?surface=round) or a card docked in a terminal (?surface=card), on one waiting
// question: ?ui=options (a recommended choice) or ?ui=approve. ?optionsOnly=1 takes only its options.
// Every command the surface sends lands in window.qaCommands.
declare global { interface Window { qaCommands: NotifyCommand[] } }
window.qaCommands = [];
document.documentElement.classList.add('light', 'folio');

const params = new URLSearchParams(location.search);
const item: NotifyItem = {
  id: 'q1',
  ui: params.get('ui') === 'approve' ? 'approve' : 'options',
  title: 'Which session store should the refactor use?',
  choices: params.get('ui') === 'approve' ? undefined : [{ label: 'Postgres table', recommended: true }, { label: 'Keep Redis' }],
  optionsOnly: params.has('optionsOnly') || undefined,
  source: { name: 'auth-refactor', agent: 'Claude', paneId: 'pane-auth', panelId: 'panel-1' },
  state: 'waiting',
  createdAt: Date.now(),
};
const snapshot: NotifySnapshot = {
  settings: DEFAULT_NOTIFY_SETTINGS, items: [item], queue: [item.id], hidden: [], strip: null, stripSurface: null, pausedUntil: null,
  shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
};
const onCommand = (command: NotifyCommand) => { window.qaCommands.push(command); };

createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 24 }}>
    {params.get('surface') === 'card'
      ? <NotifyCard item={item} view="question" form="docked" onCommand={onCommand} />
      : <NotifyRound snapshot={snapshot} onCommand={onCommand} />}
  </div>,
);
