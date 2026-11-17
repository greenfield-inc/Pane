import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyCommand, type NotifyItem, type NotifySnapshot } from '../../shared/types/notify';
import { DEFAULT_APPEARANCE } from '../../shared/types/appearance';
import { createDefaultRemoteDaemonConfig } from '../../shared/types/remoteDaemon';
import { ThemeProvider } from '../src/contexts/ThemeProvider';
import { ApprovalColumn } from '../src/components/approvals/ApprovalColumn';
import { ApprovalsView } from '../src/components/approvals/ApprovalsView';
import { useApprovalHotkeys } from '../src/hooks/useApprovalHotkeys';
import { useConfigStore } from '../src/stores/configStore';
import { useNotifyStore } from '../src/stores/notifyStore';
import { useNavigationStore } from '../src/stores/navigationStore';
import { useHotkeyStore } from '../src/stores/hotkeyStore';
import type { AppConfig } from '../src/types/config';
import '../src/index.css';

// Approvals keys (D-381): the real column, Approvals screen and catalog commands. Only the
// Electron transport is faked; it records each command Send makes.
const commands: NotifyCommand[] = [];
const defaultMethod = () => Promise.resolve({ success: true, data: null });
const unsubscribe = () => undefined;
const api = {
  // No snapshot: the theme follows the system (the test's colour scheme).
  appearanceSnapshot: undefined,
  events: new Proxy({}, { get: () => () => unsubscribe }),
  notify: { run: async (command: NotifyCommand) => { commands.push(command); } },
};
// SAFETY: The fixture implements the Electron methods these surfaces call; any other method
// resolves a benign empty reply.
Object.defineProperty(window, 'electronAPI', { configurable: true, value: new Proxy(api, { get: (target, key) => (key in target ? target[key as keyof typeof target] : defaultMethod) }) });

const source = { name: 'plan-keyboard-approvals', agent: 'Claude' };
const twoQuestions: NotifyItem = {
  id: 'q12', ui: 'options', title: 'Q-12: Which key opens the keyboard shortcut sheet?', context: '⌘/ follows VS Code-style apps.',
  questions: [
    { title: 'Which key opens the sheet?', choices: [{ label: '⌘/ everywhere', recommended: true }, { label: '? outside text fields only' }, { label: 'Both' }] },
    { title: 'Show keys you have changed with a marker?', choices: [{ label: 'Yes, a small dot', recommended: true }, { label: 'No marker' }] },
  ],
  source, state: 'waiting', createdAt: Date.now() - 180_000,
};
const oneQuestion: NotifyItem = {
  id: 'q11', ui: 'options', title: 'Q-11: Merge #1352 now that CI is green?',
  choices: [{ label: 'Merge it', recommended: true }, { label: 'Wait for QA' }],
  source, state: 'waiting', createdAt: Date.now() - 660_000,
};
const third: NotifyItem = { ...oneQuestion, id: 'q13', title: 'Q-13: Run the invoice migration on staging?', createdAt: Date.now() - 2_520_000 };
const answered: NotifyItem = { ...oneQuestion, id: 'q9', title: 'Q-9: Ship the relay guide?', state: 'answered', answerSummary: 'Ship it', resolvedAt: Date.now() - 60_000 };
const items = [twoQuestions, oneQuestion, third, answered];

const snapshot: NotifySnapshot = {
  settings: DEFAULT_NOTIFY_SETTINGS, items, queue: items.map((item) => item.id), hidden: [], strip: null, stripSurface: null, pausedUntil: null,
  shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
};
useNotifyStore.setState({ snapshot });
// SAFETY: a fixture config with the fields these surfaces read; the tab keys are the person's ⌥⌘[ ⌥⌘].
useConfigStore.setState({ config: {
  appearance: DEFAULT_APPEARANCE, theme: DEFAULT_APPEARANCE.theme, remoteDaemon: createDefaultRemoteDaemonConfig(),
  analytics: { enabled: false }, customCommands: [], defaultOrchestratorAgent: 'claude',
  keyboardShortcutOverrides: { 'cycle-tab-next-d': 'mod+alt+]', 'cycle-tab-prev-a': 'mod+alt+[' },
} as AppConfig });

// SAFETY: tests/renderer/approval-keys.renderer.ts declares this hook's shape.
Object.assign(window, { approvalKeysTest: {
  commands: () => commands,
  // A palette command, as the palette runs it.
  run: (id: string) => useHotkeyStore.getState().hotkeys.get(id)?.action(),
  view: () => useNavigationStore.getState().activeView,
} });

function Hotkeys() {
  useApprovalHotkeys();
  return null;
}

function Column() {
  const order = ['q12', 'q11'];
  const [itemId, setItemId] = useState('q12');
  return (
    <div className="flex h-screen">
      {/* A chat composer beside the approval: ⌘↩ and typing there belong to it. */}
      <div className="flex w-[420px] flex-col justify-end p-4">
        <textarea aria-label="Chat composer" className="h-20 rounded border border-border-primary bg-surface-primary p-2 text-text-primary" />
      </div>
      <div className="flex min-w-0 flex-1 border-l border-border-primary" data-focus-region="approvals">
        <ApprovalColumn surface="approvals" itemId={itemId} order={order} onSelect={setItemId} groupLabel="Pane UI/UX improvements approvals" items={items} />
      </div>
    </div>
  );
}

const surface = new URLSearchParams(location.search).get('surface');
if (surface === 'screen') useNavigationStore.setState({ activeView: 'notify' });
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <Hotkeys />
    {surface === 'screen' ? <div className="flex h-screen"><ApprovalsView paneView={null} /></div> : <Column />}
  </ThemeProvider>,
);
