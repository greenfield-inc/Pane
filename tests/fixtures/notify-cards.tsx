import { createRoot } from 'react-dom/client';
import { NotifyRound } from '../../frontend/src/components/notify/NotifyRound';
import { NotifyCard } from '../../frontend/src/components/notify/NotifyCard';
import { NotifyWindow } from '../../frontend/src/components/notify/NotifyWindow';
import type { NotifyCommand, NotifyItem, NotifySnapshot } from '../../shared/types/notify';
import { DEFAULT_NOTIFY_SETTINGS } from '../../shared/types/notify';
import '../../frontend/src/index.css';

// Notify's round (?surface=round), a card (?surface=card, docked in a terminal unless
// ?form=strip|inbox), or the floating strip window (?surface=strip-window, two waiting questions:
// Dismiss shows the next, as main does). One waiting question: ?ui=options (a recommended choice)
// or ?ui=approve. ?optionsOnly=1 takes only its options.
// Every command the surface sends lands in window.qaCommands.
declare global { interface Window { qaCommands: NotifyCommand[] } }
window.qaCommands = [];
document.documentElement.classList.add('light', 'folio');

const params = new URLSearchParams(location.search);
const item: NotifyItem = {
  id: 'q1',
  ui: params.get('ui') === 'approve' ? 'approve' : 'options',
  title: 'Which session store should the refactor use?',
  // On Approvals a card opens in place on Details, which a choice's note offers.
  choices: params.get('ui') === 'approve' ? undefined : [{ label: 'Postgres table', recommended: true }, { label: 'Keep Redis', detail: params.get('form') === 'inbox' ? 'No migration.' : undefined }],
  optionsOnly: params.has('optionsOnly') || undefined,
  source: { name: 'auth-refactor', agent: 'Claude', paneId: 'pane-auth', panelId: 'panel-1' },
  state: 'waiting',
  createdAt: Date.now(),
};
const second: NotifyItem = { ...item, id: 'q2', title: 'Ship the migration tonight?', ui: 'approve', choices: undefined, optionsOnly: undefined };
const snapshot: NotifySnapshot = {
  settings: DEFAULT_NOTIFY_SETTINGS, items: [item], queue: [item.id], hidden: [], strip: null, stripSurface: null, pausedUntil: null,
  shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
};
const onCommand = (command: NotifyCommand) => { window.qaCommands.push(command); };

/** The strip window's IPC: Dismiss hides the item, and the strip moves to the next one still queued. */
function installStripWindow(): void {
  let shown: NotifySnapshot = { ...snapshot, items: [item, second], queue: [item.id, second.id], strip: { itemId: item.id, kind: 'question' }, stripSurface: 'window' };
  const listeners = new Set<(next: NotifySnapshot) => void>();
  Object.assign(window, {
    electronAPI: {
      openExternal: async () => ({ success: true }),
      notify: {
        getSnapshot: async () => shown,
        onSnapshot: (callback: (next: NotifySnapshot) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
        resizeWindow: () => undefined,
        focusWindow: async () => undefined,
        run: async (command: NotifyCommand) => {
          onCommand(command);
          if (command.type !== 'dismiss') return;
          const hidden = [...shown.hidden, command.id];
          const next = shown.queue.find((id) => !hidden.includes(id));
          shown = { ...shown, hidden, strip: next ? { itemId: next, kind: 'question' } : null, stripSurface: next ? 'window' : null };
          for (const listener of listeners) listener(shown);
        },
      },
    },
  });
}

const surface = params.get('surface');
const form = params.get('form') === 'strip' ? 'strip' : params.get('form') === 'inbox' ? 'inbox' : 'docked';
if (surface === 'strip-window') installStripWindow();

createRoot(document.getElementById('root')!).render(
  surface === 'strip-window' ? <NotifyWindow view="strip" /> : (
    <div style={{ padding: 24 }}>
      {surface === 'card'
        // The strip opens with its details shown, as when the person last left them so.
        ? <NotifyCard item={item} view="question" form={form} showDetails={form === 'strip'} onCommand={onCommand} />
        : <NotifyRound snapshot={snapshot} onCommand={onCommand} />}
    </div>
  ),
);
