import { createRoot } from 'react-dom/client';
import { FileEditor } from '../../frontend/src/components/panels/editor/FileEditor';
import { usePanelStore } from '../../frontend/src/stores/panelStore';

interface Call { channel: string; args: unknown[] }
interface PanelCustomState { currentUrl?: string; filePath?: string }
interface FakePanel { id: string; sessionId: string; type: string; title: string; state: { isActive: boolean; customState: PanelCustomState }; metadata: Record<string, never> }
const calls: Call[] = [];
const log = document.getElementById('ipc-log')!;
const files = [
  { name: 'index.html', path: 'index.html', isDirectory: false },
  { name: 'app.ts', path: 'app.ts', isDirectory: false },
];
// The host's tab per file: a second open of the same file returns the same tab.
const browserTabs = new Map<string, FakePanel>();
let nextPanel = 1;
function record(channel: string, args: unknown[]) {
  calls.push({ channel, args });
  log.textContent = JSON.stringify({
    calls: calls.filter(call => call.channel !== 'file:list').map(call => call.channel),
    panels: (usePanelStore.getState().panels['test-session'] ?? []).map(panel => panel.type),
    active: usePanelStore.getState().activePanels['test-session'] ?? null,
    // The tab strip shows the layout group's active panel, not the store's.
    shown: (() => {
      const root = usePanelStore.getState().layouts['test-session']?.root;
      return root?.type === 'group' ? root.activePanelId : null;
    })(),
  });
}
function panel(type: string, title: string, customState: PanelCustomState): FakePanel {
  return { id: `panel-${nextPanel++}`, sessionId: 'test-session', type, title, state: { isActive: true, customState }, metadata: {} };
}
Object.assign(window, {
  electronAPI: {
    invoke: async (channel: string, ...args: unknown[]) => {
      try {
        if (channel === 'file:list') return { success: true, files };
        if (channel === 'panels:open-html-file') {
          // SAFETY: FileEditor sends panels:open-html-file a { sessionId, filePath } request.
          const { filePath } = args[0] as { filePath: string };
          const tab = browserTabs.get(filePath) ?? panel('browser', filePath, { currentUrl: `file:///worktree/${filePath}` });
          browserTabs.set(filePath, tab);
          return { success: true, data: tab };
        }
        if (channel === 'panels:set-layout' || channel === 'panels:update') return { success: true };
        if (channel === 'panels:get-layout') return { success: true, data: null };
        throw new Error(`Unexpected IPC: ${channel}`);
      } finally {
        queueMicrotask(() => record(channel, args));
      }
    },
    panels: {
      createPanel: async (sessionId: string, type: string, title: string, initialState?: { customState?: PanelCustomState }) => {
        queueMicrotask(() => record('panels:create', [sessionId, type, title, initialState]));
        return { success: true, data: panel(type, title, initialState?.customState ?? {}) };
      },
      setActivePanel: async (...args: unknown[]) => {
        queueMicrotask(() => record('panels:set-active', args));
        return { success: true };
      },
      getSessionPanels: async () => ({ success: true, data: usePanelStore.getState().panels['test-session'] ?? [] }),
    },
  },
});

// A terminal tab is showing, as in a real Pane, so a preview must bring its tab forward.
const terminal = panel('terminal', 'Terminal', {});
usePanelStore.getState().addPanel(terminal);
usePanelStore.getState().setActivePanel('test-session', terminal.id);
usePanelStore.getState().setLayout('test-session', {
  version: 1,
  root: { type: 'group', id: 'group-1', panelIds: [terminal.id], activePanelId: terminal.id },
  focusedGroupId: 'group-1',
});

createRoot(document.getElementById('root')!).render(<FileEditor sessionId="test-session" />);

// The test switches back to the terminal tab, as a person clicking it would.
window.addEventListener('show-terminal', () => {
  const store = usePanelStore.getState();
  store.setActivePanel('test-session', terminal.id);
  const layout = store.layouts['test-session'];
  if (layout?.root.type === 'group') store.setLayout('test-session', { ...layout, root: { ...layout.root, activePanelId: terminal.id } });
  record('show-terminal', []);
});
